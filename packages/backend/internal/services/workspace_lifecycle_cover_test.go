package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceLifecycle_Cov_UpdatePodStatusValidationAndNotify(t *testing.T) {
	err := NewWorkspaceService(nil).UpdateWorkspacePodStatus(context.Background(), UpdateWorkspacePodStatusInput{WorkspaceID: "ws", Status: "running"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	err = svc.UpdateWorkspacePodStatus(context.Background(), UpdateWorkspacePodStatusInput{WorkspaceID: "ws", Status: "booting"})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	var notified db.NotifyWorkspaceStatusParams
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			assert.Equal(t, "ws-123", arg.ID)
			assert.Equal(t, "failed", arg.Status)
			ws := sampleDBWorkspace(arg.ID)
			ws.Status = arg.Status
			return ws, nil
		},
		notifyWorkspaceStatusFn: func(_ context.Context, arg db.NotifyWorkspaceStatusParams) error {
			notified = arg
			return nil
		},
	})
	require.NoError(t, svc.UpdateWorkspacePodStatus(context.Background(), UpdateWorkspacePodStatusInput{WorkspaceID: "ws-123", Status: "failed"}))
	assert.Equal(t, "ws123", notified.SessionID)
	assert.Contains(t, notified.Payload, "failed")
}

func TestWorkspaceLifecycle_Cov_DeleteAndDestroyStoreErrors(t *testing.T) {
	err := NewWorkspaceService(nil).DeleteWorkspace(context.Background(), "ws", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	})
	err = svc.DeleteWorkspace(context.Background(), "missing", 101, 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, errors.New("db down")
		},
	})
	err = svc.DestroyWorkspace(context.Background(), "missing")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestWorkspaceLifecycle_Cov_CleanupIdleSessionsDestroysAndSuspends(t *testing.T) {
	var stopped []string
	var suspended []string
	q := &mockWorkspaceQuerier{
		listIdleWorkspaceSessionsFn: func(context.Context) ([]db.WorkspaceSession, error) {
			return []db.WorkspaceSession{{ID: "sess-1", WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1, Status: "running"}}, nil
		},
		getWorkspaceSessionByRepoFn: func(_ context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: arg.RepositoryID, UserID: 1, Status: "running"}, nil
		},
		updateWorkspaceSessionStatusFn: func(_ context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			stopped = append(stopped, arg.ID+":"+arg.Status)
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1, Status: arg.Status}, nil
		},
		countActiveSessionsForWorkspaceFn: func(context.Context, string) (int64, error) { return 0, nil },
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.VmID = "vm-idle"
			ws.Status = "running"
			return ws, nil
		},
		suspendRunningWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			suspended = append(suspended, id)
			ws := sampleDBWorkspace(id)
			ws.Status = "suspended"
			return ws, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	require.NoError(t, svc.CleanupIdleSessions(context.Background()))
	assert.Equal(t, []string{"sess-1:stopped"}, stopped)
	assert.Empty(t, suspended, "automatic release must not change status without capture")

	err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listIdleWorkspaceSessionsFn: func(context.Context) ([]db.WorkspaceSession, error) {
			return nil, errors.New("list failed")
		},
	}).CleanupIdleSessions(context.Background())
	require.Error(t, err)
	assert.Equal(t, "list failed", err.Error())
}

func TestWorkspaceLifecycle_Cov_CleanupIdleWorkspacesAndStaleErrors(t *testing.T) {
	suspendCalls := 0
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listIdleWorkspacesFn: func(context.Context) ([]db.Workspace, error) {
			ws := sampleDBWorkspace("ws-idle")
			ws.VmID = "vm-idle"
			ws.Status = "running"
			return []db.Workspace{ws}, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			suspendCalls++
			return sandbox.SuspendResult{}, &sandbox.StatusError{StatusCode: 500, Message: "boom"}
		},
	}))
	require.NoError(t, svc.CleanupIdleWorkspaces(context.Background()))
	assert.Zero(t, suspendCalls, "idle release must not stop without capture")

	err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listIdleWorkspacesFn: func(context.Context) ([]db.Workspace, error) {
			return nil, errors.New("idle list failed")
		},
	}).CleanupIdleWorkspaces(context.Background())
	require.Error(t, err)
	assert.Equal(t, "idle list failed", err.Error())

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		listStalePendingWorkspacesFn: func(context.Context, int32) ([]db.Workspace, error) {
			return nil, errors.New("stale list failed")
		},
	}).CleanupStalePendingWorkspaces(context.Background())
	require.Error(t, err)
	assert.Equal(t, "stale list failed", err.Error())
}

func TestWorkspaceLifecycle_Cov_EnsureRunningBranches(t *testing.T) {
	ws := sampleDBWorkspace("ws-run")
	ws.VmID = ""
	_, err := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).ensureExistingWorkspaceRunning(context.Background(), ws)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	ws.VmID = "vm-missing"
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "gone"}
		},
	}))
	_, err = svc.ensureExistingWorkspaceRunning(context.Background(), ws)
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))

	var touched bool
	var updatedStatus string
	ws.Status = "suspended"
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updatedStatus = arg.Status
			updated := sampleDBWorkspace(arg.ID)
			updated.Status = arg.Status
			updated.VmID = "vm-running"
			return updated, nil
		},
		touchWorkspaceActivityFn: func(context.Context, string) error {
			touched = true
			return nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-running", State: sandbox.StateRunning}, nil
		},
	}))
	updated, err := svc.ensureExistingWorkspaceRunning(context.Background(), ws)
	require.NoError(t, err)
	assert.Equal(t, "running", updated.Status)
	assert.Equal(t, "running", updatedStatus)
	assert.True(t, touched)
}

func TestWorkspaceLifecycle_Cov_SuspendStatusHelpers(t *testing.T) {
	assert.True(t, vmAlreadyStopped(&sandbox.StatusError{StatusCode: 400, Message: "VM IS NOT RUNNING"}))
	assert.True(t, vmAlreadyStopped(&sandbox.StatusError{StatusCode: 404, Message: "gone"}))
	assert.False(t, vmAlreadyStopped(&sandbox.StatusError{StatusCode: 400, Message: "bad request"}))
	assert.False(t, vmAlreadyStopped(errors.New("plain")))
	assert.True(t, vmAlreadyGone(&sandbox.StatusError{StatusCode: 404, Message: "gone"}))
	assert.False(t, vmAlreadyGone(&sandbox.StatusError{StatusCode: 400, Message: "not running"}))
}
