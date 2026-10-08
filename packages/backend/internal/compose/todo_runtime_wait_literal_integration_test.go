package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Expectations are literal permissions, independent of production guard data.
// Enter the production ingestion transaction and read the installed HTTP card;
// a refused question cannot hide behind a passing helper-only guard test.
func TestTodoRuntimeQuestionTransitionLiteralCases(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	cases := []struct {
		engine, state string
		ask           bool
	}{
		{"queued", "queued", false}, {"skipped", "queued", false},
		{"running", "working", true}, {"delivering", "working", true},
		{"integrating", "working", true}, {"verifying", "working", true},
		{"proposing", "working", true}, {"waiting", "working", true},
		{"retrying", "working", true}, {"proposed", "in_review", false},
		{"blocked", "failed", false}, {"landed", "merged", false},
		{"cancelled", "dropped", false}, {"rejected", "dropped", false},
		{"declined", "dropped", false},
	}
	modes := []struct {
		name           string
		paused, branch bool
		attempt        int
		run            string
	}{
		{"plain", false, false, 1, "run-1"},
		{"branch", false, true, 1, "run-1"},
		{"paused", true, false, 1, "run-1"},
		{"prior-attempt", false, false, 2, "run-1"},
		{"wrong-run", false, false, 1, "another-run"},
	}
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&n))
		return n
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		for _, mode := range modes {
			t.Run(c.engine+"/question/"+mode.name, func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": true, "run_attached": true, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
				if mode.branch {
					checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Push", "since": "2026-10-02T12:00:00Z"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2, checks=$3, attempt=1, request_run_id='run-1', request_outcome='', flow_digest='11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e', paused_at=CASE WHEN $4 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, mode.paused)
				require.NoError(t, err)
				projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": target.BindingID, "generation": h.item.Generation, "attempt": mode.attempt, "phase": "todo", "flowDigest": "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e", "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
				require.NoError(t, err)
				update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Scope: scope, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "todo", ExecutionDigest: "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e", Projection: projection, Target: target, RunID: mode.run, Run: &flowruntime.Run{RunID: mode.run, Status: "running", PendingWaits: []flowruntime.PendingWait{{RunID: "step-3", Token: "question-token", Name: "choice", Request: json.RawMessage(`{"kind":"unknown","prompt":"Choose"}`)}}}}}
				// Establish the same receipt/evidence before asking, so the only new fact
				// under test is the incoming HumanTask question.
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				events := count()
				update.Checkpoint.Run = &flowruntime.Run{RunID: mode.run, Status: "running", PendingWaits: []flowruntime.PendingWait{{RunID: "step-3", Token: "question-token", Name: "choice", Request: json.RawMessage(`{"kind":"ask","prompt":"Backoff or fixed delay?"}`)}}}
				valid := update.Checkpoint.Run.PendingWaits[0].Request
				update.Checkpoint.Run.PendingWaits[0].Request = json.RawMessage(`{"kind":"unknown","prompt":"Choose"}`)
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				invalid, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, before, invalid)
				require.Equal(t, events, count())
				update.Checkpoint.Run.PendingWaits[0].Request = valid
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				expected := c.state
				terminal := c.state == "merged" || c.state == "dropped"
				if mode.paused && !terminal {
					expected = "paused"
				}
				if mode.branch && !terminal {
					expected = "needs_you"
				}
				allowed := c.ask && !mode.paused && mode.attempt == 1 && mode.run == "run-1"
				if allowed {
					accepted++
					expected = "needs_you"
					require.Equal(t, events+1, count())
					var facts struct {
						Waits []services.TodoWait `json:"waits"`
					}
					require.NoError(t, json.Unmarshal(after.Checks, &facts))
					require.Len(t, facts.Waits, 1+boolQuestionInt(mode.branch))
					question := facts.Waits[len(facts.Waits)-1]
					require.Equal(t, "question", question.Kind)
					require.Nil(t, question.SettledAt)
					require.Equal(t, "run-1", question.Signal.Run)
					if mode.branch {
						require.Equal(t, "foreign", facts.Waits[0].ID)
						require.Nil(t, facts.Waits[0].SettledAt)
					}
					var data []byte
					require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
					var event map[string]any
					require.NoError(t, json.Unmarshal(data, &event))
					from := c.state
					if mode.branch {
						from = "needs_you"
					}
					require.Equal(t, from, event["from"])
					require.Equal(t, "needs_you", event["to"])
					require.Equal(t, "run-1", event["actor"].(map[string]any)["id"])
				} else {
					refused++
					require.Equal(t, before, after)
					require.Equal(t, events, count())
				}
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, expected, card["state"])
				if allowed && mode.branch {
					require.Equal(t, "foreign_push", card["waits"].([]any)[0].(map[string]any)["kind"])
				}
				// Replayed checkpoints cannot duplicate the wait or its lifecycle fact.
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				replay, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replay)
				require.Equal(t, events+boolQuestionInt(allowed), count())
			})
		}
	}
	require.Equal(t, 14, accepted)
	require.Equal(t, 61, refused)
	t.Logf("literal runtime question matrix: %d accepted, %d refused", accepted, refused)
}

func boolQuestionInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
