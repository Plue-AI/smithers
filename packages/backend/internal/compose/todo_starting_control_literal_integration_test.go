package compose

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Starting is a bound launch which has not attached. These HTTP controls must
// neither borrow Working's permissions nor await a guest before acknowledging.
// Live Drop also needs its capture provider and is qualified separately.
func TestTodoStartingControlSourceLiteralCases(t *testing.T) {
	h := newTodoSignalLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { s.EnableTodoSteering() })
	digest := rehearsalBuiltinTodoDigest(t)
	cases := []struct {
		op, body, to, event string
		status              int
	}{
		{"stop", `{"op":"stop"}`, "starting", "", 409},
		{"resume", `{"op":"resume"}`, "starting", "", 409},
		{"retry", `{"op":"retry"}`, "starting", "", 409},
		{"retry-current-flow", `{"op":"retry-current-flow"}`, "starting", "", 409},
		{"steer", `{"steer":"Use the smaller change"}`, "starting", "todo.steer_received", 202},
	}
	accepted, refused := 0, 0
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&n))
		return n
	}
	for _, c := range cases {
		t.Run(c.op, func(t *testing.T) {
			checks, _ := json.Marshal(map[string]any{"todo": true, "run_launched": true, "run_attached": false, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}})
			_, err := h.pool.Exec(t.Context(), `UPDATE mythical_items SET state='running',checks=$2,attempt=1,request_run_id='run-1',request_outcome='',workspace_id='11111111-1111-4111-8111-111111111111',flow_digest=$3,paused_at=NULL WHERE id=$1`, h.item.ID, checks, digest)
			require.NoError(t, err)
			before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
			require.NoError(t, err)
			status, card := h.call(t, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, "starting", card["state"])
			events := count()
			key := "starting-" + c.op
			status, receipt := h.call(t, "POST", c.body, key)
			require.Equal(t, c.status, status, receipt)
			after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
			require.NoError(t, err)
			if c.status == 409 {
				refused++
				require.Equal(t, "todo_transition_refused", receipt["code"])
				require.Equal(t, "starting", receipt["from"])
				require.Equal(t, c.op, receipt["trigger"])
				require.Equal(t, before, after)
				require.Equal(t, events, count())
			} else {
				accepted++
				require.Equal(t, events+1, count())
				var raw []byte
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type=$1 ORDER BY sequence DESC LIMIT 1`, c.event).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, "starting", fact["from"])
				require.Equal(t, c.to, fact["to"])
				actor, ok := fact["actor"].(map[string]any)
				require.True(t, ok, fact)
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "maya", actor["login"])
				status, replay := h.call(t, "POST", c.body, key)
				require.Equal(t, 202, status, replay)
				require.Equal(t, receipt, replay)
				require.Equal(t, events+1, count())
			}
			status, card = h.call(t, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, c.to, card["state"])
		})
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 4, refused)
	t.Logf("Starting controls: %d accepted, %d refused", accepted, refused)
}

// Draft is the unplaced input, not a parallel persisted TODO state. Placement
// enters the real creation route and records one literal draft → queued fact.
func TestTodoDraftPlacementLiteralComposedInstall(t *testing.T) {
	h := newTodoLiteralInstall(t)
	before := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.created'`).Scan(&n))
		return n
	}()
	body := `{"title":"Draft placement","prompt":"Make the small change","acceptance":[]}`
	status, receipt := h.call(t, "POST", body, "draft-place", "/api/todos")
	require.Equal(t, 202, status, receipt)
	require.Equal(t, float64(2), receipt["n"])
	status, replay := h.call(t, "POST", body, "draft-place", "/api/todos")
	require.Equal(t, 202, status, replay)
	require.Equal(t, receipt, replay)
	var count int
	var raw []byte
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.created'`).Scan(&count))
	require.Equal(t, before+1, count)
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.created' ORDER BY sequence DESC LIMIT 1`).Scan(&raw))
	var fact map[string]any
	require.NoError(t, json.Unmarshal(raw, &fact))
	require.Equal(t, "draft", fact["from"])
	require.Equal(t, "queued", fact["to"])
	require.Equal(t, float64(h.owner), fact["actor"])
	status, card := h.call(t, "GET", "", "", "/api/todos/2")
	require.Equal(t, 200, status, card)
	require.Equal(t, "queued", card["state"])
}
