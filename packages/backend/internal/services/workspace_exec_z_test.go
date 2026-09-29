package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceExec_Z_CreateSessionUnavailableAndProvisioningErrors(t *testing.T) {
	ctx := context.Background()

	_, err := NewWorkspaceService(nil).CreateSession(ctx, CreateWorkspaceSessionInput{RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = NewWorkspaceService(&mockWorkspaceQuerier{}).CreateSession(ctx, CreateWorkspaceSessionInput{RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("load failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.CreateSession(ctx, CreateWorkspaceSessionInput{WorkspaceID: "ws-missing", RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		createWorkspaceSessionFn: func(context.Context, db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("create session failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.CreateSession(ctx, CreateWorkspaceSessionInput{WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		createWorkspaceSessionFn: func(context.Context, db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, pgx.ErrNoRows
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.CreateSession(ctx, CreateWorkspaceSessionInput{WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err), "a tombstone winning the session-create race is not an internal error")

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("primary failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.CreateSession(ctx, CreateWorkspaceSessionInput{RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			panic("boom")
		},
	}))
	_, err = svc.CreateSession(ctx, CreateWorkspaceSessionInput{WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestWorkspaceExec_Z_FinishFailAndGraceBranches(t *testing.T) {
	ctx := context.Background()
	session := workspaceExecHSession("sess-z", "old-ws", 1, "pending")
	workspace := sampleDBWorkspace("new-ws")

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		createWorkspaceSessionFn: func(context.Context, db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("replacement failed")
		},
		updateWorkspaceSessionStatusFn: func(context.Context, db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.finishWorkspaceSessionProvisioning(ctx, session, workspace, CreateWorkspaceSessionInput{RepositoryID: 101, UserID: 1}, 80, 24)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceSessionStatusFn: func(context.Context, db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("status failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	session.WorkspaceID = workspace.ID
	_, err = svc.finishWorkspaceSessionProvisioning(ctx, session, workspace, CreateWorkspaceSessionInput{RepositoryID: 101, UserID: 1}, 80, 24)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc.failWorkspaceSession(ctx, "sess-fail")

	release := make(chan struct{})
	finished := make(chan struct{})
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			<-release
			close(finished)
			return sandbox.Sandbox{ID: "vm-source-1", State: sandbox.StateRunning}, nil
		},
	}), withProductionProvisionGrace)
	resp, err := svc.CreateSession(ctx, CreateWorkspaceSessionInput{WorkspaceID: "ws-1", RepositoryID: 101, UserID: 1})
	require.NoError(t, err)
	assert.Equal(t, "sess-1", resp.ID)
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("background provisioning did not finish")
	}
}

func TestWorkspaceExec_Z_DestroySessionSuspendFailureIsLogged(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return workspaceExecHSession("sess-z", "ws-1", 1, "running"), nil
		},
		countActiveSessionsForWorkspaceFn: func(context.Context, string) (int64, error) {
			return 0, nil
		},
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return sampleDBWorkspace("ws-1"), nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
			return sandbox.SuspendResult{}, errors.New("suspend failed")
		},
	}))
	require.NoError(t, svc.DestroySession(ctx, "sess-z", 101, 1))
}
