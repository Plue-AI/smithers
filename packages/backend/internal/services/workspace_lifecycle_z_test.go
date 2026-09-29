package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceLifecycle_Z_TopLevelAndCleanupBranches(t *testing.T) {
	ctx := context.Background()

	_, err := NewWorkspaceService(nil).SuspendWorkspace(ctx, "ws", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	_, err = NewWorkspaceService(nil).ResumeWorkspace(ctx, "ws", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	err = NewWorkspaceService(nil).DestroyWorkspace(ctx, "ws")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	require.NoError(t, NewWorkspaceService(nil).CleanupIdleSessions(ctx))
	require.NoError(t, NewWorkspaceService(nil).CleanupIdleWorkspaces(ctx))
	require.NoError(t, NewWorkspaceService(nil).CleanupStalePendingWorkspaces(ctx))

	loads := 0
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			loads++
			if loads == 2 {
				return db.Workspace{}, errors.New("reload failed")
			}
			ws := sampleDBWorkspace(arg.ID)
			ws.VmID = ""
			return ws, nil
		},
	}).SuspendWorkspace(ctx, "ws", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("load failed")
		},
	}).ResumeWorkspace(ctx, "ws", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("update failed")
		},
	}).UpdateWorkspacePodStatus(ctx, UpdateWorkspacePodStatusInput{WorkspaceID: "ws", Status: "running"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listStalePendingWorkspacesFn: func(context.Context, int32) ([]db.Workspace, error) {
			ws := sampleDBWorkspace("ws-stale")
			ws.Status = "pending"
			return []db.Workspace{ws}, nil
		},
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("mark failed")
		},
	}).CleanupStalePendingWorkspaces(ctx)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkspaceLifecycle_Z_DestroyAndSuspendInternals(t *testing.T) {
	ctx := context.Background()

	var metricDelta float64
	metrics := &mockSandboxMetricsRecorder{addActiveVMsFn: func(vmType string, delta float64) {
		if vmType == "workspace" {
			metricDelta += delta
		}
	}}
	ws := sampleDBWorkspace("ws-destroy")
	ws.VmID = "vm-destroy"
	err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		softDeleteWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, errors.New("soft delete failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}), WithWorkspaceSandboxMetrics(metrics)).
		destroyWorkspace(ctx, ws)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, float64(-1), metricDelta)

	for _, status := range []string{"suspended", "stopped"} {
		ws := sampleDBWorkspace("ws-" + status)
		ws.Status = status
		require.NoError(t, newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
			suspendWorkspace(ctx, ws))
	}

	ws = sampleDBWorkspace("ws-update-error")
	ws.Status = "running"
	ws.VmID = "vm-update-error"
	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, errors.New("cas failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).suspendWorkspace(ctx, ws)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkspaceLifecycle_Z_EnsureRunningAndResumeBranches(t *testing.T) {
	ctx := context.Background()
	ws := sampleDBWorkspace("ws-run")
	ws.Status = "suspended"
	ws.VmID = "vm-run"

	_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-run", State: sandbox.StateStopped}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, errors.New("start failed")
		},
	})).ensureExistingWorkspaceRunning(ctx, ws)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	mutatedPrimary := false
	retained, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			mutatedPrimary = true
			return db.Workspace{}, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "gone"}
		},
	})).ensureWorkspaceRunning(ctx, ws, CreateWorkspaceSessionInput{})
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.Equal(t, pkgerrors.CodeWorkspaceVMMissing, apiErrorOf(t, err).Code)
	assert.Equal(t, ws.VmID, retained.VmID)
	assert.False(t, mutatedPrimary)

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-run", State: sandbox.StateStopped}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, errors.New("resume failed")
		},
	})).ensureWorkspaceRunning(ctx, ws, CreateWorkspaceSessionInput{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	resumed, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-run", State: sandbox.StateStopped}, nil
		},
	})).ensureWorkspaceRunning(ctx, ws, CreateWorkspaceSessionInput{})
	require.NoError(t, err)
	assert.Equal(t, "running", resumed.Status)

	var observed, active float64
	resumed, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}), WithWorkspaceSandboxMetrics(&mockSandboxMetricsRecorder{
		observeSuspendFn: func(seconds float64) { observed++ },
		addActiveVMsFn: func(vmType string, delta float64) {
			if vmType == "workspace" {
				active += delta
			}
		},
	})).resumeWorkspaceVM(ctx, ws)
	require.NoError(t, err)
	assert.Equal(t, "running", resumed.Status)
	assert.Equal(t, float64(1), observed)
	assert.Equal(t, float64(1), active)

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("update failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).resumeWorkspaceVM(ctx, ws)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	// A derived workspace reprovision resets the row (vm_id='',
	// status='starting') via UpdateWorkspaceExecutionInfo so
	// RegisterWorkspaceVM can bind the replacement VM; a reset failure
	// surfaces as 500.
	derived := ws
	derived.IsFork = true
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		updateWorkspaceExecutionInfoFn: func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("reset failed")
		},
	}).reprovisionWorkspaceVM(ctx, derived, CreateWorkspaceSessionInput{}, errors.New("cause"))
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).suspendWorkspace(ctx, ws)
	require.NoError(t, err)
}
