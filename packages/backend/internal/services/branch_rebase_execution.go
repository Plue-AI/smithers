package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// BranchRebaseExecutor uses the authenticated daemon's existing mutation lock,
// freeze and object transport. The stack worker alone admits and publishes it.
type BranchRebaseExecutor interface {
	Rebase(context.Context, string, int64, string, func(pgx.Tx) error, func(func() error) error) (machined.RewriteResult, error)
	Capture(context.Context, string) (machined.CaptureResult, error)
}

func (s *MythicalService) SetBranchRebaseExecutor(executor BranchRebaseExecutor) {
	s.branchRebase = executor
}

func (st *mythicalItemStep) lockNativeRebase(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string) error {
	return st.lockNativeRebaseState(ctx, tx, item, onto, true)
}

// Execution requires an awake machine. After its immutable capture is
// acknowledged, verification may retire a review lane before admission.
func (st *mythicalItemStep) lockNativeRebaseReceipt(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string) error {
	return st.lockNativeRebaseState(ctx, tx, item, onto, false)
}

func (st *mythicalItemStep) lockNativeRebaseState(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string, executing bool) error {
	// Presence resolves the existing host through its own authority transaction
	// and SHARE lock on this workspace. Read that live boundary before taking
	// mutation locks here; otherwise the fence waits on its own presence read.
	// The locks below still reject any changed item, prefix or machine before
	// the native mutation starts.
	if !st.s.mayExecuteRequestedRebase(ctx, item, onto) && !st.s.mayRebaseItemAtBoundary(ctx, item) {
		return fmt.Errorf("rebase authority changed: %w", db.ErrMythicalItemMoved)
	}
	var live bool
	if err := tx.QueryRow(ctx, `SELECT state='active' AND running AND claim=$2 AND lease_expires_at>clock_timestamp() FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID, st.r.row.Claim).Scan(&live); err != nil {
		return err
	}
	if !live {
		return db.ErrMythicalLeaseLost
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
	main, err := st.s.MainHead(ctx, st.r.owner, st.r.repo, "main")
	if err != nil {
		return err
	}
	if main != st.r.mainTip {
		return fmt.Errorf("main moved before rebase: %w", db.ErrMythicalItemMoved)
	}
	step := *st
	step.items = order
	if current.Version != item.Version || current.WorkspaceID != item.WorkspaceID || current.PausedAt.Valid || mythicalMergeFenced(current) || len(current.PendingOp) != 0 || step.prefix(current) != onto {
		return fmt.Errorf("rebase binding changed: %w", db.ErrMythicalItemMoved)
	}
	var status, head string
	if err := tx.QueryRow(ctx, `SELECT status,head_commit_id FROM workspaces WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR NO KEY UPDATE`, item.WorkspaceID, item.RepositoryID).Scan(&status, &head); err != nil {
		return err
	}
	if executing {
		if status != "running" {
			return fmt.Errorf("rebase machine state changed: %w", db.ErrMythicalItemMoved)
		}
	} else {
		pending := mythicalChecksOf(current).Rebase
		if pending == nil || pending.Native == nil || !pending.Native.Inspected || len(pending.Native.Paths) != 0 || pending.Native.Head != head || (status != "running" && status != "stopped" && status != "suspended") {
			return machined.ErrNotReady
		}
	}
	return nil
}

func (st *mythicalItemStep) executeNativeRebase(ctx context.Context, item db.MythicalItem, onto string) (*db.MythicalItem, bool, error) {
	if st.s.branchRebase == nil {
		return nil, false, nil
	}
	member := st.r.row.ActorUserID.Int64
	if request := mythicalChecksOf(item).Rebase; request != nil && request.Request != nil && st.s.mayExecuteRequestedRebase(ctx, item, onto) {
		member = request.Request.User
	}
	var tx pgx.Tx
	defer func() {
		if tx != nil {
			_ = tx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	result, err := st.s.branchRebase.Rebase(ctx, item.WorkspaceID, member, onto, func(tx pgx.Tx) error { return st.lockNativeRebase(ctx, tx, item, onto) }, func(rewrite func() error) error {
		var err error
		tx, err = st.s.store.Begin(ctx)
		if err != nil {
			return err
		}
		if err := st.lockNativeRebase(ctx, tx, item, onto); err != nil {
			return err
		}
		return rewrite()
	})
	if err != nil {
		// A fresh fence refused this snapshot before the rewrite. Read the
		// new branch/presence boundary rather than charging an outage delay.
		if errors.Is(err, db.ErrMythicalItemMoved) {
			return nil, false, err
		}
		return mythicalInfraOutage(item, "launch", "the branch could not be rebased: "+err.Error(), st.now), false, nil
	}
	if !result.Inspected || !codingCommitID.MatchString(result.Head) {
		return nil, false, machined.ErrNotReady
	}
	next := item
	checks := mythicalChecksOf(next)
	if checks.Rebase == nil {
		checks.Rebase = &mythicalRebase{Onto: onto, Name: st.ontoName(onto), Since: st.now}
	}
	checks.Rebase.Native = &result
	next.Checks = checks.encode()
	if tx == nil {
		return nil, false, machined.ErrNotReady
	}
	saved, err := db.New(tx).SaveMythicalItem(ctx, next)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}

	return &saved, true, nil
}

func (st *mythicalItemStep) continueNativeRebase(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	pending := mythicalChecksOf(item).Rebase
	if st.s.branchRebase == nil || pending == nil || pending.Native == nil || pending.Onto != st.prefix(item) {
		return nil, false, nil
	}
	result := pending.Native
	if len(result.Paths) != 0 {
		reservation, err := st.reserveConflict(ctx, item, result.Head, pending.Onto)
		if err != nil {
			return nil, false, err
		}
		next := item
		checks := mythicalChecksOf(next)
		checks.ConflictReservation, checks.Land = reservation, nil
		next.Checks = checks.encode()
		next.Integration, _ = json.Marshal(map[string]any{"conflict": map[string]any{"head": result.Head, "onto": pending.Onto, "paths": result.Paths, "base": item.CandidateBase, "pre_rebase_head": item.CandidateHead}})
		next.Reason = "rebase_conflict_pending"
		// Conflict continuation belongs to the existing conflict path.
		checks.Rebase.Native = nil
		next.Checks = checks.encode()
		return &next, false, nil
	}
	capture, err := st.s.branchRebase.Capture(ctx, item.WorkspaceID)
	if err != nil {
		return nil, false, err
	}
	// Capture ingestion owns its own transaction and may invalidate the old
	// candidate. Reload after its acknowledged publication before verification.
	current, err := st.s.queries().GetMythicalItem(ctx, item.ID)
	if err != nil {
		return nil, false, err
	}
	rebound := mythicalChecksOf(current).Rebase
	if rebound == nil || rebound.Native == nil || rebound.Native.Head != result.Head || rebound.Onto != pending.Onto || current.WorkspaceID != item.WorkspaceID || current.CandidateHead != item.CandidateHead || current.Generation != item.Generation {
		return nil, false, errors.New("rebase capture binding changed")
	}
	ref := "refs/smithers/branches/" + item.WorkspaceID + "/captures/" + capture.Head
	if err := st.r.g.fetch(ctx, st.r.bridge.URL(), 0, 0, ref); err != nil {
		return nil, false, err
	}
	if !st.r.g.has(ctx, result.Head) {
		return nil, false, errors.New("rebase result missing from capture")
	}
	commit, err := st.r.g.readCommit(ctx, result.Head)
	if err != nil {
		return nil, false, err
	}
	if len(commit.Parents) != 1 || commit.Parents[0] != pending.Onto {
		return nil, false, errors.New("rebase result has a different target")
	}
	next := current
	next.CandidateBase, next.CandidateHead = pending.Onto, result.Head
	if paths, err := st.protectedChanges(ctx, next); err != nil {
		return nil, false, err
	} else if len(paths) > 0 {
		return nil, false, errors.New("rebased branch changes protected paths")
	}
	return st.verifyCandidate(ctx, current, next, pending.Onto, result.Head, nil)
}
