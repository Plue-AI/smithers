package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The source/overlay permissions and destinations are literal, independent
// of production descriptors. Discard runs through the installed branch route;
// it changes a retained publication lease, never a machine or a GitHub ref.
func TestTodoDiscardSourceTransitionLiteralCases(t *testing.T) {
	f := newTodoSourceCycle(t)
	cases := []struct {
		state, engine              string
		attached, paused, accepted bool
	}{
		{"queued", "queued", true, false, true}, {"starting", "running", false, false, true},
		{"working", "running", true, false, true}, {"needs_you", "running", true, false, true},
		{"paused", "running", true, true, true}, {"failed", "blocked", true, false, true},
		{"in_review", "proposed", true, false, true}, {"merged", "landed", true, false, false},
		{"dropped", "cancelled", true, false, false},
	}
	accepted, refused, variants := 0, 0, 0
	for i, c := range cases {
		for overlay := 0; overlay < 2; overlay++ {
			t.Run(fmt.Sprintf("%s/question=%t", c.state, overlay == 1), func(t *testing.T) {
				n := int64(i*2 + overlay + 1)
				checks := map[string]any{"run_launched": true, "run_attached": c.attached}
				if c.state == "queued" {
					checks["retries"] = []map[string]any{{"attempt": 2}}
				}
				waits := []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Alice pushed", "sha": f.base, "since": "2026-10-02T12:00:00Z"}}
				question := overlay == 1 || c.state == "needs_you"
				if question {
					waits = append(waits, map[string]any{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:01Z"})
				}
				checks["waits"], checks["foreignHead"] = waits, f.base
				item := f.item(t, n, c.engine, checks, c.paused)
				count := func() int {
					var total int
					require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign' AND data->>'n'=$1`, fmt.Sprint(n)).Scan(&total))
					return total
				}
				before, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				writes := f.upstream.Writes()
				branch := fmt.Sprintf("/api/branches/smithers%%2Fliteral-%d", n)
				for _, bad := range []struct{ id, revision string }{{"question", f.base}, {"foreign", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}} {
					status, receipt := f.call(t, n, "POST", fmt.Sprintf(`{"op":"discard-foreign","id":%q,"revision":%q}`, bad.id, bad.revision), branch)
					require.Equal(t, 409, status, receipt)
					after, err := f.q.GetMythicalItem(t.Context(), item.ID)
					require.NoError(t, err)
					require.Equal(t, before, after)
					require.Zero(t, count())
					variants++
				}
				body := fmt.Sprintf(`{"op":"discard-foreign","id":"foreign","revision":%q}`, f.base)
				status, receipt := f.call(t, n, "POST", body, branch)
				if !c.accepted {
					require.Equal(t, 409, status, receipt)
					require.Zero(t, count())
					after, err := f.q.GetMythicalItem(t.Context(), item.ID)
					require.NoError(t, err)
					require.Equal(t, before, after)
					refused++
					return
				}
				accepted++
				require.Equal(t, 202, status, receipt)
				require.Equal(t, 1, count())
				after, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.Equal(t, before.State, after.State)
				require.Equal(t, before.PausedAt, after.PausedAt)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.Attempt, after.Attempt)
				var saved struct {
					Waits       []services.TodoWait `json:"waits"`
					ForeignHead string              `json:"foreignHead"`
				}
				require.NoError(t, json.Unmarshal(after.Checks, &saved))
				require.Empty(t, saved.ForeignHead)
				require.NotNil(t, saved.Waits[0].SettledAt)
				if question {
					require.Nil(t, saved.Waits[1].SettledAt)
				}
				to := c.state
				if question {
					to = "needs_you"
				}
				status, card := f.call(t, n, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, to, card["state"])
				var raw []byte
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.foreign_discard-foreign' AND data->>'n'=$1`, fmt.Sprint(n)).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, "needs_you", fact["from"])
				require.Equal(t, to, fact["to"])
				require.Equal(t, "acme", fact["actor"].(map[string]any)["login"])
				status, replay := f.call(t, n, "POST", body, branch)
				require.Equal(t, 202, status, replay)
				require.Equal(t, receipt, replay)
				require.Equal(t, 1, count())
				require.Equal(t, writes, f.upstream.Writes())
			})
		}
	}
	require.Equal(t, 14, accepted)
	require.Equal(t, 4, refused)
	require.Equal(t, 36, variants)
	t.Logf("literal Discard sources: %d accepted, %d terminal refusals, %d stale/wrong-wait refusals", accepted, refused, variants)
}
