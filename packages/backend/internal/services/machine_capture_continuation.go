package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Captured edits skip planning but never checks or review. A stale capture
// still needs daemon reconciliation; a changed prefix needs rebase first.
// Neither condition licenses a new coding attempt or a host rewrite of an
// awake branch. The retained capture stays available until that boundary runs.
func (st *mythicalItemStep) consumeCapturedEdits(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	checks := mythicalChecksOf(item)
	capture := checks.Capture
	if capture == nil || capture.Stale || capture.Conflict || capture.ReconciledOnto != "" || todoReopenedAttempt(item) || item.PausedAt.Valid || len(item.PendingOp) > 0 || checks.ForeignHead != "" {
		return nil, false, nil
	}
	if _, pinned := mythicalPinOf(item); !pinned {
		return nil, false, nil
	}
	if checks.Rebase != nil && !checks.Rebase.Rebased {
		return nil, false, nil
	}
	if item.State == "verifying" && item.VerifyOutcome == "" {
		return nil, false, nil
	}
	if review := checks.Review; review != nil && review.Verdict == "" {
		return nil, false, nil
	}
	// Text has priority. Delivery is not consumption; until its ordered
	// boundary proves consumption, a retained current-attempt input holds this
	// edited-only continuation.
	for _, input := range checks.Steers {
		if input.Attempt == item.Attempt {
			return nil, false, nil
		}
	}
	if len(todoOpenWaits(item)) > 0 {
		return nil, false, nil
	}
	if st.s == nil || st.r == nil || item.WorkspaceID == "" || item.CandidateBase == "" {
		return nil, false, nil
	}
	if item.CandidateBase != st.prefix(item) {
		return nil, false, nil
	}
	var plan struct {
		Checks []json.RawMessage `json:"checks"`
	}
	if len(item.Plan) == 0 || json.Unmarshal(item.Plan, &plan) != nil {
		return nil, false, errors.New("captured edits need the retained check plan")
	}
	for _, id := range []string{capture.Head, capture.Tree, capture.Base, capture.Onto} {
		if !codingCommitID.MatchString(id) {
			return nil, false, errors.New("invalid pending capture")
		}
	}
	if capture.Head != capture.Onto {
		return nil, false, errors.New("pending capture is not the published head")
	}
	if parsed, err := uuid.Parse(item.WorkspaceID); err != nil || parsed.String() != item.WorkspaceID {
		return nil, false, errors.New("invalid captured branch")
	}
	if capture.SourceRef != "" && capture.SourceRef != repohost.WorkspaceSourceRef(item.WorkspaceID, capture.Head) {
		return nil, false, errors.New("invalid retained capture ref")
	}
	if !st.r.g.has(ctx, capture.Head) {
		ref := "refs/smithers/branches/" + item.WorkspaceID + "/captures/" + capture.Head
		if capture.SourceRef != "" {
			ref = capture.SourceRef
		}
		if err := st.r.g.fetch(ctx, st.r.bridge.URL(), 0, 0, ref); err != nil {
			return nil, false, fmt.Errorf("read retained capture: %w", err)
		}
	}
	commit, err := st.r.g.readCommit(ctx, capture.Head)
	if err != nil {
		return nil, false, err
	}
	if commit.Tree != capture.Tree {
		return nil, false, errors.New("captured tree differs from its retained commit")
	}
	containsBase, err := st.r.g.isAncestor(ctx, item.CandidateBase, capture.Head)
	if err != nil {
		return nil, false, err
	}
	if !containsBase {
		return nil, false, errors.New("captured edits need reconciliation with their candidate base")
	}

	next := retainTodoAttemptEvidence(item)
	next.CandidateHead = capture.Head
	if paths, err := st.protectedChanges(ctx, next); err != nil {
		return nil, false, err
	} else if len(paths) > 0 {
		return nil, false, errors.New("captured edits change protected paths")
	}
	return st.verifyCandidate(ctx, item, next, item.CandidateBase, capture.Head, capture)
}

// Take the stack -> items -> workspace locks before the launch writes any
// rows. An intervening capture, pause, prefix or claim change consumes nothing.
func (st *mythicalItemStep) lockCapturedContinuation(ctx context.Context, tx pgx.Tx, item db.MythicalItem, capture MachineCapturePending) error {
	var live bool
	var main string
	if err := tx.QueryRow(ctx, `SELECT state='active' AND running AND claim=$2 AND lease_expires_at>clock_timestamp(),landed_main FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID, st.r.row.Claim).Scan(&live, &main); err != nil {
		return err
	}
	if !live {
		return db.ErrMythicalLeaseLost
	}
	if main != st.r.row.LandedMain {
		return errors.New("main moved before captured edits were consumed")
	}
	q := db.New(tx)
	order, err := q.LockMythicalStackOrder(ctx, item.RepositoryID)
	if err != nil {
		return err
	}
	current, err := q.GetMythicalItem(ctx, item.ID)
	if err != nil {
		return err
	}
	if current.Version != item.Version || current.State != item.State || current.Attempt != item.Attempt || current.Generation != item.Generation || current.WorkspaceID != item.WorkspaceID || current.CandidateHead != item.CandidateHead || current.CandidateBase != item.CandidateBase || current.FlowDigest != item.FlowDigest || mythicalChecksOf(current).FlowSource != mythicalChecksOf(item).FlowSource || current.PausedAt.Valid || len(current.PendingOp) > 0 {
		return errors.New("TODO changed before captured edits were consumed")
	}
	fresh := *st
	fresh.items = order
	if current.CandidateBase != fresh.prefix(current) {
		return errors.New("prefix moved before captured edits were consumed")
	}
	var head string
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT head_commit_id,capture_pending FROM workspaces WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR UPDATE`, item.WorkspaceID, item.RepositoryID).Scan(&head, &raw); err != nil {
		return err
	}
	var pending MachineCapturePending
	if json.Unmarshal(raw, &pending) != nil || pending != capture || head != capture.Head {
		return errors.New("capture changed before its continuation")
	}
	if stored := mythicalChecksOf(current).Capture; stored == nil || *stored != capture {
		return errors.New("capture is no longer pending on this TODO")
	}
	return nil
}
