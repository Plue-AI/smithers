package services

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Drop shares retirement's physical host stop and writer-excluded final
// capture. Readiness is checked before the cancellation transaction commits.
func (l *workspaceMythicalLanes) DropCaptureReady(ctx context.Context, tx pgx.Tx, item db.MythicalItem) error {
	if l == nil || l.workspaces == nil {
		return todoControlUnavailable()
	}
	s := l.workspaces
	if s.QuiesceAvailable() != nil || s.prepareFlowHostCapture == nil || s.requireBranchMachineRuntime(ctx) != nil {
		return todoControlUnavailable()
	}
	if _, ok := s.runtime.(interface {
		WithCaptureWritersExcluded(context.Context, string, func(context.Context) error) error
	}); !ok {
		return todoControlUnavailable()
	}
	row, err := db.New(tx).GetWorkspace(ctx, item.WorkspaceID)
	if err != nil {
		return err
	}
	if row.RepositoryID != item.RepositoryID || row.DeletedAt.Valid || row.VmID == "" {
		return todoControlUnavailable()
	}
	if row.Status != "running" && row.Status != "suspended" && row.Status != "stopped" {
		return todoControlUnavailable()
	}
	return s.branchMachineProviders.LaneBinding(ctx, tx, row.RepositoryID, row.TargetBookmark, row.ID)
}

func (l *workspaceMythicalLanes) CaptureDroppedTodo(ctx context.Context, item db.MythicalItem, finish func() error) error {
	if l == nil || l.workspaces == nil {
		return todoControlUnavailable()
	}
	s := l.workspaces
	unlock := s.lockRuntimeWorkspace(item.WorkspaceID)
	defer unlock()
	row, err := s.q.GetWorkspace(ctx, item.WorkspaceID)
	if err != nil {
		return err
	}
	if row.RepositoryID != item.RepositoryID || row.DeletedAt.Valid {
		return todoControlUnavailable()
	}
	if err := s.captureAndSleepLocked(ctx, row, false); err != nil {
		return err
	}
	row, err = s.q.GetWorkspace(ctx, row.ID)
	if err != nil {
		return err
	}
	operation, err := s.workspaceRuntimeContext(ctx, row, row.UserID, workspaceLifecycleOperation(row, "drop"))
	if err != nil {
		return err
	}
	observed, err := s.runtime.InspectWorkspace(operation, row.ID)
	if err != nil {
		return err
	}
	if observed.ID != row.ID || observed.State != workspaceapi.WorkspaceStopped {
		return todoControlUnavailable()
	}
	// Restart recovery must not mistake a stopped disk or an old head for the
	// writer-excluded capture of this machine incarnation.
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var retained bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE event_type='branch.final_capture' AND tenant_id=$1 AND principal_id=$2 AND data->>'head'=$3 AND data->>'vm_id'=$4)`, fmt.Sprint(row.RepositoryID), "branch:"+row.ID, row.HeadCommitID, row.VmID).Scan(&retained)
	if err != nil {
		return err
	}
	if !retained {
		return todoControlUnavailable()
	}
	if err := tx.Rollback(ctx); err != nil {
		return err
	}
	return finish()
}

// The committed Drop obligation is stack work, not a new person command.
// Use the stored machine-service identity while preserving the ordinary
// qualified runtime and publication checks of awake branch capture.
func (l *workspaceMythicalLanes) PrepareDroppedTodoFork(ctx context.Context, id string, repository int64) error {
	if l == nil || l.workspaces == nil {
		return todoControlUnavailable()
	}
	s := l.workspaces
	row, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		return err
	}
	if row.RepositoryID != repository || row.DeletedAt.Valid {
		return todoControlUnavailable()
	}
	owned, err := s.branchMachineOwned(ctx, row.UserID)
	if err != nil {
		return err
	}
	if !owned {
		return todoControlUnavailable()
	}
	return l.prepareCapturedBranchHead(ctx, row, repository, row.UserID)
}
