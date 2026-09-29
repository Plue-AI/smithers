package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestWorkspaceService_CreateSession_RejectsForeignWorkspaceID(t *testing.T) {
	t.Parallel()

	created := false
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			assert.Equal(t, "ws-foreign", arg.ID)
			assert.Equal(t, int64(101), arg.RepositoryID)
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			created = true
			return db.WorkspaceSession{}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       7,
		WorkspaceID:  "ws-foreign",
	})
	require.Error(t, err)
	assert.False(t, created)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 404, apiErr.Status)
}

func TestWorkspaceService_CreateSession_ReplacesStalePendingWorkspaceWithoutVM(t *testing.T) {
	t.Parallel()

	var (
		countCalls        int
		listCalls         int
		updatedStatuses   []string
		createdWorkspaces int
		sessionWorkspace  string
	)

	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			countCalls++
			return 1, nil
		},
		listWorkspacesByRepoFn: func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			listCalls++
			workspace := sampleUnnamedDBWorkspace("ws-stale")
			workspace.Status = "starting"
			workspace.VmID = ""
			workspace.UpdatedAt = time.Now().Add(-6 * time.Minute)
			return []db.Workspace{workspace}, nil
		},
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			createdWorkspaces++
			workspace := sampleUnnamedDBWorkspace("ws-fresh")
			workspace.VmID = ""
			workspace.Status = "starting"
			return workspace, nil
		},
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			sessionWorkspace = arg.WorkspaceID
			return db.WorkspaceSession{ID: "sess-1", WorkspaceID: arg.WorkspaceID, RepositoryID: arg.RepositoryID, UserID: arg.UserID, Status: "pending"}, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleUnnamedDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updatedStatuses = append(updatedStatuses, arg.Status)
			workspace := sampleUnnamedDBWorkspace(arg.ID)
			workspace.VmID = ""
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fresh"}, nil
		},
	}))

	session, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.NoError(t, err)
	assert.Equal(t, 1, countCalls)
	assert.Equal(t, 1, listCalls)
	assert.Equal(t, []string{"failed"}, updatedStatuses)
	assert.Equal(t, 1, createdWorkspaces)
	assert.Equal(t, "ws-fresh", sessionWorkspace)
	assert.Equal(t, "running", session.Status)
}

func TestWorkspaceService_CreateSession_MarksFailedWhenProvisionFails(t *testing.T) {
	t.Parallel()

	var (
		statuses   []string
		updatedIDs []string
	)

	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 0, nil
		},
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace("ws-new")
			workspace.Status = "starting"
			workspace.VmID = ""
			return workspace, nil
		},
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{
				ID:           "sess-1",
				WorkspaceID:  arg.WorkspaceID,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				Status:       "pending",
			}, nil
		},
		updateWorkspaceSessionStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			statuses = append(statuses, arg.Status)
			updatedIDs = append(updatedIDs, arg.ID)
			return db.WorkspaceSession{ID: arg.ID, WorkspaceID: "ws-new", RepositoryID: 101, UserID: 1, Status: arg.Status}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, assert.AnError
		},
	}))

	_, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Equal(t, []string{"failed"}, statuses)
	assert.Equal(t, []string{"sess-1"}, updatedIDs)
}

func TestWorkspaceService_CreateSession_ReusesWinnerWhenActivationConflicts(t *testing.T) {
	t.Parallel()

	var (
		deletedVMs          []string
		statuses            []string
		getActiveRuns       int
		sessionWorkspaceIDs []string
		createdSessions     int
	)

	winning := sampleUnnamedDBWorkspace("ws-winning")
	winning.VmID = "vm-winning"
	winning.Status = "running"

	q := &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 0, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			workspace := sampleUnnamedDBWorkspace("ws-race")
			workspace.VmID = ""
			workspace.Status = "starting"
			return workspace, nil
		},
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			getActiveRuns++
			if getActiveRuns == 1 {
				return db.Workspace{}, pgx.ErrNoRows
			}
			return winning, nil
		},
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			return db.Workspace{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			statuses = append(statuses, arg.Status)
			workspace := sampleUnnamedDBWorkspace(arg.ID)
			workspace.Status = arg.Status
			workspace.VmID = ""
			return workspace, nil
		},
		createWorkspaceSessionFn: func(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error) {
			createdSessions++
			sessionWorkspaceIDs = append(sessionWorkspaceIDs, arg.WorkspaceID)
			sessionID := "sess-race"
			if createdSessions > 1 {
				sessionID = "sess-winning"
			}
			return db.WorkspaceSession{
				ID:           sessionID,
				WorkspaceID:  arg.WorkspaceID,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				Status:       "pending",
			}, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-race"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}))

	session, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.NoError(t, err)
	assert.Equal(t, "sess-winning", session.ID)
	assert.Equal(t, []string{"ws-race", winning.ID}, sessionWorkspaceIDs)
	assert.Equal(t, 2, createdSessions)
	assert.Equal(t, []string{"vm-race"}, deletedVMs)
	assert.Equal(t, []string{"failed"}, statuses)
	assert.Equal(t, 2, getActiveRuns)
}
