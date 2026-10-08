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

type nativeWakeBoundaryRuntime struct{ *wakeBoundaryRuntime }

func (*nativeWakeBoundaryRuntime) EnsureMachined(context.Context, string) error {
	return errors.New("daemon unavailable")
}

func (r *wakeBoundaryRuntime) InspectWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	r.inspections++
	return workspaceapi.Workspace{}, errors.New("guest unavailable")
}
func TestTodoWakeReReadsBindingAndControlsBeforeMachineEffects(t *testing.T) {
	for _, mode := range []string{"active", "review", "starting", "starting_unbound", "starting_legacy", "review_stale_candidate", "review_stale_head", "review_settled", "review_wrong_lane", "review_working", "review_paused", "retired", "paused", "landed", "dropped", "cancelled", "wrong_lane", "wrong_workspace", "item_unavailable", "lane_unavailable", "deleted", "pending"} {
		t.Run(mode, func(t *testing.T) {
			id := uuid.New()
			row := db.Workspace{ID: "retained", RepositoryID: 3, UserID: 9, Status: "suspended"}
			q := &todoWakeStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return row, nil },
				getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return row, nil },
			}, item: db.MythicalItem{ID: pgtype.UUID{Bytes: id, Valid: true}, RepositoryID: 3, WorkspaceID: row.ID, State: "proposed"}}
			q.lane = db.MythicalLane{ItemID: q.item.ID, RepositoryID: 3, WorkspaceID: row.ID}
			if mode == "review" || len(mode) > 7 && mode[:7] == "review_" {
				q.item.WorkspaceID = "implementer"
				q.item.CandidateHead, q.item.PRHead = "candidate", "published"
				checks := mythicalChecksOf(q.item)
				checks.Review = &mythicalReview{Lane: row.ID, Candidate: "candidate", Head: "published"}
				switch mode {
				case "review_working":
					q.item.State = "running"
				case "review_paused":
					q.item.PausedAt.Valid = true
				case "review_stale_candidate":
					checks.Review.Candidate = "old"
				case "review_stale_head":
					checks.Review.Head = "old"
				case "review_settled":
					checks.Review.Verdict = "approve"
				case "review_wrong_lane":
					checks.Review.Lane = "unrelated"
				}
				q.item.Checks = checks.encode()
			}
			switch mode {
			case "retired":
				q.lane.RetiredAt.Valid = true
			case "deleted":
				row.DeletedAt.Valid = true
			case "pending":
				row.Status = "pending"
			case "starting", "starting_unbound", "starting_legacy":
				row.Status, row.VmID = "starting", row.ID
				if mode == "starting_unbound" {
					row.VmID = ""
				}
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
			var provider workspaceapi.WorkspaceRuntime = runtime
			if mode == "starting" || mode == "starting_unbound" {
				provider = &nativeWakeBoundaryRuntime{runtime}
			}
			service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(provider))
			require.Error(t, service.WakeTodoWorkspace(context.Background(), id.String(), row.ID, 3, 9))
			if mode == "active" || mode == "review" || mode == "starting" {
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
