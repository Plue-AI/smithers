package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Root is refused before effects; stage-1 grants are scoped to agent.
func TestWorkspaceService_GetWorkspaceSSHConnectionInfoAs_BindsGrantToRequestedUser(t *testing.T) {
	t.Parallel()

	const wsID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-root"
			return workspace, nil
		},
	}
	var granted []string
	grants := 0
	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			grantVMPermissionFn: func(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
				granted = req.AllowedUsers
				grants++
				return sandbox.AccessGrant{ID: "perm"}, nil
			},
		}),
		WithWorkspaceSSHHost("ssh.jjhub.tech"),
	)

	_, err := svc.GetWorkspaceSSHConnectionInfoAs(context.Background(), wsID, 101, 1, "root")
	require.Error(t, err)
	assert.Empty(t, granted)
	assert.Zero(t, grants)

	info, err := svc.GetWorkspaceSSHConnectionInfoAs(context.Background(), wsID, 101, 1, "")
	require.NoError(t, err)
	assert.Equal(t, []string{"agent"}, granted, "empty means the workspace user")
	assert.Equal(t, "agent", info.Username)

	_, err = svc.GetWorkspaceSSHConnectionInfoAs(context.Background(), wsID, 101, 1, "postgres")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeWorkspaceSSHUserInvalid, apiErr.Code)
	assert.Equal(t, 1, grants, "no grant is minted for a refused user")
}
