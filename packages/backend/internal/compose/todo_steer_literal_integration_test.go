package compose

import (
	"context"
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

// Literal outcomes enter the installed command route. The durable intent is
// exercised here; runtime delivery and model consumption have separate proofs.
func TestTodoSteerTransitionLiteralCases(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, pool *pgxpool.Pool) {
		service = s
		s.EnableTodoSteering()
		s.SetTodoFlow(func(context.Context, int64, string) (string, error) {
			t.Fatal("Steer must retain the attempt pin")
			return "", nil
		})
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: s, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Fatal("HTTP admission must not await runtime delivery")
			return nil, nil
		})})
		require.NoError(t, err)
		s.SetLauncher(dispatcher)
	})
	cases := []struct {
		engine   string
		from, to [4]string
		accepted bool
	}{
		{"queued", [4]string{"queued", "starting", "paused", "needs_you"}, [4]string{"queued", "starting", "paused", "needs_you"}, true},
		{"skipped", [4]string{"queued", "queued", "paused", "needs_you"}, [4]string{"queued", "queued", "paused", "needs_you"}, true},
		{"running", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"delivering", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"integrating", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"verifying", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"proposing", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"waiting", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"retrying", [4]string{"working", "starting", "paused", "needs_you"}, [4]string{"working", "starting", "paused", "needs_you"}, true},
		{"proposed", [4]string{"in_review", "in_review", "paused", "needs_you"}, [4]string{"working", "in_review", "paused", "needs_you"}, true},
		{"blocked", [4]string{"failed", "failed", "paused", "needs_you"}, [4]string{"queued", "queued", "queued", "needs_you"}, true},
		{"landed", [4]string{"merged", "merged", "merged", "merged"}, [4]string{"merged", "merged", "merged", "merged"}, false},
		{"cancelled", [4]string{"dropped", "dropped", "dropped", "dropped"}, [4]string{"dropped", "dropped", "dropped", "dropped"}, false},
		{"rejected", [4]string{"dropped", "dropped", "dropped", "dropped"}, [4]string{"dropped", "dropped", "dropped", "dropped"}, false},
		{"declined", [4]string{"dropped", "dropped", "dropped", "dropped"}, [4]string{"dropped", "dropped", "dropped", "dropped"}, false},
	}
	modes := []string{"attached", "attaching", "paused", "question-and-branch"}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&n))
		return n
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		for m, mode := range modes {
			t.Run(c.engine+"/steer/"+mode, func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": true, "run_attached": m != 1, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}
				if m == 3 {
					checks["waits"] = []map[string]any{{"id": "q", "kind": "question", "prompt": "Which?", "since": "2026-10-02T12:00:00Z"}, {"id": "f", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:01Z"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				_, err = h.pool.Exec(t.Context(), `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome='',workspace_id='11111111-1111-4111-8111-111111111111',flow_digest='11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e',paused_at=CASE WHEN $4 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, m == 2)
				require.NoError(t, err)
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, c.from[m], card["state"])
				before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				events := count()
				key := fmt.Sprintf("literal-steer-%s-%d", c.engine, m)
				status, receipt := h.call(t, "POST", `{"steer":"Use the smaller change"}`, key)
				after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				if !c.accepted {
					require.Equal(t, 409, status, receipt)
					require.Equal(t, "todo_transition_refused", receipt["code"])
					require.Equal(t, c.from[m], receipt["from"])
					require.Equal(t, "steer", receipt["trigger"])
					require.Equal(t, before, after)
					require.Equal(t, events, count())
					refused++
					return
				}
				require.Equal(t, 202, status, receipt)
				require.Equal(t, events+1, count())
				require.Equal(t, before.Attempt, after.Attempt)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.FlowDigest, after.FlowDigest)
				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, c.to[m], card["state"])
				var saved struct {
					Waits  []services.TodoWait `json:"waits"`
					Steers []struct {
						Text    string
						Attempt int32
					} `json:"steers"`
				}
				require.NoError(t, json.Unmarshal(after.Checks, &saved))
				require.Len(t, saved.Steers, 1)
				require.Equal(t, "Use the smaller change", saved.Steers[0].Text)
				if m == 3 {
					require.Len(t, saved.Waits, 2)
					for _, w := range saved.Waits {
						require.Nil(t, w.SettledAt)
					}
				}
				var data []byte
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.steer_received' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, c.from[m], fact["from"])
				require.Equal(t, c.to[m], fact["to"])
				actor, ok := fact["actor"].(map[string]any)
				require.True(t, ok, fact)
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "maya", actor["login"])
				require.Equal(t, "maya", fact["by"].(map[string]any)["person"])
				status, replay := h.call(t, "POST", `{"steer":"Use the smaller change"}`, key)
				require.Equal(t, 202, status, replay)
				require.Equal(t, receipt, replay)
				require.Equal(t, events+1, count())
				replayed, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replayed)
				if c.engine == "blocked" {
					// A delayed checkpoint of the failed run cannot attach or
					// overwrite the newly queued Retry-with-steer decision.
					scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
					payload, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(h.item.ID.Bytes).String(), "generation": before.Generation, "attempt": 1, "phase": "todo", "flowDigest": before.FlowDigest.String, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
					require.NoError(t, err)
					update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: payload, FlowID: "todo", RunID: "run-1", ExecutionDigest: before.FlowDigest.String, Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: before.WorkspaceID, BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}, Run: &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: "running"}}}
					require.NoError(t, service.ProjectFlowRuntime(t.Context(), update))
					stale, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
					require.NoError(t, err)
					require.Equal(t, after, stale)
					require.Equal(t, events+1, count())
				}
				accepted++
			})
		}
	}
	require.Equal(t, 44, accepted)
	require.Equal(t, 16, refused)
	t.Logf("literal Steer cases: %d accepted, %d refused", accepted, refused)
}
