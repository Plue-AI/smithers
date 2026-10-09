package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// These literal permissions enter the installed HTTP route, not the helper
// guard. The durable dispatcher is real; no worker runs or guest is invented.
func TestTodoStopTransitionLiteralCases(t *testing.T) {
	h := newTodoSignalLiteralInstall(t)
	digest := rehearsalBuiltinTodoDigest(t) // Input identity; permission expectations stay literal.
	ctx := t.Context()
	cases := []struct {
		engine, plain, wait, paused string
		live                        bool
	}{
		{"queued", "queued", "needs_you", "paused", false},
		{"skipped", "queued", "needs_you", "paused", false},
		{"running", "working", "needs_you", "paused", true},
		{"delivering", "working", "needs_you", "paused", true},
		{"integrating", "working", "needs_you", "paused", true},
		{"verifying", "working", "needs_you", "paused", true},
		{"proposing", "working", "needs_you", "paused", true},
		{"waiting", "working", "needs_you", "paused", true},
		{"retrying", "retrying", "needs_you", "paused", true},
		{"proposed", "in_review", "needs_you", "paused", true},
		{"blocked", "failed", "needs_you", "paused", false},
		{"landed", "merged", "merged", "merged", false},
		{"cancelled", "dropped", "dropped", "dropped", false},
		{"rejected", "dropped", "dropped", "dropped", false},
		{"declined", "dropped", "dropped", "dropped", false},
	}
	modes := []struct {
		name, wait    string
		paused, ended bool
	}{
		{"plain", "", false, false}, {"branch", "foreign_push", false, false},
		{"conflict", "conflict", false, false}, {"moved-off", "moved_off", false, false},
		{"question", "question", false, false}, {"approval", "approval", false, false},
		{"paused", "", true, false}, {"ended", "", false, true},
		{"starting", "", false, false},
		{"branch-and-question", "question", false, false},
		{"branch-and-approval", "approval", false, false},
	}
	accepted, refused := 0, 0
	count := func(table, predicate string) int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE "+predicate).Scan(&n))
		return n
	}
	for _, c := range cases {
		for _, mode := range modes {
			t.Run(c.engine+"/stop/"+mode.name, func(t *testing.T) {
				waits := []map[string]any{}
				if mode.wait != "" {
					waits = append(waits, map[string]any{"id": "w", "kind": mode.wait, "prompt": "Choose", "since": "2026-10-02T12:00:00Z"})
				}
				if mode.name == "branch-and-question" || mode.name == "branch-and-approval" {
					waits = append(waits, map[string]any{"id": "foreign", "kind": "foreign_push", "prompt": "Push", "since": "2026-10-02T12:00:01Z"})
				}
				facts := map[string]any{"todo": true, "run_launched": true, "run_attached": mode.name != "starting", "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
				if len(waits) > 0 {
					facts["waits"] = waits
				}
				checks, err := json.Marshal(facts)
				require.NoError(t, err)
				outcome := ""
				if mode.ended {
					outcome = "validated"
				}
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome=$4,workspace_id='11111111-1111-4111-8111-111111111111',flow_digest=$6,paused_at=CASE WHEN $5 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, checks, outcome, mode.paused, digest)
				require.NoError(t, err)
				from := c.plain
				if mode.name == "starting" && (c.plain == "working" || c.engine == "queued") {
					from = "starting"
				}
				if mode.wait != "" {
					from = c.wait
				}
				if mode.paused {
					from = c.paused
				}
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, from, card["state"])
				require.Equal(t, c.live && !mode.paused && !mode.ended && mode.name != "starting", card["run"].(map[string]any)["executing"])
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				events := count("product_job_events", "event_type LIKE 'todo.%'")
				intents := count("product_job_requests", "operation='flow.runtime.signal'")
				key := fmt.Sprintf("literal-stop-%s-%s", c.engine, mode.name)
				status, receipt := h.call(t, "POST", `{"op":"stop"}`, key)
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				allowed := c.live && (mode.name == "plain" || mode.name == "branch" || mode.name == "conflict" || mode.name == "moved-off")
				if !allowed {
					require.Equal(t, 409, status, receipt)
					require.Equal(t, "todo_transition_refused", receipt["code"])
					require.Equal(t, from, receipt["from"])
					require.Equal(t, "stop", receipt["trigger"])
					require.Equal(t, before, after)
					require.Equal(t, events, count("product_job_events", "event_type LIKE 'todo.%'"))
					require.Equal(t, intents, count("product_job_requests", "operation='flow.runtime.signal'"))
					refused++
					return
				}
				require.Equal(t, 202, status, receipt)
				require.Equal(t, before.State, after.State, "a requested Stop is not a parked run")
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.Attempt, after.Attempt)
				require.Equal(t, before.FlowDigest, after.FlowDigest)
				require.False(t, after.PausedAt.Valid)
				var persisted map[string]any
				require.NoError(t, json.Unmarshal(after.Checks, &persisted))
				require.JSONEq(t, string(checks), mustStopChecksWithoutPause(t, persisted))
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				var data []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.stop.requested' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.EqualValues(t, 1, fact["n"])
				require.Equal(t, from, fact["from"])
				require.Equal(t, from, fact["to"])
				require.Equal(t, "run-1", fact["run"])
				actor := fact["actor"].(map[string]any)
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "maya", actor["login"])
				committed := fact["card"].(map[string]any)
				require.Equal(t, from, committed["state"])
				require.Equal(t, "requested", committed["stop"])
				require.Equal(t, "run-1", committed["run"].(map[string]any)["id"])

				require.Equal(t, intents+1, count("product_job_requests", "operation='flow.runtime.signal'"))
				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, from, card["state"])
				require.Equal(t, "requested", card["stop"])
				replayStatus, replay := h.call(t, "POST", `{"op":"stop"}`, key)
				require.Equal(t, 202, replayStatus, replay)
				require.Equal(t, receipt, replay)
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				require.Equal(t, intents+1, count("product_job_requests", "operation='flow.runtime.signal'"))
				accepted++
			})
		}
	}
	require.Equal(t, 32, accepted)
	require.Equal(t, 133, refused)
	t.Logf("literal Stop cases: %d accepted, %d refused", accepted, refused)
}

func mustStopChecksWithoutPause(t *testing.T, checks map[string]any) string {
	t.Helper()
	delete(checks, "pause")
	raw, err := json.Marshal(checks)
	require.NoError(t, err)
	return string(raw)
}

func newTodoSignalLiteralInstall(t *testing.T, configure ...func(*services.MythicalService, *pgxpool.Pool)) todoLiteralInstall {
	t.Helper()
	return newTodoLiteralInstall(t, func(service *services.MythicalService, pool *pgxpool.Pool) {
		service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
			t.Fatal("TODO control must use the attempt's pin, never Active")
			return "", nil
		})
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service,
			Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
				t.Fatal("HTTP admission must return before resolving a guest")
				return nil, nil
			})})
		require.NoError(t, err)
		service.SetLauncher(dispatcher)
		for _, apply := range configure {
			apply(service, pool)
		}
	})
}
