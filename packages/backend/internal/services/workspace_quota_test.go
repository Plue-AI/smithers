package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceService_DeleteWorkspace_FreesQuotaSlot(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	ctx := context.Background()
	rows := personWorkspaces(t, f, MaxActiveWorkspacesPerUser)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	requireAPIErrorStatus(t, svc.enforceWorkspaceQuota(ctx, f.user), 429)

	require.NoError(t, svc.DeleteWorkspace(ctx, rows[0].ID, f.repo, f.user))
	count, err := f.q.CountActiveWorkspacesByUser(ctx, f.user)
	require.NoError(t, err)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser-1), count)
	require.NoError(t, svc.enforceWorkspaceQuota(ctx, f.user))
	_, err = f.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repo, UserID: f.user, Name: "post-delete", TargetBookmark: "person/quota", Kind: "container", Status: "running"})
	require.NoError(t, err, "the freed slot admits the next workspace")
}

func TestWorkspaceService_CreateWorkspace_ReusePathDoesNotCountAgainstQuota(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	personWorkspaces(t, f, MaxActiveWorkspacesPerUser)
	existing := f.machine(t, db.CreateWorkspaceParams{Name: "reuse", TargetBookmark: "reuse", Status: "running"})
	f.exec(t, `UPDATE workspaces SET vm_id='vm-existing' WHERE id=$1`, existing.ID)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Error("a reused machine never creates a VM")
			return sandbox.CreateResult{}, nil
		},
	}))

	ws, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID:   f.repo,
		UserID:         f.user,
		Name:           "reuse",
		SourceBookmark: "reuse",
	})
	require.NoError(t, err)
	assert.Equal(t, existing.ID, ws.ID)
	assert.Len(t, f.branch(t, "reuse"), 1)
	count, err := f.q.CountActiveWorkspacesByUser(context.Background(), f.user)
	require.NoError(t, err)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), count)
}

// A fork checks the source's quota before the stack's revision writer runs,
// and a refused fork never reaches the writer.
func TestWorkspaceService_ForkWorkspace_EnforcesQuotaBoundary(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	rows := personWorkspaces(t, f, MaxActiveWorkspacesPerUser-1)
	source := rows[0]

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	forks := 0
	svc.revisionFork = func(ctx context.Context, src db.Workspace, input ForkWorkspaceInput) (WorkspaceResponse, error) {
		forks++
		child, err := f.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repo, UserID: src.UserID, Name: input.Name, TargetBookmark: "person/quota", Kind: "container", Status: "running"})
		if err != nil {
			return WorkspaceResponse{}, err
		}
		return WorkspaceResponse{ID: child.ID, IsFork: true, ParentWorkspaceID: src.ID}, nil
	}

	_, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		WorkspaceID:  source.ID,
		Name:         "fork-100",
	})
	require.NoError(t, err)
	assert.Equal(t, 1, forks)

	_, err = svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		WorkspaceID:  source.ID,
		Name:         "fork-101",
	})
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
	assert.Equal(t, 1, forks, "a refused fork never reaches the revision writer")
}

// personWorkspaces gives the fixture's person n workspaces of their own, the
// rows the per-person cap (trg_workspaces_user_quota) counts.
func personWorkspaces(t *testing.T, f branchMachineFixture, n int) []db.Workspace {
	t.Helper()
	rows := make([]db.Workspace, 0, n)
	for i := range n {
		row, err := f.q.CreateWorkspace(context.Background(), db.CreateWorkspaceParams{
			RepositoryID: f.repo, UserID: f.user, Name: fmt.Sprintf("quota-%d", i), TargetBookmark: "person/quota", Kind: "container", Status: "running",
		})
		require.NoError(t, err)
		rows = append(rows, row)
	}
	return rows
}

// The per-person cap still refuses the person's own workspace past the
// boundary, as quota_exceeded rather than an internal error. A branch machine
// belongs to the machine service, which the cap exempts (0108); de86a86992
// (#3565) dropped the creation pre-check, so a person at the cap still opens a
// branch machine.
func TestWorkspaceService_CreateWorkspace_QuotaBoundaryExemptsTheBranchMachine(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	ctx := context.Background()
	personWorkspaces(t, f, MaxActiveWorkspacesPerUser)

	_, err := f.q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repo, UserID: f.user, Name: "quota-over", TargetBookmark: "person/quota", Kind: "container", Status: "running"})
	require.Error(t, err)
	apiErr, ok := mapWorkspaceCreateError(err, "create workspace").(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
	requireAPIErrorStatus(t, f.service(nil).enforceWorkspaceQuota(ctx, f.user), 429)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	created, err := svc.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: f.repo, UserID: f.user, Name: "machine", SourceBookmark: "feature"})
	require.NoError(t, err)
	owner, err := f.q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	assert.Equal(t, owner, created.UserID)
	count, err := f.q.CountActiveWorkspacesByUser(ctx, f.user)
	require.NoError(t, err)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), count, "the machine is not the person's workspace")
}
