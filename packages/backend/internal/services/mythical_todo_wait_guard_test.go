package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Literal source permissions supplement the composed HTTP regression. The
// expectation never reads the production guard or spec at runtime.
func TestTodoRunWaitLiteralSources(t *testing.T) {
	cases := []struct {
		state string
		asks  bool
	}{
		{"queued", false}, {"skipped", false}, {"running", true}, {"delivering", true},
		{"integrating", true}, {"verifying", true}, {"proposing", true}, {"waiting", true},
		{"retrying", true}, {"proposed", false}, {"landed", false}, {"blocked", false},
		{"cancelled", false}, {"rejected", false}, {"declined", false},
	}
	now := time.Unix(100, 0).UTC()
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
		FlowID: "todo", RunID: "bound-run", Run: &flowruntime.Run{RunID: "bound-run", PendingWaits: []flowruntime.PendingWait{
			{RunID: "plan-child", Token: "ask-token", Name: "choice", Request: json.RawMessage(`{"kind":"ask","prompt":"Which helper?"}`)},
		}},
	}}
	question, ok := todoQuestionWait(update.Checkpoint.Run.PendingWaits[0], update, "bound-run", now)
	require.True(t, ok)
	count := 0
	for _, c := range cases {
		for _, paused := range []bool{false, true} {
			for _, existing := range []bool{false, true} {
				checks := mythicalChecks{RunLaunched: true, RunAttached: true, Waits: []TodoWait{{ID: "foreign", Kind: "foreign_push", Since: now}}}
				if existing {
					checks.Waits = append(checks.Waits, question)
				}
				item := db.MythicalItem{State: c.state, RequestRunID: "bound-run", PausedAt: pgtype.Timestamptz{Time: now, Valid: paused}, Checks: checks.encode()}
				mythicalProjectWaits(&item, mythicalProjection{Phase: "todo"}, update, "bound-run", now)
				stored := mythicalChecksOf(item).Waits
				want := 1
				if existing || (c.asks && !paused) {
					want = 2
				}
				require.Len(t, stored, want, "state=%s paused=%v existing=%v", c.state, paused, existing)
				require.Equal(t, checks.Waits[0], stored[0], "the independent branch wait stays untouched")
				if existing {
					require.Equal(t, question, stored[1], "a reported existing question is not withdrawn")
				}
				count++
			}
		}
	}
	require.Equal(t, 60, count)
	t.Logf("literal run-wait source cases: %d", count)
}
