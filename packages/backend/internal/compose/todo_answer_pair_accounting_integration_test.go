package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The source is read from the installed card before submitting the answer.
// Only Needs you supplies a bound person wait; other sources must not invent it.
func TestTodoAnswerGuardPairAccountingComposedInstall(t *testing.T) {
	for _, kind := range []string{"question", "approval"} {
		t.Run(kind, func(t *testing.T) {
			h := newTodoSignalLiteralInstall(t)
			scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
			target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
			for _, c := range []struct {
				source, engine             string
				launched, attached, paused bool
			}{
				{"draft", "queued", false, false, false}, {"queued", "queued", false, false, false}, {"starting", "running", true, false, false},
				{"working", "running", true, true, false}, {"needs_you", "running", true, true, false}, {"paused", "running", true, true, true},
				{"failed", "blocked", true, true, false}, {"in_review", "proposed", true, true, false}, {"merged", "landed", true, true, false}, {"dropped", "cancelled", true, true, false},
			} {
				t.Run(c.source, func(t *testing.T) {
					checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
					if c.source == "needs_you" {
						checks["waits"] = []map[string]any{{"id": "answerable", "kind": kind, "prompt": "Continue?", "since": "2026-10-02T12:00:00Z", "signal": services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "run-1", Name: "answerable"}}}
					}
					raw, err := json.Marshal(checks)
					require.NoError(t, err)
					_, err = h.pool.Exec(t.Context(), `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$4,flow_digest='11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e',pr_state='',paused_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, target.WorkspaceID, c.paused)
					require.NoError(t, err)
					path := "/api/todos/1"
					if c.source == "draft" {
						path = "/api/todos/999"
					} else {
						code, card := h.call(t, "GET", "", "", path)
						require.Equal(t, 200, code)
						require.Equal(t, c.source, card["state"])
					}
					before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
					require.NoError(t, err)
					count := func(table, predicate string) int {
						var n int
						require.NoError(t, h.pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table+" WHERE "+predicate).Scan(&n))
						return n
					}
					events, signals := count("product_job_events", "event_type LIKE 'todo.%'"), count("product_job_requests", "operation='flow.runtime.signal'")
					answer := "Continue"
					if kind == "approval" {
						answer = "true"
					}
					code, receipt := h.call(t, "POST", fmt.Sprintf(`{"wait":"answerable","answer":%q}`, answer), kind+"-"+c.source, path+"/answer")
					if c.source != "needs_you" {
						require.Equal(t, 404, code, receipt)
						after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
						require.NoError(t, err)
						require.Equal(t, before, after)
						require.Equal(t, events, count("product_job_events", "event_type LIKE 'todo.%'"))
						require.Equal(t, signals, count("product_job_requests", "operation='flow.runtime.signal'"))
						recordTodoGuardPair(t, c.source, "answer-"+kind, "")
						return
					}
					require.Equal(t, 202, code, receipt)
					require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
					require.Equal(t, signals+1, count("product_job_requests", "operation='flow.runtime.signal'"))
					code, card := h.call(t, "GET", "", "", path)
					require.Equal(t, 200, code)
					require.Equal(t, "working", card["state"])
					require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.answered' ORDER BY sequence DESC LIMIT 1`).Scan(&raw))
					var fact map[string]any
					require.NoError(t, json.Unmarshal(raw, &fact))
					require.Equal(t, "needs_you", fact["from"])
					require.Equal(t, "working", fact["to"])
					require.Equal(t, "maya", fact["actor"].(map[string]any)["login"])
					recordTodoGuardPair(t, c.source, "answer-"+kind, fact["to"].(string))
				})
			}
		})
	}
}
