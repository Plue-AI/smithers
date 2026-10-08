package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

// BranchRebaseExecutor uses the authenticated daemon's existing mutation lock,
// freeze and object transport. The stack worker alone admits and publishes it.
type BranchRebaseExecutor interface {
	Rebase(context.Context, string, int64, string, string, func(pgx.Tx) error, func(func() error) error) (machined.RewriteResult, error)
	Capture(context.Context, string) (machined.CaptureResult, error)
}

func (s *MythicalService) SetBranchRebaseExecutor(executor BranchRebaseExecutor) {
	s.branchRebase = executor
}

func sameAsleepRebaseResult(planned, published mythicalCommit) bool {
	return planned.ChangeID != "" && planned.ChangeID == published.ChangeID &&
		len(planned.Parents) == 1 && len(published.Parents) == 1 && planned.Parent() == published.Parent() &&
		planned.Tree == published.Tree && planned.Message == published.Message && planned.Author == published.Author
}

func (st *mythicalItemStep) lockNativeRebase(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string) error {
	return st.lockNativeRebaseState(ctx, tx, item, onto, true)
}

// Execution requires an awake machine. After its immutable capture is
// acknowledged, verification may retire a review lane before admission.
func (st *mythicalItemStep) lockNativeRebaseReceipt(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string) error {
	if r := mythicalChecksOf(item).ConflictReservation; r != nil && r.Done != nil {
		return st.lockRebasePrefixAuthority(ctx, tx, item, onto, onto, false, st.s.conflictDoneAuthorized)
	}
	return st.lockNativeRebaseState(ctx, tx, item, onto, false)
}

func (st *mythicalItemStep) lockNativeRebaseState(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string, executing bool) error {
	return st.lockNativeRebasePrefix(ctx, tx, item, onto, onto, executing)
}

func (st *mythicalItemStep) lockNativeRebasePrefix(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto, prefix string, executing bool) error {
	return st.lockRebasePrefixAuthority(ctx, tx, item, onto, prefix, executing, nil)
}

func (st *mythicalItemStep) lockConflictCapture(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto string) error {
	return st.lockRebasePrefixAuthority(ctx, tx, item, onto, onto, true, st.s.conflictDoneAuthorized)
}

