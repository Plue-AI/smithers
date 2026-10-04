package services

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceSSHUserGrantUsesOwnedProductWorkspace(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ssh-owner", LowerUsername: "ssh-owner", DisplayName: "SSH owner"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ssh-other", LowerUsername: "ssh-other", DisplayName: "SSH other"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "ssh", LowerName: "ssh", DefaultBookmark: "main"})
	require.NoError(t, err)
	workspaceID := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,vm_id,status,kind) VALUES($1,$2,$3,'vm-ssh','running','container')`, workspaceID, repo.ID, owner.ID)
	require.NoError(t, err)
	var grants [][]string
	provider := &mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-ssh", State: sandbox.StateRunning}, nil
		},
		grantVMPermissionFn: func(_ context.Context, _, _ string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
			grants = append(grants, append([]string(nil), req.AllowedUsers...))
			return sandbox.AccessGrant{ID: "grant"}, nil
		},
	}
	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(provider), WithWorkspaceSSHHost("ssh.example.test"))
	for _, tc := range []struct{ requested, want string }{{"", "agent"}, {"agent", "agent"}} {
		info, err := svc.GetWorkspaceSSHConnectionInfoAs(ctx, workspaceID, repo.ID, owner.ID, tc.requested)
		require.NoError(t, err)
		require.Equal(t, tc.want, info.Username)
		require.Equal(t, []string{tc.want}, grants[len(grants)-1], "every grant must name exactly the returned SSH user")
	}
	for _, requested := range []string{"root", "developer", "postgres", "root,agent", "root\npostgres"} {
		_, err := svc.GetWorkspaceSSHConnectionInfoAs(ctx, workspaceID, repo.ID, owner.ID, requested)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		require.Equal(t, pkgerrors.CodeWorkspaceSSHUserInvalid, apiErr.Code)
	}
	_, err = svc.GetWorkspaceSSHConnectionInfoAs(ctx, workspaceID, repo.ID, other.ID, "root")
	require.Error(t, err)
	require.Len(t, grants, 2, "invalid user or caller must never mint a provider grant")
	svc.workspaceSSHUsername = "root"
	_, err = svc.GetWorkspaceSSHConnectionInfo(ctx, workspaceID, repo.ID, owner.ID)
	require.Error(t, err)
	require.Len(t, grants, 2, "configured root must never mint a provider grant")
}
