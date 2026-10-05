package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Runtime recording is deliberate: these guards must refuse before any machine
// effect. The composed retention case below uses real PostgreSQL.
type todoRetentionStore struct {
	*mockWorkspaceQuerier
	lane   db.MythicalLane
	err    error
	lookup func()
}

func (q *todoRetentionStore) GetMythicalLane(context.Context, string) (db.MythicalLane, error) {
	if q.lookup != nil {
		q.lookup()
	}
	return q.lane, q.err
}

func TestTodoLongWaitRetainsDiskAndBinding(t *testing.T) {
	for _, tc := range []struct {
		name      string
		retired   bool
		err       error
		reclaimed bool
	}{
		{name: "unmerged"}, {name: "retired_without_capture", retired: true},
		{name: "binding_unavailable", err: errors.New("database unavailable")},
		{name: "ordinary_agent", err: pgx.ErrNoRows},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := db.Workspace{ID: "todo-machine", Kind: "agent", Status: "suspended"}
			q := &todoRetentionStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}, err: tc.err}
			q.lane.WorkspaceID = row.ID
			q.lane.RetiredAt.Valid = tc.retired
			runtime := &diskReclaimRuntime{}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			err := svc.CleanupStoppedAgentWorkspaceDisks(context.Background())
			require.NoError(t, err)
			require.Equal(t, tc.reclaimed, len(runtime.reclaimed) == 1)
			if !tc.reclaimed {
				lanes := &workspaceMythicalLanes{workspaces: svc}
				// Retiring an asleep lane succeeds and touches nothing: the disk stays.
				require.NoError(t, lanes.Delete(context.Background(), 0, 0, row.ID))
				require.Empty(t, runtime.reclaimed)
				require.Equal(t, row.ID, q.lane.WorkspaceID)
				if tc.err == nil {
					require.ErrorIs(t, svc.FailAgentWorkspace(context.Background(), row.ID), errTodoWorkspaceRetained)
				}
			}
		})
	}
}

func TestTodoLongWaitMissingBindingAuthorityRetainsDisk(t *testing.T) {
	runtime := &diskReclaimRuntime{}
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
		return db.Workspace{ID: "waiting", Kind: "agent", Status: "suspended"}, nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(context.Background()))
	require.Empty(t, runtime.reclaimed)
}

func TestTodoLongWaitStaleSweepReReadsAfterResume(t *testing.T) {
	row := db.Workspace{ID: "waiting", Kind: "agent", Status: "suspended"}
	q := &todoRetentionStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}, lookup: func() { t.Fatal("resumed row must not reach binding lookup") }}
	runtime := &diskReclaimRuntime{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	// Dark cleanup needs no lifecycle authority and cannot race a resume. A
	// retirement stops a running lane by design (StopLaneMachine); the sweep
	// re-reads the item first, so a lane its item took back is never retired.
	row.Status = "running"
	require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(context.Background()))
	require.Empty(t, runtime.reclaimed)
	require.Equal(t, "running", row.Status, "dark cleanup must not suspend resumed work")
}

func TestTodoLongWaitComposedReclaimKeepsBoundDisk(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	q := db.New(pool)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: "waiting TODO", Kind: "agent", Status: "suspended", TargetBookmark: "main", EnvironmentSource: defaultWorkspaceEnvironmentSource})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET suspended_at=NOW()-INTERVAL '25 hours' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, WorkspaceID: row.ID, IssueTitle: "retain notes", CandidateBase: "base", CandidateHead: "pinned", RequestRunID: "same-run"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo, ItemID: item.ID, Name: "todo lane"})
	require.NoError(t, err)
	runtime := &diskReclaimRuntime{}
	svc := NewWorkspaceService(q, WithWorkspaceRuntime(runtime))
	for _, state := range []string{"proposed", "blocked", "landed", "cancelled"} {
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2 WHERE id=$1`, item.ID, state)
		require.NoError(t, err)
		require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(ctx))
		require.Empty(t, runtime.reclaimed, "settlement without verified capture never permits deletion")
		require.ErrorIs(t, svc.DeleteWorkspace(ctx, row.ID, repo, user), errTodoWorkspaceRetained)
		current, err := q.GetWorkspace(ctx, row.ID)
		require.NoError(t, err)
		require.False(t, current.DeletedAt.Valid)
		lane, err := q.GetMythicalLane(ctx, row.ID)
		require.NoError(t, err)
		require.False(t, lane.RetiredAt.Valid)
	}
	require.NoError(t, q.RetireMythicalLane(ctx, row.ID))
	require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(ctx))
	require.Empty(t, runtime.reclaimed)
}
