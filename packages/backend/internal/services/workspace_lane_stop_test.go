package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// laneStopRuntime records the lifecycle calls a lane retirement makes. Every
// other runtime method is absent: a retirement must make no other call.
type laneStopRuntime struct {
	workspaceapi.WorkspaceRuntime
	stops, deletes []string
	stopErr        error
}

func (r *laneStopRuntime) StopWorkspace(_ context.Context, id string) error {
	r.stops = append(r.stops, id)
	return r.stopErr
}

func (r *laneStopRuntime) DeleteWorkspace(_ context.Context, id string) error {
	r.deletes = append(r.deletes, id)
	return nil
}

func laneStopService(t *testing.T, row *db.Workspace, lookupErr error) (*WorkspaceService, *laneStopRuntime, *stopWorkspaceStore) {
	t.Helper()
	q := &stopWorkspaceStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return *row, lookupErr }
	q.softDeleteWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		t.Fatal("a retired lane is never deleted")
		return db.Workspace{}, nil
	}
	q.stop = func(context.Context, string) (db.StopWorkspaceRetainingRowRow, error) {
		row.Status = "stopped"
		return db.StopWorkspaceRetainingRowRow(*row), nil
	}
	runtime := &laneStopRuntime{}
	return newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime)), runtime, q
}

// A retired lane's machine stops, so it holds no capacity slot, and keeps its
// row and disk: nothing is deleted. A second retirement of the stopped lane
// touches nothing.
func TestRetiredLaneStopsItsMachineAndKeepsItsDisk(t *testing.T) {
	row := sampleDBWorkspace("lane")
	row.Status = "running"
	row.HeadPushTokenID = pgtype.Int8{Int64: 7, Valid: true}
	svc, runtime, q := laneStopService(t, &row, nil)
	revoked := 0
	q.deleteAccessTokenFn = func(context.Context, db.DeleteAccessTokenParams) error {
		revoked++
		return nil
	}
	require.NoError(t, svc.StopLaneMachine(context.Background(), row.RepositoryID, row.ID))
	require.Equal(t, []string{"lane"}, runtime.stops)
	require.Empty(t, runtime.deletes, "the disk stays")
	require.Equal(t, "stopped", row.Status)
	require.False(t, row.DeletedAt.Valid)
	require.Equal(t, 1, revoked, "the lane's push credential ends with its execution")

	require.NoError(t, svc.StopLaneMachine(context.Background(), row.RepositoryID, row.ID))
	require.Equal(t, []string{"lane"}, runtime.stops, "a stopped lane is not stopped again")
}

// Only a running machine is stopped. One still starting refuses, so the stack
// retries the retirement; one asleep, failed, deleted, missing or of another
// repository is left as it is.
func TestRetiredLaneStopTouchesOnlyARunningMachine(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     string
		repository int64
		deleted    bool
		lookupErr  error
		err        error
	}{
		{name: "pending", status: "pending", err: errLaneMachineStarting},
		{name: "starting", status: "starting", err: errLaneMachineStarting},
		{name: "suspended", status: "suspended"},
		{name: "stopped", status: "stopped"},
		{name: "failed", status: "failed"},
		{name: "deleted", status: "running", deleted: true},
		{name: "other repository", status: "running", repository: 999},
		{name: "missing", status: "running", lookupErr: pgx.ErrNoRows},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := sampleDBWorkspace("lane")
			row.Status, row.DeletedAt.Valid = tc.status, tc.deleted
			svc, runtime, q := laneStopService(t, &row, tc.lookupErr)
			q.stop = func(context.Context, string) (db.StopWorkspaceRetainingRowRow, error) {
				t.Fatal("the row is left as it is")
				return db.StopWorkspaceRetainingRowRow{}, nil
			}
			repository := row.RepositoryID
			if tc.repository != 0 {
				repository = tc.repository
			}
			err := svc.StopLaneMachine(context.Background(), repository, row.ID)
			if tc.err != nil {
				require.ErrorIs(t, err, tc.err)
			} else {
				require.NoError(t, err)
			}
			require.Empty(t, runtime.stops)
			require.Empty(t, runtime.deletes)
		})
	}
}

// A machine that fails to stop keeps its row running and reports the
// failure, so the retirement is retried; the retry stops it.
func TestRetiredLaneStopFailureIsRetried(t *testing.T) {
	row := sampleDBWorkspace("lane")
	row.Status = "running"
	svc, runtime, _ := laneStopService(t, &row, nil)
	runtime.stopErr = errors.New("msb stop timed out")
	require.Error(t, svc.StopLaneMachine(context.Background(), row.RepositoryID, row.ID))
	require.Equal(t, "running", row.Status)
	runtime.stopErr = nil
	require.NoError(t, svc.StopLaneMachine(context.Background(), row.RepositoryID, row.ID))
	require.Equal(t, "stopped", row.Status)
	require.Equal(t, []string{"lane", "lane"}, runtime.stops)
}

// Without a workspace runtime nothing can stop a machine and keep its disk:
// the lane is retained untouched, as before.
func TestRetiredLaneWithoutARuntimeIsRetained(t *testing.T) {
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
		t.Fatal("no lookup without a runtime")
		return db.Workspace{}, nil
	}}
	require.NoError(t, newWorkspaceServiceForTests(q).StopLaneMachine(context.Background(), 101, "lane"))
	require.NoError(t, (&workspaceMythicalLanes{workspaces: newWorkspaceServiceForTests(q)}).Delete(context.Background(), 101, 1, "lane"))
}
