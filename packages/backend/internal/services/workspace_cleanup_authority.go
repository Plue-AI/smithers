package services

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WorkspaceCleanupFence is the authenticated capture/writer and session broker
// boundary. It must exclude all admission and writers across fn, verify every
// retained object and the current branch ref, and supply current quiet inventory.
// If services remain, it confirms broker termination and captures their final
// writes before calling fn. A database head or disconnected inventory is not a
// substitute. Missing providers never call fn.
type WorkspaceCleanupFence = workspaceapi.CleanupFence

type transactionalWorkspaceCleanup struct {
	transactions RepositoryJobTransactions
	fence        WorkspaceCleanupFence
	now          func() time.Time
}

// WithTransactionalWorkspaceCleanup binds the existing cleaner to the durable
// workspace decision. Install composition discovers the fence on its runtime;
// without the capture/broker contract this authority retains every disk.
func WithTransactionalWorkspaceCleanup(clock func() time.Time) WorkspaceServiceOption {
	return func(s *WorkspaceService) {
		if clock == nil {
			clock = time.Now
		}
		fence, _ := s.runtime.(WorkspaceCleanupFence)
		s.diskReclaimAuthority = &transactionalWorkspaceCleanup{s.transactions, fence, clock}
	}
}

func (a *transactionalWorkspaceCleanup) Candidates(ctx context.Context) ([]string, error) {
	if a.transactions == nil || a.fence == nil {
		return nil, nil
	}
	tx, err := a.transactions.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	// Candidates are deliberately broad hints. Eligibility, settlement time and
	// outstanding GitHub effects are re-read under row locks at the decision.
	rows, err := tx.Query(ctx, `SELECT w.id::text FROM workspaces w
 WHERE w.deleted_at IS NULL AND w.disk_reclaimed_at IS NULL
 AND w.status IN ('suspended','stopped','running')
 AND (w.branch_archived_at IS NOT NULL OR EXISTS
 (SELECT 1 FROM mythical_lanes l WHERE l.workspace_id=w.id::text)) ORDER BY w.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// cleanupSettlement consumes the stack's existing product projection and its
// durable event timestamps. updated_at, idle time and capture time are never
// used. Unknown historical settlement dates retain the disk.
func cleanupSettlement(item db.MythicalItem) time.Time {
	if len(item.PendingOp) != 0 && string(item.PendingOp) != "null" {
		return time.Time{}
	}
	checks := mythicalChecksOf(item)
	switch todoState(item) {
	case "merged":
		if checks.Completion != nil {
			switch checks.Completion.Outcome {
			case "", mythicalCompletionClosed, "commented":
				return checks.Completion.Since
			}
		}
	case "dropped":
		if checks.Dropped != nil && (!item.PRNumber.Valid || item.PRState == "closed") {
			return checks.Dropped.At
		}
	}
	return time.Time{}
}

func cleanupCaptureMatches(row db.Workspace, capture WorkspaceDiskReclaimCapture, settled, now time.Time) bool {
	return !settled.IsZero() && !settled.After(now) && now.Sub(settled) >= 24*time.Hour &&
		!row.DeletedAt.Valid && !row.DiskReclaimedAt.Valid && (row.Status == "suspended" || row.Status == "stopped") &&
		capture.Settled && capture.Quiet && capture.BindingVerified && capture.CaptureComplete && capture.InventoryCurrent && capture.WorkspaceID == row.ID && capture.CaptureID != "" &&
		capture.CandidateHead != "" && capture.CandidateHead == row.HeadCommitID && capture.RetainedHead == capture.CandidateHead
}

// lockFacts locks the stack item before the workspace, matching settlement and
// reopen ordering. Even a retired lane remains the authoritative item binding.
func (a *transactionalWorkspaceCleanup) lockFacts(ctx context.Context, tx pgx.Tx, expected db.Workspace) (db.Workspace, time.Time, error) {
	q := db.New(tx)
	lane, err := q.GetMythicalLane(ctx, expected.ID)
	var settled time.Time
	if err == nil {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM mythical_items WHERE id=$1 FOR UPDATE`, lane.ItemID).Scan(&locked); err != nil {
			return db.Workspace{}, settled, err
		}
		var bound string
		if err := tx.QueryRow(ctx, `SELECT item_id::text FROM mythical_lanes WHERE workspace_id=$1 AND repository_id=$2 FOR SHARE`, expected.ID, expected.RepositoryID).Scan(&bound); err != nil {
			return db.Workspace{}, settled, err
		}
		if bound != uuidString(lane.ItemID) {
			return db.Workspace{}, settled, pgx.ErrNoRows
		}
		item, err := q.GetMythicalItem(ctx, lane.ItemID)
		if err != nil {
			return db.Workspace{}, settled, err
		}
		if item.RepositoryID == expected.RepositoryID && lane.RepositoryID == expected.RepositoryID && branchKind(expected.TargetBookmark) == "item" {
			settled = cleanupSettlement(item)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.Workspace{}, settled, err
	}
	var locked string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM workspaces WHERE id=$1 FOR UPDATE`, expected.ID).Scan(&locked); err != nil {
		return db.Workspace{}, settled, err
	}
	row, err := q.GetWorkspace(ctx, expected.ID)
	if err != nil {
		return row, settled, err
	}
	if lane.WorkspaceID == "" && branchKind(row.TargetBookmark) == "scratch" && row.BranchArchivedAt.Valid {
		settled = row.BranchArchivedAt.Time
	}
	if row.VmID != expected.VmID || row.RepositoryID != expected.RepositoryID || row.UserID != expected.UserID || row.TargetBookmark != expected.TargetBookmark {
		settled = time.Time{}
	}
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return row, settled, err
	}
	if row.UserID != owner {
		settled = time.Time{}
	}
	return row, settled, nil
}

func (a *transactionalWorkspaceCleanup) WithFinalCapture(ctx context.Context, expected db.Workspace, remove func(WorkspaceDiskReclaimCapture) error) error {
	if a.transactions == nil || a.fence == nil {
		return nil
	}
	// Read the authoritative settlement before asking a provider to stop any
	// services. Capture time and inactivity never authorize early shutdown.
	preflight, err := a.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	preliminary, settled, err := a.lockFacts(ctx, preflight, expected)
	_ = preflight.Rollback(context.WithoutCancel(ctx))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	now := a.now()
	if settled.IsZero() || settled.After(now) || now.Sub(settled) < 24*time.Hour || preliminary.DiskReclaimedAt.Valid {
		return nil
	}
	binding := workspaceapi.CleanupWorkspace{ID: expected.ID, VMID: expected.VmID, Branch: expected.TargetBookmark, Head: expected.HeadCommitID, RepositoryID: expected.RepositoryID, OwnerID: expected.UserID, SettledAt: settled, Now: now, PendingHead: preliminary.CleanupPendingHead, PendingCaptureID: preliminary.CleanupPendingCaptureID}
	return a.fence.WithFinalCapture(ctx, binding, func(capture WorkspaceDiskReclaimCapture) error {
		tx, err := a.transactions.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
		row, settled, err := a.lockFacts(ctx, tx, expected)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if !cleanupCaptureMatches(row, capture, settled, a.now()) {
			return nil
		}
		// Commit the archive decision BEFORE removal. A crash leaves a durable
		// pending head; the next normal cleaner tick revalidates all four facts.
		_, err = tx.Exec(ctx, `UPDATE workspaces SET branch_archived_at=COALESCE(branch_archived_at,$2),cleanup_pending_head=$3,updated_at=$4,cleanup_pending_capture_id=$5 WHERE id=$1`, row.ID, settled, capture.CandidateHead, a.now(), capture.CaptureID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		removal, err := a.transactions.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = removal.Rollback(context.WithoutCancel(ctx)) }()
		current, settled, err := a.lockFacts(ctx, removal, expected)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		// Reopen can win between transactions. It is held off by the item lock
		// only during actual removal; no committed decision overrides new facts.
		if !cleanupCaptureMatches(current, capture, settled, a.now()) || current.CleanupPendingHead != capture.CandidateHead || current.CleanupPendingCaptureID != capture.CaptureID {
			return nil
		}
		if err := remove(capture); err != nil {
			return err
		}
		_, err = removal.Exec(ctx, `UPDATE workspaces SET cleanup_pending_head='',cleanup_pending_capture_id='',disk_reclaimed_at=$2,updated_at=$2 WHERE id=$1`, current.ID, a.now())
		if err != nil {
			return err
		}
		return removal.Commit(ctx)
	})
}
