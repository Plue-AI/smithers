package services

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type fakeWorkspaceCount struct{ n int64 }

func (f *fakeWorkspaceCount) get() int64  { return atomic.LoadInt64(&f.n) }
func (f *fakeWorkspaceCount) set(n int64) { atomic.StoreInt64(&f.n, n) }
func (f *fakeWorkspaceCount) inc()        { atomic.AddInt64(&f.n, 1) }
func (f *fakeWorkspaceCount) dec()        { atomic.AddInt64(&f.n, -1) }

func quotaTestQuerier(t *testing.T, counter *fakeWorkspaceCount) *mockWorkspaceQuerier {
	t.Helper()

	return &mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(ctx context.Context, userID int64) (int64, error) {
			assert.Equal(t, int64(42), userID)
			return counter.get(), nil
		},
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			counter.inc()
			workspace := sampleDBWorkspace("ws-" + arg.Name)
			workspace.Name = arg.Name
			workspace.UserID = arg.UserID
			workspace.Status = arg.Status
			return workspace, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
		softDeleteWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
			counter.dec()
			workspace := sampleDBWorkspace(id)
			workspace.Status = "stopped"
			return workspace, nil
		},
	}
}

func quotaTestSandbox() *mockWorkspaceSandboxVMClient {
	return &mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-quota"}, nil
		},
		forkVMFn: func(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-quota-fork"}, nil
		},
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error { return nil },
	}
}

func TestWorkspaceService_CreateWorkspace_EnforcesQuotaBoundary(t *testing.T) {
	t.Parallel()

	counter := &fakeWorkspaceCount{}
	counter.set(MaxActiveWorkspacesPerUser - 1)

	svc := newWorkspaceServiceForTests(quotaTestQuerier(t, counter), WithWorkspaceSandboxClient(quotaTestSandbox()))

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 1,
		UserID:       42,
		Name:         "ws-100",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), counter.get())

	_, err = svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 2,
		UserID:       42,
		Name:         "ws-101",
	})
	require.Error(t, err)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), counter.get())
}

func TestWorkspaceService_DeleteWorkspace_FreesQuotaSlot(t *testing.T) {
	t.Parallel()

	counter := &fakeWorkspaceCount{}
	counter.set(MaxActiveWorkspacesPerUser)

	q := quotaTestQuerier(t, counter)
	q.getWorkspaceByRepoFn = func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		workspace := sampleDBWorkspace(arg.ID)
		workspace.UserID = 42 // matches the DeleteWorkspace / CreateWorkspace caller below
		return workspace, nil
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(quotaTestSandbox()))

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 1,
		UserID:       42,
		Name:         "pre-delete",
	})
	require.Error(t, err)

	require.NoError(t, svc.DeleteWorkspace(context.Background(), "ws-existing", 1, 42))
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser-1), counter.get())

	_, err = svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 1,
		UserID:       42,
		Name:         "post-delete",
	})
	require.NoError(t, err)
}

func TestWorkspaceService_CreateWorkspace_ReusePathDoesNotCountAgainstQuota(t *testing.T) {
	t.Parallel()

	counter := &fakeWorkspaceCount{}
	counter.set(MaxActiveWorkspacesPerUser)

	existing := sampleDBWorkspace("ws-primary")
	existing.UserID = 42
	existing.RepositoryID = 1
	existing.Status = "running"
	existing.VmID = "vm-existing"
	existing.Name = "reuse"

	createCalls := int64(0)
	q := quotaTestQuerier(t, counter)
	q.getActiveWorkspaceForIdentityFn = func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
		if arg.RepositoryID == 1 && arg.UserID == 42 {
			return existing, nil
		}
		return db.Workspace{}, pgx.ErrNoRows
	}
	q.createWorkspaceFn = func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
		atomic.AddInt64(&createCalls, 1)
		counter.inc()
		return sampleDBWorkspace("ws-new"), nil
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(quotaTestSandbox()))

	ws, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 1,
		UserID:       42,
		Name:         "reuse",
	})
	require.NoError(t, err)
	assert.Equal(t, existing.ID, ws.ID)
	assert.Equal(t, int64(0), atomic.LoadInt64(&createCalls))
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), counter.get())
}

func TestWorkspaceService_ForkWorkspace_EnforcesQuotaBoundary(t *testing.T) {
	t.Parallel()

	counter := &fakeWorkspaceCount{}
	counter.set(MaxActiveWorkspacesPerUser - 1)

	source := sampleDBWorkspace("ws-source")
	source.UserID = 42
	source.RepositoryID = 1
	source.Status = "running"
	source.VmID = "vm-source"

	q := quotaTestQuerier(t, counter)
	// loadOwnedWorkspace (called by ForkWorkspace) uses GetWorkspaceByRepo,
	// not GetWorkspaceForUserRepo. Ownership is checked after the load.
	q.getWorkspaceByRepoFn = func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		assert.Equal(t, source.ID, arg.ID)
		assert.Equal(t, source.RepositoryID, arg.RepositoryID)
		return source, nil
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(quotaTestSandbox()))

	_, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: source.RepositoryID,
		UserID:       source.UserID,
		WorkspaceID:  source.ID,
		Name:         "fork-100",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), counter.get())

	_, err = svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{
		RepositoryID: source.RepositoryID,
		UserID:       source.UserID,
		WorkspaceID:  source.ID,
		Name:         "fork-101",
	})
	require.Error(t, err)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
	assert.Equal(t, int64(MaxActiveWorkspacesPerUser), counter.get())
}
