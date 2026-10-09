package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoResumeRestoresWorkingAfterPausedRebuild(t *testing.T) {
	for _, tc := range []struct{ name, before, stopped, outcome, want string }{
		{"integrating", "integrating", "running", "", "running"},
		{"verifying", "verifying", "running", "", "running"},
		{"proposing", "proposing", "running", "", "running"},
		{"waiting", "waiting", "running", "", "running"},
		{"proposed", "proposed", "running", "", "running"},
		{"waiting-stop", "verifying", "waiting", "", "running"},
		{"review-stop", "proposed", "proposed", "", "proposed"},
		{"failed", "blocked", "running", "failed", "blocked"},
		{"settled-composition", "verifying", "running", "submitted", "verifying"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checks := mythicalChecks{RunLaunched: true, Pause: &todoPause{State: tc.stopped, Run: "retained-run", Requested: true, Resuming: true, Delivered: true}}
			item := db.MythicalItem{State: tc.before, RequestRunID: "retained-run", RequestOutcome: tc.outcome, WorkspaceID: "branch", Checks: checks.encode(), PRState: "open", PRNumber: pgtype.Int8{Int64: 1, Valid: true}}
			projectTodoPause(&item, mythicalProjection{Phase: "todo"}, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Target: flowruntime.Target{WorkspaceID: "branch"}, Run: &flowruntime.Run{RunID: "retained-run", Status: "running"}}}, time.Now())
			require.Equal(t, tc.want, item.State)
			require.True(t, mythicalChecksOf(item).RunAttached)
			require.False(t, mythicalChecksOf(item).Pause.Resuming)
			require.Equal(t, "retained-run", item.RequestRunID)
			if tc.want == "running" {
				require.Equal(t, "working", todoState(item))
			}
		})
	}
}

// Storage and card projection are real; only VM ownership is injected here.
type resumedCardOwnership struct {
	*fakeMythicalLanes
	held bool
	err  error
}

func (l *resumedCardOwnership) MachineHeld(context.Context, string) (bool, error) {
	return l.held, l.err
}

func TestResumedTodoCardRequiresConfirmedGrant(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "Retained resume")
	q := db.New(o.pool)
	workspace, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: o.userID, Name: "Retained", TargetBookmark: "mythical", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	_, err = o.pool.Exec(t.Context(), `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'todo')`, workspace.ID, o.repoID, item.ID)
	require.NoError(t, err)
	item.State, item.WorkspaceID, item.RequestRunID = "running", workspace.ID, "retained-run"
	lanes := &resumedCardOwnership{fakeMythicalLanes: o.lanes}
	o.service.lanes = lanes
	for _, tc := range []struct {
		name           string
		held, resuming bool
		err            error
		want           string
	}{
		{"waiting", false, true, nil, "queued"},
		{"granted", true, true, nil, "starting"},
		{"unknown ownership", true, true, errors.New("release unconfirmed"), "queued"},
		{"known but released", false, true, nil, "queued"},
		{"paused holder", true, false, nil, "paused"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lanes.held, lanes.err = tc.held, tc.err
			item.Checks = mythicalChecks{Todo: true, RunLaunched: true, Pause: &todoPause{Run: item.RequestRunID, Requested: true, Resuming: tc.resuming}}.encode()
			item.PausedAt.Valid = !tc.resuming
			item.PausedAt.Time = time.Now()
			item, err = q.SaveMythicalItem(t.Context(), item)
			require.NoError(t, err)
			card, err := o.service.Todo(session, o.repoID, item.Number.Int64)
			require.NoError(t, err)
			require.Equal(t, tc.want, card["state"])
			require.False(t, mythicalChecksOf(item).RunAttached, "ownership never certifies the current run attachment")
		})
	}
}
