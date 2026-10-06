package services

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"testing"
)

type todoWakeStore struct {
	*mockWorkspaceQuerier
	item             db.MythicalItem
	lane             db.MythicalLane
	itemErr, laneErr error
}

func (q *todoWakeStore) GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error) {
	return q.item, q.itemErr
}
func (q *todoWakeStore) GetMythicalLane(context.Context, string) (db.MythicalLane, error) {
	return q.lane, q.laneErr
}

type wakeBoundaryRuntime struct {
	workspaceapi.WorkspaceRuntime
	inspections int
}

func (r *wakeBoundaryRuntime) InspectWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	r.inspections++
	return workspaceapi.Workspace{}, errors.New("guest unavailable")
}
func TestTodoWakeReReadsBindingAndControlsBeforeMachineEffects(t *testing.T) {
	for _, mode := range []string{"active", "paused", "landed", "dropped", "cancelled", "wrong_lane", "wrong_workspace", "item_unavailable", "lane_unavailable", "deleted", "pending"} {
		t.Run(mode, func(t *testing.T) {
			id := uuid.New()
			row := db.Workspace{ID: "retained", RepositoryID: 3, UserID: 9, Status: "suspended"}
			q := &todoWakeStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return row, nil },
				getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return row, nil },
			}, item: db.MythicalItem{ID: pgtype.UUID{Bytes: id, Valid: true}, RepositoryID: 3, WorkspaceID: row.ID, State: "proposed"}}
			q.lane = db.MythicalLane{ItemID: q.item.ID, RepositoryID: 3, WorkspaceID: row.ID}
			switch mode {
			case "deleted":
				row.DeletedAt.Valid = true
			case "pending":
				row.Status = "pending"
			case "paused":
				q.item.PausedAt.Valid = true
			case "landed", "dropped", "cancelled":
				q.item.State = mode
			case "wrong_lane":
				q.lane.ItemID.Bytes = uuid.New()
			case "wrong_workspace":
				q.item.WorkspaceID = "replacement"
			case "item_unavailable":
				q.itemErr = errors.New("offline")
			case "lane_unavailable":
				q.laneErr = errors.New("offline")
			}
			runtime := &wakeBoundaryRuntime{}
			service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			require.Error(t, service.WakeTodoWorkspace(context.Background(), id.String(), row.ID, 3, 9))
			if mode == "active" {
				require.Equal(t, 1, runtime.inspections)
			} else {
				require.Zero(t, runtime.inspections)
			}
		})
	}
}

func TestTodoWakeSettlementWhileWaitingForLifecycleLock(t *testing.T) {
	id := uuid.New()
	row := db.Workspace{ID: "retained", RepositoryID: 3, UserID: 9, Status: "suspended"}
	loaded := make(chan struct{})
	q := &todoWakeStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			close(loaded)
			return row, nil
		},
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil },
	}, item: db.MythicalItem{ID: pgtype.UUID{Bytes: id, Valid: true}, RepositoryID: 3, WorkspaceID: row.ID, State: "proposed"}}
	q.lane = db.MythicalLane{ItemID: q.item.ID, RepositoryID: 3, WorkspaceID: row.ID}
	runtime := &wakeBoundaryRuntime{}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	unlock := service.lockRuntimeWorkspace(row.ID)
	done := make(chan error, 1)
	go func() { done <- service.WakeTodoWorkspace(context.Background(), id.String(), row.ID, 3, 9) }()
	<-loaded
	q.item.State = "landed"
	unlock()
	code, retryable := runtimeFailureOf(t, <-done)
	require.Equal(t, "runtime_run_terminal", code)
	require.False(t, retryable)
	require.Zero(t, runtime.inspections)
}
