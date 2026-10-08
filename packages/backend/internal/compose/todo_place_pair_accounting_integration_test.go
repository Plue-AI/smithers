package compose

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"testing"
)

// Placement creates an item from text; the item command door cannot place an
// already stored TODO a second time or use placement as a state shortcut.
func TestTodoStoredPlacementGuardPairsComposedInstall(t *testing.T) {
	h := newTodoSignalLiteralInstall(t)
	for _, c := range []struct {
		source, engine             string
		launched, attached, paused bool
	}{
		{"queued", "queued", false, false, false}, {"starting", "running", true, false, false}, {"working", "running", true, true, false},
		{"needs_you", "running", true, true, false}, {"paused", "running", true, true, true}, {"failed", "blocked", true, true, false},
		{"in_review", "proposed", true, true, false}, {"merged", "landed", true, true, false}, {"dropped", "cancelled", true, true, false},
	} {
		t.Run(c.source, func(t *testing.T) {
			checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached}
			if c.source == "needs_you" {
				checks["waits"] = []map[string]any{{"id": "branch", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = h.pool.Exec(t.Context(), `UPDATE mythical_items SET state=$2,checks=$3,pr_state='',paused_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, c.paused)
			require.NoError(t, err)
			before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
			require.NoError(t, err)
			code, card := h.call(t, "GET", "", "")
			require.Equal(t, 200, code)
			require.Equal(t, c.source, card["state"])
			var events int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events`).Scan(&events))
			code, reply := h.call(t, "POST", `{"op":"place"}`, "place-stored-"+c.source)
			require.Equal(t, 400, code, reply)
			after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
			var count int
			require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events`).Scan(&count))
			require.Equal(t, events, count)
			recordTodoGuardPair(t, c.source, "place", "")
		})
	}
}
