package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WorkspaceDiskReclaimAuthority is supplied by the final-capture lifecycle.
// Candidates are hints only. WithFinalCapture must re-read settlement, lane
// binding, retained objects and terminal/service inventory, and fence admission
// and all writers until remove returns. No authority means no disk deletion.
// Acquire the supplied lifecycle lock before closing runtime writer admission; hold both through
// archive decision and removal. Scratch and TODO settlements share this authority.
type WorkspaceDiskReclaimAuthority interface {
	Candidates(context.Context) ([]string, error)
	WithFinalCapture(context.Context, db.Workspace, func() func(), func(WorkspaceDiskReclaimCapture) error) error
}

// WorkspaceDiskReclaimCapture names the verified, complete retained capture.
// The authority verifies the host ref through the head report, including the
// working-copy files needed by reopen, before invoking the callback.
type WorkspaceDiskReclaimCapture = workspaceapi.DiskReclaimCapture

func WithWorkspaceDiskReclaimAuthority(authority WorkspaceDiskReclaimAuthority) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.diskReclaimAuthority = authority }
}

// CleanupStoppedAgentWorkspaceDisks shares the five-minute cleaner. It never
// infers settlement or capture from age, retirement or an absent lane binding.
func (s *WorkspaceService) CleanupStoppedAgentWorkspaceDisks(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.diskReclaimAuthority == nil {
		return nil
	}
	if _, ok := s.runtime.(workspaceapi.WorkspaceDiskReclaimer); !ok {
		return nil
	}
	candidates, err := s.diskReclaimAuthority.Candidates(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range candidates {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		if err := s.reclaimAgentWorkspaceDisk(ctx, id); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (s *WorkspaceService) reclaimAgentWorkspaceDisk(ctx context.Context, id string) error {
	unlock := s.lockRuntimeWorkspace(id)
	row, err := s.q.GetWorkspace(ctx, id)
	unlock()
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.DeletedAt.Valid || row.DiskReclaimedAt.Valid || (row.Status != "suspended" && row.Status != "stopped" && row.Status != "running") {
		return nil
	}
	if row.Status == "running" {
		// Only the combined broker/capture lifecycle can stop settled
		// services, capture their final writes and publish a stopped row.
		if _, ok := s.runtime.(WorkspaceCleanupFence); !ok {
			return nil
		}
	}
	if s.diskReclaimAuthority == nil {
		return nil
	}
	reclaimer, ok := s.runtime.(workspaceapi.WorkspaceDiskReclaimer)
	if !ok {
		return nil
	}
	return s.diskReclaimAuthority.WithFinalCapture(ctx, row, func() func() { return s.lockRuntimeWorkspace(id) }, func(capture WorkspaceDiskReclaimCapture) error {
		// The lifecycle lock covers this re-read and runtime removal; the authority
		// keeps settlement/binding and quiet inventory fenced across the callback.
		current, err := s.q.GetWorkspace(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if !cleanupCapturePendingMatches(current, capture) || current.DeletedAt.Valid || (current.Status != "suspended" && current.Status != "stopped") {
			return nil
		}
		if current.VmID != row.VmID || current.RepositoryID != row.RepositoryID || current.UserID != row.UserID || current.TargetBookmark != row.TargetBookmark {
			return nil
		}
		if !capture.Settled || !capture.Quiet || !capture.BindingVerified || !capture.CaptureComplete || !capture.InventoryCurrent || capture.WorkspaceID != id || capture.CaptureID == "" ||
			capture.CandidateHead == "" || capture.CandidateHead != current.HeadCommitID || capture.RetainedHead != capture.CandidateHead {
			return nil
		}
		// Re-check TODO binding even for injected capture authorities. Scratch
		// workspaces have no lane and rely on the transactional archive authority.
		if store, ok := s.q.(interface {
			GetMythicalLane(context.Context, string) (db.MythicalLane, error)
			GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error)
		}); ok {
			lane, err := store.GetMythicalLane(ctx, id)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil {
				item, err := store.GetMythicalItem(ctx, lane.ItemID)
				if err != nil {
					return err
				}
				if lane.WorkspaceID != id || lane.RepositoryID != current.RepositoryID || item.ID != lane.ItemID || item.RepositoryID != current.RepositoryID || item.WorkspaceID != id || item.PausedAt.Valid {
					return nil
				}
				switch item.State {
				case "landed", "cancelled", "rejected", "declined", "skipped", "dropped":
				default:
					return nil
				}
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		operationCtx, err := s.workspaceRuntimeContext(ctx, current, current.UserID, workspaceLifecycleOperation(current, "reclaim"))
		if err != nil {
			return err
		}
		return reclaimer.ReclaimWorkspaceDisk(operationCtx, id)
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
