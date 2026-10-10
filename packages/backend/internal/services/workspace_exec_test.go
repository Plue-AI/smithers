package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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

func TestWorkspaceService_CreateSession_MarksFailedWhenProvisionFails(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, assert.AnError
		},
	}))

	_, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: f.repo,
		UserID:       f.user,
	})
	require.Error(t, err)
	assert.Equal(t, []string{"failed"}, f.sessionStatuses(t, "main"))
}

func TestWorkspaceService_CreateSession_ReusesWinnerWhenActivationConflicts(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	winning := f.machine(t, db.CreateWorkspaceParams{TargetBookmark: "winner", Status: "running"})
	f.exec(t, `UPDATE workspaces SET vm_id='vm-winning' WHERE id=$1`, winning.ID)
	winning, err := f.q.GetWorkspace(context.Background(), winning.ID)
	require.NoError(t, err)
	store := &activationConflictQuerier{Queries: f.q, winner: winning}

	var deletedVMs []string
	svc := f.service(store, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-race"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}))

	session, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.NoError(t, err)
	assert.Equal(t, winning.ID, session.WorkspaceID, "the session moves to the winning machine")
	assert.Equal(t, "running", session.Status)
	assert.Equal(t, []string{"failed"}, f.sessionStatuses(t, "main"), "the losing machine's session is failed")
	assert.Equal(t, []string{"vm-race"}, deletedVMs)
	assert.Equal(t, 1, store.lookups)
	lost := f.branch(t, "main")
	require.Len(t, lost, 1)
	assert.Equal(t, "failed", lost[0].Status)
}

// A session opened on a branch whose machine was left pending with no VM
// provisions that machine in place. de86a86992 (#3565) replaced the
// per-requester stale-row replacement with one canonical machine per branch.
func TestWorkspaceService_CreateSession_ProvisionsStalePendingBranchMachineInPlace(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)
	stale := f.machine(t, db.CreateWorkspaceParams{TargetBookmark: "main", Status: "starting"})
	f.exec(t, `UPDATE workspaces SET updated_at=$2 WHERE id=$1`, stale.ID, time.Now().Add(-workspaceStaleAfter-time.Minute))

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fresh"}, nil
		},
	}))

	session, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.NoError(t, err)
	assert.Equal(t, stale.ID, session.WorkspaceID)
	assert.Equal(t, "running", session.Status)
	rows := f.branch(t, "main")
	require.Len(t, rows, 1)
	assert.Equal(t, "vm-fresh", rows[0].VmID)
	assert.Equal(t, "running", rows[0].Status)
}
