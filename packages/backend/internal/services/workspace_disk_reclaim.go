package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WorkspaceDiskReclaimAuthority supplies final-capture and quiet-inventory
// authority from the capture owner. WithFinalCapture must hold exclusion with
// admission, settlement, binding changes and writers until consume returns,
// re-read those facts, and verify the retained host ref and complete objects.
// Its exclusion is acquired before the runtime mutation lock, as on wake.
// A candidate list is only a hint; it cannot authorize deletion.
type WorkspaceDiskReclaimAuthority interface {
	Candidates(context.Context) ([]string, error)
	WithFinalCapture(context.Context, db.Workspace, func(context.Context, WorkspaceDiskReclaimFacts) error) error
}

type WorkspaceDiskReclaimFacts struct {
	WorkspaceID, CandidateHead, CaptureHead string
	Settled, Quiet, CaptureVerified         bool
}

func WithWorkspaceDiskReclaimAuthority(authority WorkspaceDiskReclaimAuthority) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.diskReclaim = authority }
}

// CleanupStoppedAgentWorkspaceDisks stays on the shared cleaner. Until the
// capture owner is composed, missing authority retains every disk.
func (s *WorkspaceService) CleanupStoppedAgentWorkspaceDisks(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	reclaimer, ok := s.runtime.(workspaceapi.WorkspaceDiskReclaimer)
	if s.diskReclaim == nil || !ok {
		return nil
	}
	ids, err := s.diskReclaim.Candidates(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := s.reclaimAgentWorkspaceDisk(ctx, id, reclaimer); err != nil {
			return err
		}
	}
	return nil
}

func (s *WorkspaceService) reclaimAgentWorkspaceDisk(ctx context.Context, id string, runtime workspaceapi.WorkspaceDiskReclaimer) error {
	store, ok := s.q.(interface {
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
		GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error)
	})
	if !ok {
		return nil
	}
	unlock := s.lockRuntimeWorkspace(id)
	row, err := s.q.GetWorkspace(ctx, id)
	unlock()
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.DeletedAt.Valid || (row.Status != "stopped" && row.Status != "suspended") {
		return nil
	}
	return s.diskReclaim.WithFinalCapture(ctx, row, func(ctx context.Context, facts WorkspaceDiskReclaimFacts) error {
		unlock := s.lockRuntimeWorkspace(id)
		defer unlock()
		current, err := s.q.GetWorkspace(ctx, id)
		if err != nil {
			return err
		}
		lane, err := store.GetMythicalLane(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		item, err := store.GetMythicalItem(ctx, lane.ItemID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if lane.WorkspaceID != id || lane.RepositoryID != current.RepositoryID || item.ID != lane.ItemID ||
			item.RepositoryID != current.RepositoryID || item.WorkspaceID != id || item.PausedAt.Valid ||
			item.CandidateHead != facts.CandidateHead {
			return nil
		}
		switch item.State {
		case "landed", "cancelled", "rejected", "declined", "skipped", "dropped":
		default:
			return nil
		}
		// A retained snapshot awaiting reconciliation is newer work, even if
		// the last verified head still matches the settled candidate. Read this
		// durable fence under exclusion; a stale authority receipt cannot erase it.
		if len(current.CapturePending) != 0 || current.ID != id || current.VmID != row.VmID || current.DeletedAt.Valid || (current.Status != "stopped" && current.Status != "suspended") ||
			current.UserID != row.UserID || current.RepositoryID != row.RepositoryID || current.TargetBookmark != row.TargetBookmark ||
			facts.WorkspaceID != id || !facts.Settled || !facts.Quiet || !facts.CaptureVerified ||
			facts.CandidateHead == "" || facts.CandidateHead != facts.CaptureHead || current.HeadCommitID != facts.CandidateHead {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		operationCtx, err := s.workspaceRuntimeContext(ctx, current, current.UserID, workspaceLifecycleOperation(current, "reclaim"))
		if err != nil {
			return err
		}
		return runtime.ReclaimWorkspaceDisk(operationCtx, id)
	})
}

// keepTodoWorkspace is called under the runtime lock, after re-reading the
// workspace. Reuse the branch service owner and durable lane binding, including
// retired lanes: retirement is not proof of settlement or final capture. Until the branch
// settlement/capture and quiet-service contracts land, all bound disks stay.
// Missing binding authority fails closed rather than treating it as no TODO.
func (s *WorkspaceService) keepTodoWorkspace(ctx context.Context, row db.Workspace) (bool, error) {
	// Scratch machines have no Mythical lane. The durable service owner is
	// their identity too; kind alone is not a branch-machine discriminator.
	branch, err := s.branchMachineOwned(ctx, row.UserID)
	if err != nil || branch {
		return true, err
	}
	store, ok := s.q.(interface {
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
	})
	if !ok {
		return row.Kind == "agent", nil
	}
	_, err = store.GetMythicalLane(ctx, row.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return row.Kind == "agent", nil
	}
	return true, err
}
