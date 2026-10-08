package services

import (
	"context"
	"errors"
	"slices"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// WorkspaceConflictValidator selects the real working copy, never the mirror
// for an awake branch. Inspect is the admitted daemon's native conflict RPC.
type WorkspaceConflictValidator struct {
	Workspaces *WorkspaceService
	Inspect    func(context.Context, string, string, string) ([]string, error)
}

// PrepareConflictValidation reconnects an already-running authenticated daemon
// before the answer transaction locks the stack. Wake reconciliation publishes
// capture receipts through that same stack, so it cannot start under its lock.
func (v *WorkspaceConflictValidator) PrepareConflictValidation(ctx context.Context, in ConflictValidation) error {
	s := v.Workspaces
	item, _, err := v.conflictBinding(ctx, in)
	if err != nil {
		return err
	}
	actor := middleware.UserFromContext(ctx)
	if actor == nil {
		return errors.New("conflict authority unavailable")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, in.Workspace, item.RepositoryID, actor.ID, WorkspaceAccessRead)
	if err != nil {
		return err
	}
	if row.Status != "running" {
		return nil
	}
	if runtime, ok := s.runtime.(interface {
		EnsureMachined(context.Context, string) error
	}); ok {
		return runtime.EnsureMachined(ctx, row.ID)
	}
	return nil
}

func (v *WorkspaceConflictValidator) UnresolvedPaths(ctx context.Context, in ConflictValidation) ([]string, error) {
	return v.unresolvedPaths(ctx, in, false)
}

// UnresolvedPathsForStack reads only the conflict durably reserved by the
// stack. It grants no person command or browser credential to the worker.
func (v *WorkspaceConflictValidator) UnresolvedPathsForStack(ctx context.Context, in ConflictValidation) ([]string, error) {
	return v.unresolvedPaths(ctx, in, true)
}
func (v *WorkspaceConflictValidator) conflictBinding(ctx context.Context, in ConflictValidation) (db.MythicalItem, db.Workspace, error) {
	s := v.Workspaces
	unavailable := errors.New("conflict working copy unavailable")
	if s == nil || s.installQueries == nil || in.Workspace == "" || in.Change == "" || in.Onto == "" || in.Run == "" || in.Digest == "" {
		return db.MythicalItem{}, db.Workspace{}, unavailable
	}
	lane, err := s.installQueries.GetMythicalLane(ctx, in.Workspace)
	if err != nil || lane.RetiredAt.Valid {
		return db.MythicalItem{}, db.Workspace{}, unavailable
	}
	item, err := s.installQueries.GetMythicalItem(ctx, lane.ItemID)
	if err != nil || item.RepositoryID != lane.RepositoryID || item.WorkspaceID != in.Workspace || item.RequestRunID != in.Run || !item.FlowDigest.Valid || item.FlowDigest.String != in.Digest {
		return db.MythicalItem{}, db.Workspace{}, unavailable
	}
	row, err := s.q.GetWorkspace(ctx, in.Workspace)
	if err != nil || row.RepositoryID != item.RepositoryID {
		return db.MythicalItem{}, db.Workspace{}, unavailable
	}
	return item, row, nil
}

func (v *WorkspaceConflictValidator) unresolvedPaths(ctx context.Context, in ConflictValidation, stackRead bool) ([]string, error) {
	unavailable := errors.New("conflict working copy unavailable")
	s := v.Workspaces
	item, row, err := v.conflictBinding(ctx, in)
	if err != nil {
		return nil, err
	}
	// Reuse branch access and retained-ref verification from ordinary file reads.
	actor := middleware.UserFromContext(ctx)
	var actorID int64
	if stackRead {
		reservation := mythicalChecksOf(item).ConflictReservation
		if item.Reason != "rebase_conflict_pending" || mythicalMergeFenced(item) || reservation == nil || reservation.Change != in.Change || reservation.Onto != in.Onto || reservation.Run != in.Run {
			return nil, unavailable
		}
		stack, err := s.installQueries.GetMythicalStack(ctx, item.RepositoryID)
		if err != nil || stack.State != "active" || !stack.ActorUserID.Valid {
			return nil, unavailable
		}
		actorID = stack.ActorUserID.Int64
	} else {
		if actor == nil {
			return nil, unavailable
		}
		actorID = actor.ID
	}
	row, owner, repo, head, asleep, err := s.workspaceSnapshotTarget(ctx, in.Workspace, item.RepositoryID, actorID)
	if err != nil {
		return nil, err
	}
	if !asleep {
		if row.Status != "running" || v.Inspect == nil {
			return nil, unavailable
		}
		return v.Inspect(ctx, row.ID, in.Change, in.Onto)
	}
	store, ok := s.branchHeads.(interface {
		GetChange(context.Context, string, string, string) (repohost.Change, error)
		GetChangeConflicts(context.Context, string, string, string) ([]repohost.Conflict, error)
	})
	if !ok {
		return nil, unavailable
	}
	retained, err := store.GetChange(ctx, owner, repo, in.Change)
	if err != nil || retained.CommitID != in.Change || retained.ChangeID == "" || retained.ParentCommitID != in.Onto {
		return nil, unavailable
	}
	// Resolution rewrites the item change; a later working-copy change may
	// descend from it. Refuse moved-off or unbounded ancestry before accepting
	// an empty conflict list from an unrelated captured tree.
	revision, bound := head, false
	for n := 0; n < 1024 && revision != ""; n++ {
		change, err := store.GetChange(ctx, owner, repo, revision)
		if err != nil || change.CommitID != revision {
			return nil, unavailable
		}
		if change.ChangeID == retained.ChangeID && change.ParentCommitID == in.Onto {
			bound = true
			break
		}
		if change.ParentCommitID == revision {
			return nil, unavailable
		}
		revision = change.ParentCommitID
	}
	if !bound {
		return nil, unavailable
	}
	conflicts, err := store.GetChangeConflicts(ctx, owner, repo, head)
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, len(conflicts))
	for _, conflict := range conflicts {
		if conflict.FilePath == "" {
			return nil, unavailable
		}
		paths = append(paths, conflict.FilePath)
	}
	slices.Sort(paths)
	return slices.Compact(paths), nil
}
