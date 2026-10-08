package services

import (
	"context"
	"errors"
	"slices"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// WorkspaceConflictValidator selects the real working copy, never the mirror
// for an awake branch. Inspect is the admitted daemon's native conflict RPC.
type WorkspaceConflictValidator struct {
	Workspaces *WorkspaceService
	Inspect    func(context.Context, string, string, string) ([]string, error)
}

func (v *WorkspaceConflictValidator) UnresolvedPaths(ctx context.Context, in ConflictValidation) ([]string, error) {
	unavailable := errors.New("conflict working copy unavailable")
	s := v.Workspaces
	if s == nil || s.installQueries == nil || in.Workspace == "" || in.Change == "" || in.Onto == "" || in.Run == "" || in.Digest == "" {
		return nil, unavailable
	}
	lane, err := s.installQueries.GetMythicalLane(ctx, in.Workspace)
	if err != nil || lane.RetiredAt.Valid {
		return nil, unavailable
	}
	item, err := s.installQueries.GetMythicalItem(ctx, lane.ItemID)
	if err != nil || item.RepositoryID != lane.RepositoryID || item.WorkspaceID != in.Workspace || item.RequestRunID != in.Run || !item.FlowDigest.Valid || item.FlowDigest.String != in.Digest {
		return nil, unavailable
	}
	row, err := s.q.GetWorkspace(ctx, in.Workspace)
	if err != nil || row.RepositoryID != item.RepositoryID {
		return nil, unavailable
	}
	// Reuse branch access and retained-ref verification from ordinary file reads.
	actor := middleware.UserFromContext(ctx)
	if actor == nil {
		return nil, unavailable
	}
	row, owner, repo, head, asleep, err := s.workspaceSnapshotTarget(ctx, in.Workspace, item.RepositoryID, actor.ID)
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
