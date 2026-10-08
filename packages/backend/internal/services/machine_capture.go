package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// MachineCapturePending is retained work, not a replacement verified candidate.
// Onto names the actual host branch head under repository maintenance exclusion.
type MachineCapturePending struct {
	// Reserved native capture retains the same immutable object in the existing
	// workspace source namespace. This is transport metadata, not acceptance.
	SourceRef string `json:"source_ref,omitempty"`
	Head      string `json:"head"`
	Tree      string `json:"tree"`
	Base      string `json:"base"`
	Onto      string `json:"onto"`
	Stale     bool   `json:"stale"`
	// A wake result does not name a snapshot. Only a later capture based on
	// this target can discharge the stale capture after a clean reconciliation.
	ReconciledOnto  string `json:"reconciled_onto,omitempty"`
	Conflict        bool   `json:"conflict,omitempty"`
	ReconcileWaitID string `json:"reconcile_wait_id,omitempty"`
}

// MachineCaptureObjects reads only immutable host objects and the fenced head.
// It must not execute a guest command or acquire another database connection.
type MachineCaptureObjects interface {
	CommitTree(context.Context, string, string) (string, error)
	BranchHead(context.Context, string) (string, error)
}

type MachineCaptureProjection struct {
	tx        pgx.Tx
	workspace db.Workspace
	items     []db.MythicalItem
}

