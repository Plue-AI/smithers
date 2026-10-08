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

// Answer reads its own open wait, even when an independent branch wait or
// pause masks the run. A terminal item never signals a retained old question.
func TestTodoAnswerTransitionLiteralCases(t *testing.T) {
	testTodoAnswerTransitionLiteralCases(t, "question", "Use option A", "Use option B")
}

func TestTodoApprovalAnswerTransitionLiteralCases(t *testing.T) {
	testTodoAnswerTransitionLiteralCases(t, "approval", "true", "false")
}

func testTodoAnswerTransitionLiteralCases(t *testing.T, kind, answer, late string) {
	h := newTodoSignalLiteralInstall(t)
	cases := []struct {
		engine   string
		to       [4]string
		accepted bool
	}{
		{"queued", [4]string{"queued", "needs_you", "paused", "needs_you"}, true},
		{"skipped", [4]string{"queued", "needs_you", "paused", "needs_you"}, true},
		{"running", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"delivering", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"integrating", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"verifying", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"proposing", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"waiting", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"retrying", [4]string{"working", "needs_you", "paused", "needs_you"}, true},
		{"proposed", [4]string{"in_review", "needs_you", "paused", "needs_you"}, true},
		{"blocked", [4]string{"failed", "needs_you", "paused", "needs_you"}, true},
		{"landed", [4]string{"merged", "merged", "merged", "merged"}, false},
		{"cancelled", [4]string{"dropped", "dropped", "dropped", "dropped"}, false},
		{"rejected", [4]string{"dropped", "dropped", "dropped", "dropped"}, false},
		{"declined", [4]string{"dropped", "dropped", "dropped", "dropped"}, false},
	}
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	count := func(table, predicate string) int {
		var n int
		require.NoError(t, h.pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table+" WHERE "+predicate).Scan(&n))
		return n
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		for m := 0; m < 4; m++ {
			t.Run(fmt.Sprintf("%s/answer/branch=%t/paused=%t", c.engine, m%2 == 1, m >= 2), func(t *testing.T) {
				waitID := fmt.Sprintf("q-%s-%d", c.engine, m)
				question := map[string]any{"id": waitID, "kind": kind, "prompt": "Which?", "since": "2026-10-02T12:00:00Z", "signal": services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "run-1", Name: waitID}}
				waits := []map[string]any{question}
				if m%2 == 1 {
					waits = append(waits, map[string]any{"id": "f", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:01Z"})
				}
				raw, err := json.Marshal(map[string]any{"todo": true, "run_launched": true, "run_attached": true, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "waits": waits})
				require.NoError(t, err)
				_, err = h.pool.Exec(t.Context(), `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$4,flow_digest='11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e',paused_at=CASE WHEN $5 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, target.WorkspaceID, m >= 2)
				require.NoError(t, err)
				before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				events := count("product_job_events", "event_type LIKE 'todo.%'")
				signals := count("product_job_requests", "operation='flow.runtime.signal'")
				body := fmt.Sprintf(`{"wait":%q,"answer":%q}`, waitID, answer)
				status, receipt := h.call(t, "POST", body, "answer-"+waitID, "answer")
				after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				if !c.accepted {
					require.Equal(t, 409, status, receipt)
					require.Equal(t, "conflict", receipt["class"])
					require.Equal(t, before, after)
					require.Equal(t, events, count("product_job_events", "event_type LIKE 'todo.%'"))
					require.Equal(t, signals, count("product_job_requests", "operation='flow.runtime.signal'"))
					refused++
					return
				}
				require.Equal(t, 202, status, receipt)
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				require.Equal(t, signals+1, count("product_job_requests", "operation='flow.runtime.signal'"))
				require.Equal(t, before.State, after.State)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.PausedAt, after.PausedAt)
				var saved struct {
					Waits []services.TodoWait `json:"waits"`
				}
				require.NoError(t, json.Unmarshal(after.Checks, &saved))
				require.Len(t, saved.Waits, len(waits))
				require.NotNil(t, saved.Waits[0].SettledAt)
				require.Equal(t, "maya", saved.Waits[0].AnsweredBy)
				require.Equal(t, answer, saved.Waits[0].Answer)
				if m%2 == 1 {
					require.Nil(t, saved.Waits[1].SettledAt)
				}
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, c.to[m], card["state"])
				var data []byte
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.answered' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, "needs_you", fact["from"])
				require.Equal(t, c.to[m], fact["to"])
				require.Equal(t, "maya", fact["actor"].(map[string]any)["login"])
				status, _ = h.call(t, "POST", body, "answer-"+waitID, "answer")
				require.Equal(t, 202, status)
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				status, receipt = h.call(t, "POST", fmt.Sprintf(`{"wait":%q,"answer":%q}`, waitID, late), "late-"+waitID, "answer")
				require.Equal(t, 409, status, receipt)
				require.Equal(t, "answered", receipt["code"])
				require.Equal(t, "maya", receipt["answered_by"])
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				require.Equal(t, signals+1, count("product_job_requests", "operation='flow.runtime.signal'"))
				accepted++
			})
		}
	}
	require.Equal(t, 44, accepted)
	require.Equal(t, 16, refused)
	t.Logf("literal %s Answer cases: %d accepted, %d refused; %d late answers refused", kind, accepted, refused, accepted)
}