func (st *mythicalItemStep) lockRebasePrefixAuthority(ctx context.Context, tx pgx.Tx, item db.MythicalItem, onto, prefix string, executing bool, authority func(context.Context, *db.Queries, db.MythicalItem) bool) error {
	if authority == nil {
		authority = func(ctx context.Context, _ *db.Queries, current db.MythicalItem) bool {
			return st.s.mayExecuteRequestedRebase(ctx, current, onto) || st.s.mayRebaseItemAtBoundary(ctx, current)
		}
	}
	// Presence resolves the existing host through its own authority transaction
	// and SHARE lock on this workspace. Read that live boundary before taking
	// mutation locks here; otherwise the fence waits on its own presence read.
	// The locks below still reject any changed item, prefix or machine before
	// the native mutation starts.
	if !authority(ctx, st.s.queries(), item) {
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
	if current.Version != item.Version || current.WorkspaceID != item.WorkspaceID || current.PausedAt.Valid != item.PausedAt.Valid || (current.PausedAt.Valid && !current.PausedAt.Time.Equal(item.PausedAt.Time)) || mythicalMergeFenced(current) || len(current.PendingOp) != 0 || step.prefix(current) != prefix {
		return fmt.Errorf("rebase binding changed: %w", db.ErrMythicalItemMoved)
	}
	// The existing host's roster read holds SHARE on the workspace. Read it
	// while stack/item authority is pinned, before taking the exclusive
	// workspace fence; taking that fence first deadlocks our own RPC.
	if !authority(ctx, q, current) {
		return errors.New("rebase authority changed")
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
		if pending == nil || pending.Native == nil || !pending.Native.Inspected || len(pending.Native.Paths) != 0 || pending.Onto != onto || pending.Native.Head != head || (status != "running" && status != "stopped" && status != "suspended") {
			return machined.ErrNotReady
		}
	}
	return nil
}

func (st *mythicalItemStep) executeNativeRebase(ctx context.Context, item db.MythicalItem, onto string) (*db.MythicalItem, bool, error) {
	if st.s.branchRebase == nil {
		return nil, false, nil
	}
	checks := mythicalChecksOf(item)
	var retained struct{ Conflict struct{ Head, Onto string } }
	_ = json.Unmarshal(item.Integration, &retained)
	materializing := checks.Rebase != nil && checks.Rebase.Native == nil && checks.ConflictReservation != nil && !checks.ConflictReservation.Dispatched && checks.ConflictReservation.Onto == onto && retained.Conflict.Head == checks.ConflictReservation.Change && retained.Conflict.Onto == onto
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
	result, err := st.s.branchRebase.Rebase(ctx, item.WorkspaceID, member, onto, item.CandidateBase, func(tx pgx.Tx) error { return st.lockNativeRebase(ctx, tx, item, onto) }, func(rewrite func() error) error {
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
		if materializing && errors.Is(err, machined.ErrNotReady) {
			// Wake and host startup acknowledge before readiness. Keep this
			// existing reservation due without spending an outage or attempt.
			next := item
			next.NextAttemptAt.Valid = true
			next.NextAttemptAt.Time = st.now.Add(3 * time.Second)
			return &next, false, nil
		}
		// A fresh fence refused this snapshot before the rewrite. Read the
		// new branch/presence boundary rather than charging an outage delay.
		if errors.Is(err, db.ErrMythicalItemMoved) {
			return nil, false, err
		}
		var refusal *machined.SessionError
		if errors.As(err, &refusal) && refusal.Code == "busy" {
			// A kernel writer can outlive several freeze budgets. Retain the
			// same authorized request; waiting is not an infrastructure outage.
			next := item
			checks := mythicalChecksOf(next)
			if checks.Rebase == nil {
				checks.Rebase = &mythicalRebase{Onto: onto, Name: st.ontoName(onto), Since: st.now}
			}
			checks.Rebase.BlockingSession = refusal.Session
			next.Checks = checks.encode()
			next.Reason = "rebase_pending"
			next.NextAttemptAt = pgtype.Timestamptz{Time: st.s.now().Add(time.Second), Valid: true}
			return &next, false, nil
		}
		return mythicalInfraOutage(item, "launch", "the branch could not be rebased: "+err.Error(), st.now), false, nil
	}
	if !result.Inspected || !codingCommitID.MatchString(result.Head) {
		return nil, false, machined.ErrNotReady
	}
	next := item
	if checks.Rebase == nil {
		checks.Rebase = &mythicalRebase{Onto: onto, Name: st.ontoName(onto), Since: st.now}
	}
	checks.Rebase.BlockingSession = 0
	checks.Rebase.Native = &result
	if capture := checks.Capture; capture != nil && capture.SourceRef != "" && checks.ProposalRun == item.RequestRunID && checks.ProposalHead == capture.Head {
		// Preserve the immutable request across the native rewrite. Its
		// original bytes are not a new edit when the caller polls again.
		next.Integration, _ = json.Marshal(map[string]string{"kind": "captured", "head": capture.Head, "tree": capture.Tree})
	}
	if materializing {
		// The asleep data-only merge reserved this budget before a coding
		// machine existed. Materialization binds that same reservation to the
		// daemon's native conflict; it never reserves or launches repair twice.
		checks.ConflictReservation.Change = result.Head
		next.Integration, _ = json.Marshal(map[string]any{"conflict": map[string]any{"head": result.Head, "onto": onto, "paths": result.Paths, "base": item.CandidateBase, "pre_rebase_head": item.CandidateHead}})
		next.Reason = "rebase_conflict_pending"
		if len(result.Paths) == 0 {
			next.Reason = ""
		}
	}
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

// A conflicted asleep merge is retained as data first. Only conflict
// materialization needs the original coding machine; clean asleep rebases
// continue through host verification without waking that branch.
func (st *mythicalItemStep) materializeRetainedConflict(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	checks := mythicalChecksOf(item)
	reservation, pending := checks.ConflictReservation, checks.Rebase
	_, pinned := mythicalPinOf(item)
	if st.s.branchRebase == nil || st.s.conflictValidator == nil || st.s.launcher == nil || !pinned || !checks.RunLaunched || !checks.RunAttached || reservation == nil || pending == nil || pending.Native != nil || reservation.Dispatched || reservation.Run != item.RequestRunID || reservation.Onto != pending.Onto || st.prefix(item) != pending.Onto {
		return nil, false, nil
	}
	branch, err := st.q.GetMythicalTodoBranchWorkspace(ctx, item)
	if err != nil {
		return nil, false, err
	}
	if branch.Status != "running" && branch.Status != "stopped" && branch.Status != "suspended" {
		return nil, false, nil
	}
	lane, err := st.q.GetMythicalLane(ctx, branch.ID)
	if err != nil || lane.ItemID != item.ID || lane.RepositoryID != item.RepositoryID {
		return nil, false, machined.ErrNotReady
	}
	if item.WorkspaceID == branch.ID && !lane.RetiredAt.Valid {
		return st.executeNativeRebase(ctx, item, pending.Onto)
	}
	// Rebind and revive the retained lane before the existing executor's
	// admitted wake. No new TODO, attempt, workspace or agent is created.
	next := item
	next.WorkspaceID = branch.ID
	err = pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
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
		step := *st
		step.items = order
		main, err := st.s.MainHead(ctx, st.r.owner, st.r.repo, "main")
		if err != nil {
			return err
		}
		if current.Version != item.Version || current.PausedAt.Valid || mythicalMergeFenced(current) || len(current.PendingOp) != 0 || step.prefix(current) != pending.Onto || main != st.r.mainTip {
			return db.ErrMythicalItemMoved
		}
		if !st.s.mayExecuteRequestedRebase(ctx, next, pending.Onto) && !st.s.mayRebaseItemAtBoundary(ctx, next) {
			return db.ErrMythicalItemMoved
		}
		var status, head string
		var capture []byte
		if err := tx.QueryRow(ctx, `SELECT status,head_commit_id,capture_pending FROM workspaces WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR NO KEY UPDATE`, branch.ID, item.RepositoryID).Scan(&status, &head, &capture); err != nil {
			return err
		}
		if status != branch.Status || head != branch.HeadCommitID || len(capture) != 0 {
			return db.ErrMythicalItemMoved
		}
		next, err = q.SaveMythicalItem(ctx, next)
		if err != nil {
			return err
		}
		return q.RestoreMythicalItemLane(ctx, next)
	})
	if err != nil {
		return nil, false, err
	}
	return &next, true, nil
}

func (st *mythicalItemStep) continueNativeRebase(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	pending := mythicalChecksOf(item).Rebase
	if st.s.branchRebase == nil || pending == nil || pending.Native == nil {
		return nil, false, nil
	}
	result := pending.Native
	if len(result.Paths) != 0 {
		// Conflict continuation retains its original target and budget.
		if pending.Onto != st.prefix(item) {
			return nil, false, nil
		}
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
		// Retain the authenticated native receipt across restart. The conflict
		// continuation owns this state until it supplies a resolved capture.
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
	if pending.Onto != st.prefix(current) {
		return st.retargetCapturedNativeRebase(ctx, current, next, capture, commit.Tree)
	}
	checks := mythicalChecksOf(next)
	if pause := checks.Pause; pause != nil && pause.State == "running" && pause.Run == next.RequestRunID && next.RequestOutcome == "" {
		// This capture repairs the parked coding run's branch, not a finished
		// proposal. Let that same journal finish coding before verifying it.
		next.State, next.Reason, next.CandidateVerified = "running", "", false
		checks.Capture, checks.Land = nil, nil
		checks.Rebase.Rebased = true
		next.Checks = checks.encode()
		err := pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
			if err := st.lockNativeRebaseReceipt(ctx, tx, current, pending.Onto); err != nil {
				return err
			}
			saved, err := db.New(tx).SaveMythicalItem(ctx, next)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, next.WorkspaceID); err != nil {
				return err
			}
			next = saved
			return st.s.recordTodoRebased(ctx, tx, saved, current, pending.Name)
		})
		return &next, err == nil, err
	}
	return st.verifyCandidate(ctx, current, next, pending.Onto, result.Head, nil)
}

