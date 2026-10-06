package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceSSH_Z_GetWorkspaceAndBuildErrorBranches(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	_, err := NewWorkspaceService(nil).GetWorkspaceSSHConnectionInfo(ctx, "ws", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = NewWorkspaceService(nil).GetSSHConnectionInfo(ctx, "sess", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = NewWorkspaceService(&mockWorkspaceQuerier{}).GetWorkspaceSSHConnectionInfo(ctx, "ws", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("load failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.GetWorkspaceSSHConnectionInfo(ctx, "ws", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace("ws")
			ws.VmID = ""
			return ws, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.GetWorkspaceSSHConnectionInfo(ctx, "ws", 101, 1)
	assert.Equal(t, http.StatusConflict, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("session failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.GetSSHConnectionInfo(ctx, "sess", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: "sess", WorkspaceID: "ws", RepositoryID: 101, UserID: 1, Status: "running"}, nil
		},
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("workspace failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.GetSSHConnectionInfo(ctx, "sess", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: "sess", WorkspaceID: "ws", RepositoryID: 101, UserID: 1, Status: "running"}, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, errors.New("get vm failed")
		},
	}))
	_, err = svc.GetSSHConnectionInfo(ctx, "sess", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: "sess", WorkspaceID: "ws", RepositoryID: 101, UserID: 1, Status: "running"}, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}), WithWorkspaceSSHHostKeyLoader(&stubHostKeyLoader{err: errors.New("keys failed")}))
	_, err = svc.GetSSHConnectionInfo(ctx, "sess", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	workspace := sampleDBWorkspace("ws-build")
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(workspaceSSHZSandboxClient{
		mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{},
		createIdentityErr:            errors.New("identity failed"),
	}))
	_, err = svc.buildWorkspaceSSHConnectionInfo(ctx, workspace, workspace.UserID)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(workspaceSSHZSandboxClient{
		mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{
			grantVMPermissionFn: func(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
				return sandbox.AccessGrant{}, errors.New("grant failed")
			},
		},
	}))
	_, err = svc.buildWorkspaceSSHConnectionInfo(ctx, workspace, workspace.UserID)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(workspaceSSHZSandboxClient{
		mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{},
		createTokenErr:               errors.New("token failed"),
	}))
	_, err = svc.buildWorkspaceSSHConnectionInfo(ctx, workspace, workspace.UserID)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}),
		WithWorkspaceSSHHostKeyLoader(&stubHostKeyLoader{err: errors.New("keys failed")}),
	)
	_, err = svc.buildWorkspaceSSHConnectionInfo(ctx, workspace, workspace.UserID)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

type workspaceSSHZSandboxClient struct {
	*mockWorkspaceSandboxVMClient
	createIdentityErr error
	createTokenErr    error
}

func (c workspaceSSHZSandboxClient) CreateIdentity(context.Context) (sandbox.Identity, error) {
	if c.createIdentityErr != nil {
		return sandbox.Identity{}, c.createIdentityErr
	}
	return sandbox.Identity{ID: "identity-z"}, nil
}

func (c workspaceSSHZSandboxClient) CreateIdentityToken(context.Context, string) (sandbox.CreatedToken, error) {
	if c.createTokenErr != nil {
		return sandbox.CreatedToken{}, c.createTokenErr
	}
	return sandbox.CreatedToken{ID: "token-z", Token: "token-z"}, nil
}
