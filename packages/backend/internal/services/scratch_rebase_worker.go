package services

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func (s *MythicalService) scratchAuthority(ctx context.Context, q *db.Queries, repository int64, in scratchRebaseIntent) (context.Context, error) {
	authority, command := in.executionAuthority()
	if authority == nil {
		return ctx, machined.ErrUnauthorized
	}
	info, err := middleware.ReloadCredential(ctx, q, authority.Credential, s.now())
	if err != nil || info == nil || info.User == nil || info.User.ID != authority.User || info.RawScopes != authority.RawScopes || !middleware.BindInstallCredential(info) {
		return ctx, machined.ErrUnauthorized
	}
	info.ViaHint = authority.Via
	fresh := middleware.ContextWithAuthInfo(ctx, info)
	resolved, err := InstallRepositoryID(fresh, q)
	if err != nil || resolved != repository {
		return ctx, machined.ErrUnauthorized
	}
	if _, err = Authorize(fresh, q, command, InstallSubject{RepositoryID: repository, WorkspaceID: in.Workspace}); err != nil {
		return ctx, err
	}
	return fresh, nil
}

// The stack claim and its ordinary order fence remain the sole rewrite
// authority. A Scratch request never authorizes a TODO or a write to main.
func (s *MythicalService) lockScratchRebase(ctx context.Context, tx pgx.Tx, r *mythicalRun, id string, in scratchRebaseIntent) (db.Workspace, error) {
	var live bool
	if err := tx.QueryRow(ctx, `SELECT state='active' AND running AND claim=$2 AND lease_expires_at>clock_timestamp() FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, r.row.RepositoryID, r.row.Claim).Scan(&live); err != nil {
		return db.Workspace{}, err
	}
	if !live {
		return db.Workspace{}, db.ErrMythicalLeaseLost
	}
	q := db.New(tx)
	if _, err := q.LockMythicalStackOrder(ctx, r.row.RepositoryID); err != nil {
		return db.Workspace{}, err
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT authorization_context FROM product_job_requests WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND operation='branch.rebase-requested' FOR UPDATE`, id, strconv.FormatInt(r.row.RepositoryID, 10), "branch:"+in.Workspace).Scan(&raw); err != nil {
		return db.Workspace{}, err
	}
	var current scratchRebasePrivate
	if err := json.Unmarshal(raw, &current); err != nil {
		return db.Workspace{}, err
	}
	expected, _ := json.Marshal(scratchRebasePrivate{Rebase: in})
	actual, _ := json.Marshal(current)
	if string(expected) != string(actual) {
		return db.Workspace{}, db.ErrMythicalItemMoved
	}
	fresh, err := s.scratchAuthority(ctx, q, r.row.RepositoryID, in)
	if err != nil {
		return db.Workspace{}, err
	}
	authority, _ := in.executionAuthority()
	if err = guardInstallMemberCredential(fresh, tx, r.row.RepositoryID, authority.User, true); err != nil {
		return db.Workspace{}, err
	}
	w, err := s.scratchWorkspaces(q, tx)
	if err != nil {
		return db.Workspace{}, err
	}
	row, err := w.loadWorkspaceWithAccess(fresh, in.Workspace, r.row.RepositoryID, authority.User, WorkspaceAccessWrite)
	if err != nil {
		return db.Workspace{}, err
	}
	if row.TargetBookmark != in.Branch || !row.IsFork || branchKind(row.TargetBookmark) != "scratch" || row.BranchArchivedAt.Valid || len(row.MovedOff) != 0 || row.DeletedAt.Valid {
		return row, db.ErrMythicalItemMoved
	}
	_, onto, err := s.scratchRebaseTarget(ctx, q, row)
	if err != nil {
		return row, err
	}
	if onto != in.Onto {
		return row, db.ErrMythicalItemMoved
	}
	var status, head string
	if err = tx.QueryRow(ctx, `SELECT status,head_commit_id FROM workspaces WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR NO KEY UPDATE`, row.ID, row.RepositoryID).Scan(&status, &head); err != nil {
		return row, err
	}
	if status != row.Status || head != row.HeadCommitID {
		return row, db.ErrMythicalItemMoved
	}
	switch in.Phase {
	case "requested":
		if head != in.Before || (status != "running" && status != "stopped" && status != "suspended") {
			return row, db.ErrMythicalItemMoved
		}
	case "prepared":
		if in.Native == nil && (head != in.Before || (status != "stopped" && status != "suspended")) {
			return row, db.ErrMythicalItemMoved
		}
		if in.Native != nil {
			if status != "running" && status != "stopped" && status != "suspended" {
				return row, db.ErrMythicalItemMoved
			}
			if head != in.Head {
				return row, machined.ErrNotReady
			}
		}
	case "conflict", "resolved":
		if status != "running" && status != "stopped" && status != "suspended" {
			return row, db.ErrMythicalItemMoved
		}
	default:
		return row, db.ErrMythicalItemMoved
	}
	return row, nil
}