// PrepareMachineCaptureTx takes the same stack -> items -> workspace locks as
// publication before any native ref can move. Call only from authenticated
// machine ingestion; a payload never grants permission to select a branch.
func PrepareMachineCaptureTx(ctx context.Context, tx pgx.Tx, branch string) (*MachineCaptureProjection, error) {
	if tx == nil {
		return nil, errors.New("capture transaction unavailable")
	}
	id, err := uuid.Parse(branch)
	if err != nil || id.String() != branch {
		return nil, errors.New("invalid capture branch")
	}
	q := db.New(tx)
	before, err := q.GetWorkspace(ctx, branch)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, before.RepositoryID); err != nil {
		return nil, err
	}
	items, err := q.LockMythicalStackOrder(ctx, before.RepositoryID)
	if err != nil {
		return nil, err
	}
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE`, branch).Scan(&repository); err != nil {
		return nil, err
	}
	if repository != before.RepositoryID {
		return nil, errors.New("capture branch changed repository")
	}
	current, err := q.GetWorkspace(ctx, branch)
	if err != nil {
		return nil, err
	}
	return &MachineCaptureProjection{tx: tx, workspace: current, items: items}, nil
}

// ValidatePublication runs only for a new receipt, after the ordered locks and
// duplicate check, but before any native publication. Replaying an acknowledged
// capture must remain possible while a later merge holds its durable fence.
func (p *MachineCaptureProjection) ValidatePublication() error {
	if p == nil || p.tx == nil {
		return errors.New("capture projection unavailable")
	}
	for _, item := range p.items {
		if item.WorkspaceID == p.workspace.ID && mythicalTodo(item) && mythicalMergeFenced(item) {
			return errors.New("capture blocked by merge in flight")
		}
	}
	return nil
}

// InitialCaptureBase permits the first daemon snapshot to create only its
// own branch ref, from the head already admitted by host publication. The
// projection retains all ordered locks throughout the ref's zero-head CAS.
func (p *MachineCaptureProjection) InitialCaptureBase() string {
	if p == nil || p.tx == nil {
		return ""
	}
	if codingCommitID.MatchString(p.workspace.HeadCommitID) {
		return p.workspace.HeadCommitID
	}
	for _, item := range p.items {
		if item.WorkspaceID == p.workspace.ID && codingCommitID.MatchString(item.CandidateHead) && !mythicalMergeFenced(item) {
			return item.CandidateHead
		}
	}
	return ""
}

// Apply runs after object verification/publication but in the same transaction
// as the receipt. It preserves candidate/run/pin history and only withdraws
// verification; a later equal capture never re-enables an invalidated candidate.
func (p *MachineCaptureProjection) Apply(ctx context.Context, capture wire.Captured, applied bool, objects MachineCaptureObjects) error {
	if p == nil || p.tx == nil || objects == nil {
		return errors.New("capture projection unavailable")
	}
	for _, oid := range []string{capture.Head, capture.Tree, capture.Base} {
		if !codingCommitID.MatchString(oid) {
			return errors.New("invalid capture identity")
		}
	}
	head, err := objects.BranchHead(ctx, p.workspace.ID)
	if err != nil {
		return err
	}
	if !codingCommitID.MatchString(head) || (applied && head != capture.Head) || (!applied && (head == capture.Head || head == capture.Base)) {
		return errors.New("capture publication changed")
	}
	pending := MachineCapturePending{Head: capture.Head, Tree: capture.Tree, Base: capture.Base, Onto: head, Stale: !applied}
	q := db.New(p.tx)
	wake, needed := false, !applied
	var retained *MachineCapturePending
	if len(p.workspace.CapturePending) > 0 {
		retained = new(MachineCapturePending)
		if err = json.Unmarshal(p.workspace.CapturePending, retained); err != nil {
			return err
		}
		needed = true
	}
	// A newly stale snapshot supersedes capture bytes, not the open conflict
	// or the wait it owns. A later matching recovery must still settle that wait.
	if !applied && retained != nil {
		pending.Conflict = retained.Conflict
		pending.ReconcileWaitID = retained.ReconcileWaitID
	}
	// An ordinary later capture is not proof that a stale capture was rebased.
	// Retain that recovery obligation until an explicit reconciliation consumes it.
	resolved := applied && retained != nil && retained.Stale && !retained.Conflict && retained.ReconciledOnto == capture.Base
	if applied && retained != nil && retained.Stale && !resolved {
		pending = *retained
		pending.Onto = head
	}
	for _, item := range p.items {
		if item.WorkspaceID != p.workspace.ID || !mythicalTodo(item) {
			continue
		}
		checks := mythicalChecksOf(item)
		// Drop retains this snapshot for reopening, independently of the last
		// accepted generation. It cannot revoke that generation's evidence.
		if checks.DropRequested != nil {
			needed = true
			continue
		}
		if resolved && retained.ReconcileWaitID != "" {
			var now time.Time
			if err := p.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
				return err
			}
			for i := range checks.Waits {
				if checks.Waits[i].ID == retained.ReconcileWaitID && checks.Waits[i].Kind == "conflict" && checks.Waits[i].SettledAt == nil {
					checks.Waits[i].SettledAt = &now
				}
			}
		}
		mismatch := pending.Stale || checks.Capture != nil
		edited := false
		if item.CandidateHead != "" {
			tree, err := objects.CommitTree(ctx, p.workspace.ID, item.CandidateHead)
			if err != nil {
				return err
			}
			if !codingCommitID.MatchString(tree) {
				return errors.New("candidate tree unavailable")
			}
			edited = tree != capture.Tree
			mismatch = mismatch || edited
		}
		if !mismatch {
			continue
		}
		needed = true
		// Keep the newest retained head, but wake the stack only when its
		// pending work changes. A distinct event for the same tree is not a
		// second edit. Returning to the candidate's tree retains the newest
		// bytes without signaling edited or restoring verification. Active
		// work observes its retained capture at its existing durable boundary.
		previous := checks.Capture
		newWork := previous == nil || previous.Tree != pending.Tree || previous.Stale != pending.Stale || previous.Conflict != pending.Conflict || previous.ReconciledOnto != pending.ReconciledOnto || previous.ReconcileWaitID != pending.ReconcileWaitID || ((pending.Stale || previous.Stale) && previous.Onto != pending.Onto)
		if newWork && ((edited && item.State == "proposed") || pending.Stale || resolved) {
			wake = true
		}
		checks.Capture = &pending
		checks.Land = nil
		item.CandidateVerified = false
		item.Checks = checks.encode()
		if _, err = q.SaveMythicalItem(ctx, item); err != nil {
			return err
		}
	}
	var raw []byte
	if needed {
		raw, err = json.Marshal(pending)
		if err != nil {
			return err
		}
	}
	if _, err = p.tx.Exec(ctx, `UPDATE workspaces SET capture_pending=$2,updated_at=NOW() WHERE id=$1`, p.workspace.ID, raw); err != nil {
		return err
	}
	if wake {
		rows, err := q.RequestMythicalStack(ctx, p.workspace.RepositoryID)
		if err != nil {
			return err
		}
		if rows != 1 {
			return errors.New("capture stack unavailable")
		}
	}
	return nil
}
