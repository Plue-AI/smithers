package compose

import (
	"encoding/json"
	"fmt"
	"github.com/stretchr/testify/require"
	"testing"
)

// An answer cannot invent a wait, including when a different branch wait is
// open. Every source reaches the production answer route and HTTP card.
func TestTodoAnswerWithoutWaitSourceLiteralCases(t *testing.T) {
	cases := []struct {
		state, engine                    string
		launched, attached, paused, wait bool
	}{
		{"queued", "queued", false, false, false, false},
		{"starting", "running", true, false, false, false},
		{"working", "running", true, true, false, false},
		{"needs_you", "running", true, true, false, true},
		{"paused", "running", true, true, true, false},
		{"failed", "blocked", true, true, false, false},
		{"in_review", "proposed", true, true, false, false},
		{"merged", "landed", true, true, false, false},
		{"dropped", "cancelled", true, true, false, false},
	}
	for _, c := range cases {
		t.Run(c.state, func(t *testing.T) {
			h := newTodoSignalLiteralInstall(t)
			ctx := t.Context()
			checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached}
			if c.wait {
				checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_state='',paused_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, c.paused)
			require.NoError(t, err)
			before, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			status, card := h.call(t, "GET", "", "")
			require.Equal(t, 200, status)
			require.Equal(t, c.state, card["state"])
			count := func(table string) int {
				var n int
				require.NoError(t, h.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
				return n
			}
			facts, requests := count("product_job_events"), count("product_job_requests")
			for _, answer := range []string{"Continue", "bring-in", "done"} {
				status, reply := h.call(t, "POST", fmt.Sprintf(`{"wait":"missing-wait","answer":%q}`, answer), "absent-"+answer, "answer")
				require.Equal(t, 404, status, reply)
				require.Equal(t, "wait_not_found", reply["code"])
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				require.Equal(t, facts, count("product_job_events"))
				require.Equal(t, requests, count("product_job_requests"))
				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status)
				require.Equal(t, c.state, card["state"])
			}
		})
	}
}

// A branch action or an unbound approval must not fall through to an
// independently open, answerable question. Bound approvals use Answer with
// a boolean, qualified by TestTodoApprovalProducerAnswerComposedInstall.
func TestTodoAnswerWrongWaitKindSourceLiteralCases(t *testing.T) {
	h := newTodoSignalLiteralInstall(t)
	sources := []struct {
		name, engine               string
		launched, attached, paused bool
	}{
		{"queued", "queued", false, false, false},
		{"starting", "running", true, false, false},
		{"working", "running", true, true, false},
		{"needs_you", "running", true, true, false},
		{"paused", "running", true, true, true},
		{"failed", "blocked", true, true, false},
		{"in_review", "proposed", true, true, false},
		{"merged", "landed", true, true, false},
		{"dropped", "cancelled", true, true, false},
	}
	refused := 0
	for _, source := range sources {
		for _, kind := range []string{"foreign_push", "moved_off", "approval"} {
			t.Run(source.name+"/"+kind, func(t *testing.T) {
				waits := []map[string]any{
					{"id": "other", "kind": kind, "prompt": "Separate action", "since": "2026-10-02T12:00:00Z"},
					{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:01Z"},
				}
				raw, err := json.Marshal(map[string]any{"todo": true, "run_launched": source.launched, "run_attached": source.attached, "waits": waits})
				require.NoError(t, err)
				_, err = h.pool.Exec(t.Context(), `UPDATE mythical_items SET state=$2,checks=$3,pr_state='',paused_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, source.engine, raw, source.paused)
				require.NoError(t, err)
				before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				count := func(table string) int {
					var n int
					require.NoError(t, h.pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table).Scan(&n))
					return n
				}
				events, requests := count("product_job_events"), count("product_job_requests")
				status, initial := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, initial)
				expected := "needs_you"
				if source.name == "merged" || source.name == "dropped" {
					expected = source.name
				}
				require.Equal(t, expected, initial["state"])
				for _, answer := range []string{"Continue", "done", "bring-in", "discard-foreign"} {
					status, reply := h.call(t, "POST", fmt.Sprintf(`{"wait":"other","answer":%q}`, answer), source.name+kind+answer, "answer")
					if kind == "approval" {
						require.Equal(t, 409, status, reply)
						require.Equal(t, "conflict", reply["code"])
					} else {
						require.Equal(t, 404, status, reply)
						require.Equal(t, "wait_not_found", reply["code"])
					}
					after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
					require.NoError(t, err)
					require.Equal(t, before, after, "neither the named wait nor the independent question settles")
					require.Equal(t, events, count("product_job_events"))
					require.Equal(t, requests, count("product_job_requests"))
					status, card := h.call(t, "GET", "", "")
					require.Equal(t, 200, status, card)
					require.Equal(t, initial, card)
					refused++
				}
			})
		}
	}
	require.Equal(t, 108, refused)
	t.Logf("literal wrong-kind Answer guards: %d refused requests, no facts or signals", refused)
}