func saveScratchIntent(ctx context.Context, tx pgx.Tx, id string, in scratchRebaseIntent) error {
	raw, err := json.Marshal(scratchRebasePrivate{Rebase: in})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE product_job_requests SET authorization_context=$2::jsonb WHERE id=$1`, id, raw)
	return err
}

func (s *MythicalService) advanceScratchRebases(ctx context.Context, r *mythicalRun) error {
	rows, err := s.store.Query(ctx, `SELECT id,authorization_context FROM product_job_requests WHERE tenant_id=$1 AND operation='branch.rebase-requested'
 AND authorization_context->'scratch_rebase'->>'phase' IN ('requested','prepared','conflict','resolved') ORDER BY created_at,id LIMIT 32`, strconv.FormatInt(r.row.RepositoryID, 10))
	if err != nil {
		return err
	}
	type request struct {
		id string
		in scratchRebaseIntent
	}
	pending := []request{}
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var private scratchRebasePrivate
		if err = json.Unmarshal(raw, &private); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, request{id, private.Rebase})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, request := range pending {
		if err = s.advanceScratchRebase(ctx, r, request.id, request.in); err != nil {
			if errors.Is(err, db.ErrMythicalItemMoved) || errors.Is(err, machined.ErrUnauthorized) {
				if err = s.settleScratchRefusal(ctx, r, request.id, request.in); err != nil {
					return err
				}
				continue
			}
			// Unavailable native transport retains this same request. No engine
			// attempt, agent budget or background machine wake is invented here.
			if errors.Is(err, machined.ErrNotReady) {
				due := s.now().Add(3 * time.Second)
				if r.due.IsZero() || due.Before(r.due) {
					r.due = due
				}
				continue
			}
			var refusal *machined.SessionError
			if errors.As(err, &refusal) && refusal.Code == "busy" {
				{
					if err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
						if _, err := s.lockScratchRebase(ctx, tx, r, request.id, request.in); err != nil {
							return err
						}
						next := request.in
						next.BlockingSession = refusal.Session
						next.BlockingBoot = ""
						if refusal.Boot != [16]byte{} {
							next.BlockingBoot = hex.EncodeToString(refusal.Boot[:])
						}
						return saveScratchIntent(ctx, tx, request.id, next)
					}); err != nil {
						if errors.Is(err, db.ErrMythicalItemMoved) || errors.Is(err, machined.ErrUnauthorized) {
							if err := s.settleScratchRefusal(ctx, r, request.id, request.in); err != nil {
								return err
							}
							continue
						}
						return err
					}
				}
				// Keep the same person-authorized request while a writer remains
				// in the existing freeze budget. This is not a stack outage or
				// permission to create another run.
				due := s.now().Add(time.Second)
				if r.due.IsZero() || due.Before(r.due) {
					r.due = due
				}
				continue
			}
			return err
		}
	}
	return nil
}

func (s *MythicalService) advanceScratchRebase(ctx context.Context, r *mythicalRun, id string, in scratchRebaseIntent) error {
	row, err := s.queries().GetWorkspace(ctx, in.Workspace)
	if err != nil {
		return err
	}
	if in.Phase == "resolved" {
		if in.Done == nil || in.Native == nil || !in.Native.Inspected || in.ConflictChange == "" {
			return machined.ErrNotReady
		}
		inspector, ok := s.branchRebase.(interface {
			InspectConflict(context.Context, string, string, string) ([]string, error)
		})
		if !ok {
			return machined.ErrNotReady
		}
		if _, err = s.scratchAuthority(ctx, s.queries(), row.RepositoryID, in); err != nil {
			return err
		}
		paths, err := inspector.InspectConflict(ctx, row.ID, in.ConflictChange, in.Onto)
		if err != nil {
			return err
		}
		if len(paths) != 0 {
			return machined.ErrNotReady
		}
		capture, err := s.branchRebase.Capture(ctx, row.ID)
		if err != nil {
			return err
		}
		next := in
		next.Phase = "prepared"
		next.Head = capture.Head
		next.Native = &machined.RewriteResult{ReceiptID: in.Native.ReceiptID, Head: capture.Head, Inspected: true}
		err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
			if _, err := s.lockScratchRebase(ctx, tx, r, id, in); err != nil {
				return err
			}
			return saveScratchIntent(ctx, tx, id, next)
		})
		if err != nil {
			return err
		}
		return s.publishScratchRebase(ctx, r, id, next)
	}
	if in.Phase == "conflict" {
		if in.Native != nil && in.Native.Inspected {
			return nil
		}
		if row.Status != "running" {
			return machined.ErrNotReady
		}
		// A data-only asleep conflict was never checked out. Materialize it
		// through the same admitted daemon after a person wakes the branch.
	}
	if in.Phase == "prepared" {
		if in.Native != nil {
			if _, err := s.scratchAuthority(ctx, s.queries(), row.RepositoryID, in); err != nil {
				return err
			}
			_, onto, err := s.scratchRebaseTarget(ctx, s.queries(), row)
			if err != nil {
				return err
			}
			if onto != in.Onto || row.TargetBookmark != in.Branch || row.BranchArchivedAt.Valid || len(row.MovedOff) != 0 || row.DeletedAt.Valid {
				return db.ErrMythicalItemMoved
			}
			capture, err := s.branchRebase.Capture(ctx, row.ID)
			if err != nil {
				return err
			}
			if capture.Head != in.Head {
				return db.ErrMythicalItemMoved
			}
		}
		return s.publishScratchRebase(ctx, r, id, in)
	}
	if err = r.g.fetch(ctx, r.bridge.URL(), 0, 0, in.TargetRef, repohost.WorkspaceSourceRef(row.ID, row.SourceCommit), repohost.BranchHeadRef(row.ID)); err != nil {
		return err
	}
	if !r.g.has(ctx, in.Base) || !r.g.has(ctx, in.Before) || !r.g.has(ctx, in.Onto) {
		return machined.ErrNotReady
	}
	if row.Status == "running" {
		if s.branchRebase == nil {
			return machined.ErrNotReady
		}
		var tx pgx.Tx
		defer func() {
			if tx != nil {
				_ = tx.Rollback(context.WithoutCancel(ctx))
			}
		}()
		fresh, err := s.scratchAuthority(ctx, s.queries(), row.RepositoryID, in)
		if err != nil {
			return err
		}
		result, err := s.branchRebase.Rebase(fresh, row.ID, in.Authority.User, in.Onto, in.Base, func(tx pgx.Tx) error { _, err := s.lockScratchRebase(ctx, tx, r, id, in); return err }, func(rewrite func() error) error {
			var err error
			tx, err = s.store.Begin(ctx)
			if err != nil {
				return err
			}
			if _, err = s.lockScratchRebase(ctx, tx, r, id, in); err != nil {
				return err
			}
			return rewrite()
		})
		if err != nil {
			return err
		}
		if tx == nil || !result.Inspected || !isLowerHexRevision(result.Head) {
			return machined.ErrNotReady
		}
		next := in
		next.Native = &result
		next.BlockingBoot, next.BlockingSession = "", 0
		next.Head = result.Head
		next.Phase = "prepared"
		if len(result.Paths) != 0 {
			next.Phase = "conflict"
			next.ConflictChange = result.Head
		}
		if err = saveScratchIntent(ctx, tx, id, next); err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		tx = nil
		if next.Phase == "conflict" {
			return nil
		}
		// The pre-rewrite capture is queued under the native mutation lock.
		// Let its ordered ingestion finish after this transaction releases the
		// stack fence before capturing and publishing the rewritten head.
		due := s.now().Add(time.Second)
		if r.due.IsZero() || due.Before(r.due) {
			r.due = due
		}
		return nil
	}
	if row.Status != "stopped" && row.Status != "suspended" {
		return machined.ErrNotReady
	}
	if s.rebasePresence == nil {
		return machined.ErrNotReady
	}
	state, err := s.rebasePresence(ctx, row.RepositoryID, row.ID)
	if err != nil || state == RebasePresenceUnknown {
		return machined.ErrNotReady
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		locked, err := s.lockScratchRebase(ctx, tx, r, id, in)
		if err != nil {
			return err
		}
		if len(locked.CapturePending) != 0 {
			return machined.ErrNotReady
		}
		before, err := r.g.readCommit(ctx, in.Before)
		if err != nil {
			return err
		}
		tree, err := r.g.merge3(ctx, in.Base, in.Before, in.Onto)
		next := in
		if err != nil {
			var conflict *errMythicalConflict
			if !errors.As(err, &conflict) {
				return err
			}
			before.Tree, before.Parents = conflict.Tree, []string{in.Onto}
			head, err := r.g.writeCommit(ctx, before)
			if err != nil {
				return err
			}
			if err = s.pin(ctx, r, head); err != nil {
				return err
			}
			next.Phase, next.Head = "conflict", head
			next.Native = &machined.RewriteResult{Head: head, Paths: append([]string(nil), conflict.Paths...)}
			next.ConflictChange = head
			if err = saveScratchIntent(ctx, tx, id, next); err != nil {
				return err
			}
			if _, err = db.New(tx).RequestMythicalStack(ctx, row.RepositoryID); err != nil {
				return err
			}
			due := s.now().Add(3 * time.Second)
			if r.due.IsZero() || due.Before(r.due) {
				r.due = due
			}
			return nil
		}
		before.Tree, before.Parents = tree, []string{in.Onto}
		head, err := r.g.writeCommit(ctx, before)
		if err != nil {
			return err
		}
		if err = s.pin(ctx, r, head); err != nil {
			return err
		}
		next.Phase, next.Head = "prepared", head
		due := s.now().Add(time.Second)
		if r.due.IsZero() || due.Before(r.due) {
			r.due = due
		}
		return saveScratchIntent(ctx, tx, id, next)
	})
}

func (s *MythicalService) publishScratchRebase(ctx context.Context, r *mythicalRun, id string, in scratchRebaseIntent) error {
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		row, err := s.lockScratchRebase(ctx, tx, r, id, in)
		if err != nil {
			return err
		}
		if err = r.g.fetch(ctx, r.bridge.URL(), 0, 0, repohost.BranchHeadRef(row.ID)); err != nil {
			return err
		}
		if !r.g.has(ctx, in.Head) {
			if in.Native != nil {
				return machined.ErrNotReady
			}
			if err = r.g.fetch(ctx, r.bridge.URL(), 0, 0, repohost.MythicalReservedRefNS+"keep/"+in.Head); err != nil || !r.g.has(ctx, in.Head) {
				return machined.ErrNotReady
			}
		}
		commit, err := r.g.readCommit(ctx, in.Head)
		if err != nil {
			return err
		}
		if len(row.CapturePending) != 0 {
			var pending MachineCapturePending
			if json.Unmarshal(row.CapturePending, &pending) != nil || in.Native == nil || !in.Native.Inspected || len(in.Native.Paths) != 0 || pending.Head != in.Head || pending.Tree != commit.Tree || pending.Onto != in.Head || pending.Conflict {
				return machined.ErrNotReady
			}
		}
		refs, err := r.g.lsRemote(ctx, r.bridge.URL())
		if err != nil {
			return err
		}
		updates := []mythicalRefUpdate{}
		for _, ref := range []string{repohost.BranchHeadRef(row.ID), scratchRef(row.TargetBookmark)} {
			old := refs[ref]
			if old == in.Head {
				continue
			}
			expected := in.Before
			if ref == scratchRef(row.TargetBookmark) {
				expected = in.Published
			}
			if old != expected {
				return fmt.Errorf("publication ref changed %s: %w", ref, db.ErrMythicalItemMoved)
			}
			if old == "" {
				old = strings.Repeat("0", 40)
			}
			updates = append(updates, mythicalRefUpdate{Ref: ref, Old: old, New: in.Head})
		}
		for _, update := range updates {
			metadata := repohost.ReceivePackMetadata{RepositoryID: row.RepositoryID, PusherLogin: "smithers"}
			if update.Ref == repohost.BranchHeadRef(row.ID) {
				metadata.WorkspaceID = row.ID
			}
			r.bridge.permit([]mythicalRefUpdate{update}, metadata)
			if _, err = r.g.git(ctx, "push", "--porcelain", "--no-verify", "--force-with-lease="+update.Ref+":"+update.Old, r.bridge.URL(), in.Head+":"+update.Ref); err != nil {
				return fmt.Errorf("publish Scratch rebase: %w", err)
			}
		}
		// Both exact ref updates are recoverable after a crash between Git and SQL.
		if len(row.CapturePending) != 0 {
			// Consume only this acknowledged native result, never an unrelated
			// stale snapshot. The same receipt, source and credential remain
			// fenced through publication and this SQL settlement.
			if _, err = tx.Exec(ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, row.ID); err != nil {
				return err
			}
		}
		if _, err = db.New(tx).UpdateWorkspaceHead(ctx, db.UpdateWorkspaceHeadParams{ID: row.ID, HeadCommitID: in.Head, HeadChangeID: commit.ChangeID}); err != nil {
			return err
		}
		next := in
		next.Phase = "completed"
		if err = saveScratchIntent(ctx, tx, id, next); err != nil {
			return err
		}
		authority, _ := in.executionAuthority()
		fact, _ := json.Marshal(map[string]any{"branch": row.TargetBookmark, "workspace": row.ID, "head": in.Head, "onto": in.Onto, "previous_head": in.Before, "actor": map[string]string{"kind": "system", "id": "stack"}, "by": authority.By})
		_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: strconv.FormatInt(row.RepositoryID, 10), PrincipalID: "branch:" + row.ID}, uuid.NewString(), "branch.rebased", "completed", fact)
		return err
	})
}

func (s *MythicalService) settleScratchRefusal(ctx context.Context, r *mythicalRun, id string, in scratchRebaseIntent) error {
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var live bool
		if err := tx.QueryRow(ctx, `SELECT running AND claim=$2 AND lease_expires_at>clock_timestamp() FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, r.row.RepositoryID, r.row.Claim).Scan(&live); err != nil {
			return err
		}
		if !live {
			return db.ErrMythicalLeaseLost
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT authorization_context FROM product_job_requests WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 FOR UPDATE`, id, strconv.FormatInt(r.row.RepositoryID, 10), "branch:"+in.Workspace).Scan(&raw); err != nil {
			return err
		}
		var private scratchRebasePrivate
		if err := json.Unmarshal(raw, &private); err != nil {
			return err
		}
		old, _ := json.Marshal(scratchRebasePrivate{Rebase: in})
		current, _ := json.Marshal(private)
		if string(old) != string(current) {
			return nil
		}
		next := in
		next.Phase = "failed"
		// A revoked manual answer reopens the same retained conflict. The original
		// request remains immutable, so its replay cannot overwrite the new answer.
		if in.Done != nil && in.Phase == "resolved" {
			if _, err := s.scratchAuthority(ctx, db.New(tx), r.row.RepositoryID, in); errors.Is(err, machined.ErrUnauthorized) {
				next.Phase = "conflict"
				next.Done = nil
			}
		}
		return saveScratchIntent(ctx, tx, id, next)
	})
}