// A clean native rewrite can finish just before main moves again. Consume its
// exact capture as unverified data, then rebase that own diff onto the current
// prefix. Leaving the old receipt pending would wait forever; verifying the
// superseded target would spend a launch without checking the current prefix.
func (st *mythicalItemStep) retargetCapturedNativeRebase(ctx context.Context, item, next db.MythicalItem, capture machined.CaptureResult, tree string) (*db.MythicalItem, bool, error) {
	pending := mythicalChecksOf(item).Rebase
	retained := mythicalChecksOf(item).Capture
	if pending == nil || pending.Native == nil || !pending.Native.Inspected || len(pending.Native.Paths) != 0 || capture.Head != pending.Native.Head || capture.Tree != tree || retained == nil || retained.Head != capture.Head || retained.Tree != tree || retained.Stale || retained.Conflict {
		return nil, false, machined.ErrNotReady
	}
	review, err := st.cleanRebaseReview(ctx, item, pending.Onto, capture.Head)
	if err != nil {
		return nil, false, err
	}
	checks := mythicalChecksOf(next)
	checks.Capture, checks.Review = nil, review
	next.Checks = checks.encode()
	next = *st.invalidatePrefix(next)
	tx, err := st.s.store.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err = st.lockNativeRebasePrefix(ctx, tx, item, pending.Onto, st.prefix(item), false); err != nil {
		return nil, false, err
	}
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT capture_pending FROM workspaces WHERE id=$1`, item.WorkspaceID).Scan(&raw); err != nil {
		return nil, false, err
	}
	var current MachineCapturePending
	if json.Unmarshal(raw, &current) != nil || current.Head != capture.Head || current.Tree != tree || current.Stale || current.Conflict {
		return nil, false, machined.ErrNotReady
	}
	saved, err := db.New(tx).SaveMythicalItem(ctx, next)
	if err != nil {
		return nil, false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, item.WorkspaceID); err != nil {
		return nil, false, err
	}
	receipt := saved
	recorded := mythicalChecksOf(receipt)
	recorded.Rebase = &mythicalRebase{Onto: pending.Onto, Name: pending.Name, ReceiptID: pending.Native.ReceiptID, Request: pending.Request, Rebased: true, HeadChanged: item.CandidateHead != capture.Head}
	receipt.Checks = recorded.encode()
	if err = st.s.recordTodoRebased(ctx, tx, receipt, item, pending.Name); err != nil {
		return nil, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return &saved, true, nil
}
