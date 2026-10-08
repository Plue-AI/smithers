package compose

import (
	"encoding/json"
	"fmt"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestTodoDiscardGuardPairAccountingComposedInstall(t *testing.T) {
	f := newTodoSourceCycle(t)
	for i, c := range []struct {
		source, engine             string
		launched, attached, paused bool
	}{
		{"queued", "queued", false, false, false}, {"starting", "running", true, false, false}, {"working", "running", true, true, false},
		{"needs_you", "running", true, true, false}, {"paused", "running", true, true, true}, {"failed", "blocked", true, true, false},
		{"in_review", "proposed", true, true, false}, {"merged", "landed", true, true, false}, {"dropped", "cancelled", true, true, false},
	} {
		t.Run(c.source, func(t *testing.T) {
			n := int64(i + 1)
			checks := map[string]any{"run_launched": c.launched, "run_attached": c.attached}
			if c.source == "needs_you" {
				checks["foreignHead"] = f.base
				checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "sha": f.base, "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
			}
			item := f.item(t, n, c.engine, checks, c.paused)
			_, err := f.pool.Exec(t.Context(), `UPDATE mythical_items SET pr_state='' WHERE id=$1`, item.ID)
			require.NoError(t, err)
			before, err := f.q.GetMythicalItem(t.Context(), item.ID)
			require.NoError(t, err)
			code, card := f.call(t, n, "GET", "", "")
			require.Equal(t, 200, code)
			require.Equal(t, c.source, card["state"])
			count := func() int {
				var n int
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&n))
				return n
			}
			facts := count()
			code, reply := f.call(t, n, "POST", fmt.Sprintf(`{"op":"discard-foreign","id":"foreign","revision":%q}`, f.base), fmt.Sprintf("/api/branches/smithers%%2Fliteral-%d", n))
			if c.source != "needs_you" {
				require.Equal(t, 409, code, reply)
				after, err := f.q.GetMythicalItem(t.Context(), item.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				require.Equal(t, facts, count())
				recordTodoGuardPair(t, c.source, "discard", "")
				return
			}
			require.Equal(t, 202, code, reply)
			require.Equal(t, facts+1, count())
			code, card = f.call(t, n, "GET", "", "")
			require.Equal(t, 200, code)
			require.Equal(t, "working", card["state"])
			var raw []byte
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.foreign_discard-foreign' ORDER BY sequence DESC LIMIT 1`).Scan(&raw))
			var fact map[string]any
			require.NoError(t, json.Unmarshal(raw, &fact))
			require.Equal(t, "needs_you", fact["from"])
			require.Equal(t, "working", fact["to"])
			recordTodoGuardPair(t, c.source, "discard", fact["to"].(string))
		})
	}
}
