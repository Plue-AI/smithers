package services

import (
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
