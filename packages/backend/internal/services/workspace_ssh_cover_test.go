package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceSSH_Cov_TouchSessionActivityBranches(t *testing.T) {
	if err := NewWorkspaceService(nil).TouchSessionActivity(context.Background(), "sess"); err != nil {
		t.Fatalf("nil store TouchSessionActivity returned error: %v", err)
	}

	var touched string
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		touchWorkspaceSessionActivityFn: func(_ context.Context, id string) error {
			touched = id
			return errors.New("touch failed")
		},
	})
	err := svc.TouchSessionActivity(context.Background(), "sess-1")
	if err == nil || !strings.Contains(err.Error(), "touch failed") || touched != "sess-1" {
		t.Fatalf("err=%v touched=%q", err, touched)
	}
}

func TestWorkspaceSSH_Cov_BuildConnectionInfoRootRestrictsAllowedUsers(t *testing.T) {
	var grantReq sandbox.GrantAccessRequest
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			grantVMPermissionFn: func(_ context.Context, _, _ string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
				grantReq = req
				return sandbox.AccessGrant{ID: "perm"}, nil
			},
		}),
		WithWorkspaceSSHHostKeyLoader(&stubHostKeyLoader{keys: []WorkspaceSSHHostKey{{Algorithm: "ssh-ed25519", PublicKey: "pub"}}}),
	)
	svc.workspaceSSHUsername = "root"

	_, err := svc.buildWorkspaceSSHConnectionInfo(context.Background(), sampleDBWorkspace("ws"))
	if err == nil {
		t.Fatal("configured root was accepted")
	}
	if len(grantReq.AllowedUsers) != 0 {
		t.Fatalf("refused root minted a grant: %+v", grantReq)
	}

}

func TestWorkspaceSSH_Cov_GetConnectionInfoUnavailableServices(t *testing.T) {
	_, err := NewWorkspaceService(nil).GetWorkspaceSSHConnectionInfo(context.Background(), "ws", 1, 1)
	if err == nil || !strings.Contains(err.Error(), "workspace store unavailable") {
		t.Fatalf("missing store err = %v", err)
	}

	_, err = NewWorkspaceService(&mockWorkspaceQuerier{}).GetSSHConnectionInfo(context.Background(), "sess", 1, 1)
	if err == nil || !strings.Contains(err.Error(), "sandbox provider unavailable") {
		t.Fatalf("missing sandbox err = %v", err)
	}

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: "sess", WorkspaceID: "ws", RepositoryID: 1, UserID: 1, Status: "running"}, nil
		},
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return sampleDBWorkspace("ws"), nil
		},
		updateWorkspaceSessionSSHConnectionFn: func(context.Context, db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, errors.New("persist failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.GetSSHConnectionInfo(context.Background(), "sess", 1, 1)
	if err == nil || !strings.Contains(err.Error(), "persist ssh connection info") {
		t.Fatalf("persist err = %v", err)
	}
}
