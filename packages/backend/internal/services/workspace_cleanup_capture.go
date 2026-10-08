package services

import (
	"context"
	"errors"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type CleanupCaptureVerifier func(context.Context, db.Workspace, func(WorkspaceDiskReclaimCapture) error) error

// BindWorkspaceCleanupCapture composes the installed runtime's writer fence
// with ordinary capture/sleep and the authenticated host receipt verifier.
func (s *WorkspaceService) BindWorkspaceCleanupCapture(verify CleanupCaptureVerifier) func() {
	binder, ok := s.runtime.(interface {
		BindCleanupCapture(workspaceapi.CleanupCapture)
	})
	if !ok {
		return func() {}
	}
	binder.BindCleanupCapture(func(ctx context.Context, binding workspaceapi.CleanupWorkspace, consume func(WorkspaceDiskReclaimCapture) error) error {
		if verify == nil || s.transactions == nil || binding.SettledAt.IsZero() || binding.Now.Sub(binding.SettledAt) < 24*time.Hour {
			return errors.New("cleanup contracts unavailable")
		}
		row, err := s.q.GetWorkspace(ctx, binding.ID)
		if err != nil {
			return err
		}
		if row.VmID != binding.VMID || row.TargetBookmark != binding.Branch || row.RepositoryID != binding.RepositoryID || row.UserID != binding.OwnerID {
			return errors.New("cleanup machine binding changed")
		}
		var active bool
		tx, err := s.transactions.Begin(ctx)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_sessions WHERE workspace_id=$1 AND status IN ('pending','starting','running'))`, row.ID).Scan(&active)
		_ = tx.Rollback(context.WithoutCancel(ctx))
		if err != nil {
			return err
		}
		if active {
			return nil
		}
		operationCtx, err := s.workspaceRuntimeContext(ctx, row, row.UserID, workspaceLifecycleOperation(row, "cleanup-capture"))
		if err != nil {
			return err
		}
		if row.Status == "running" {
			catalog, ok := s.runtime.(workspaceapi.WorkspaceServiceCatalog)
			if !ok {
				return errors.New("cleanup service inventory unavailable")
			}
			inventory, err := catalog.ListServices(operationCtx, row.ID)
			if err != nil {
				return err
			}
			for _, service := range inventory {
				if service.State == workspaceapi.ServiceRunning {
					if err := s.runtime.StopService(operationCtx, row.ID, service.Name); err != nil {
						return err
					}
				}
			}
			inventory, err = catalog.ListServices(operationCtx, row.ID)
			if err != nil {
				return err
			}
			for _, service := range inventory {
				if service.State == workspaceapi.ServiceRunning {
					return errors.New("cleanup service stop unconfirmed")
				}
			}
			if err := s.captureAndSleepLocked(operationCtx, row, true); err != nil {
				return err
			}
			row, err = s.q.GetWorkspace(ctx, row.ID)
			if err != nil {
				return err
			}
		}
		if row.Status != "suspended" && row.Status != "stopped" {
			return nil
		}
		observed, err := s.runtime.InspectWorkspace(operationCtx, row.ID)
		if err != nil {
			return err
		}
		if observed.ID != row.ID || observed.State != workspaceapi.WorkspaceStopped {
			return errors.New("cleanup requires confirmed stopped machine")
		}
		fence, ok := s.runtime.(interface {
			WithCaptureWritersExcluded(context.Context, string, func(context.Context) error) error
		})
		if !ok {
			return errors.New("cleanup writer inventory unavailable")
		}
		return fence.WithCaptureWritersExcluded(operationCtx, row.ID, func(ctx context.Context) error { return verify(ctx, row, consume) })
	})
	return func() { binder.BindCleanupCapture(nil) }
}
