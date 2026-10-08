package compose

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// C-STK-01: authenticated machine transport, stored actor admission, production
// event consumer and installed HTTP card. The guest event is a literal input;
// no native move or reference-host execution is claimed here. Draft is the
// uncommitted placement input, never an item with an authenticated machine.
func TestTodoMovedOffSourceTransitionLiteralCases(t *testing.T) {
	if testing.Short() {
		t.Skip("real PostgreSQL and composed install required; child fixtures also skip in short mode")
	}
	cases := []struct {
		state, engine                        string
		attached, paused, question, accepted bool
	}{
		{"queued", "queued", true, false, false, true},
		{"starting", "running", false, false, false, true},
		{"working", "running", true, false, false, true},
		{"needs_you", "running", true, false, true, true},
		{"paused", "running", true, true, false, true},
		{"failed", "blocked", true, false, false, true},
		{"in_review", "proposed", true, false, false, true},
		{"merged", "landed", true, false, false, false},
		{"dropped", "cancelled", true, false, false, false},
		{"dropped-rejected", "rejected", true, false, false, false},
		{"dropped-declined", "declined", true, false, false, false},
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		t.Run(c.state, func(t *testing.T) {
			h := newMovedOffHost(t)
			ctx := t.Context()
			q := db.New(h.f.pool)
			state := c.state
			if c.engine == "rejected" || c.engine == "declined" {
				state = "dropped"
			}
			checks := map[string]any{"todo": true, "run_launched": true, "run_attached": c.attached}
			if c.question {
				checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = h.f.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,pr_state='',paused_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE repository_id=$1 AND number=1`, h.f.row.RepositoryID, c.engine, raw, c.paused)
			require.NoError(t, err)
			read := func() map[string]any {
				t.Helper()
				request, err := http.NewRequestWithContext(ctx, "GET", h.server.URL+"/api/todos/1", nil)
				require.NoError(t, err)
				request.AddCookie(&http.Cookie{Name: "session", Value: h.f.cookie})
				response, err := http.DefaultClient.Do(request)
				require.NoError(t, err)
				defer response.Body.Close()
				require.Equal(t, 200, response.StatusCode)
				var card map[string]any
				require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
				return card
			}
			require.Equal(t, state, read()["state"])
			before, err := q.GetMythicalItemByNumber(ctx, h.f.row.RepositoryID, 1)
			require.NoError(t, err)
			effects := h.effects()
			guest := h.attach(h.service)
			event := machined.Event{Seq: 1, EventID: [16]byte{71}, Payload: h.payload(h.actor, 1)}
			outcome := machined.AckApplied
			if !c.accepted {
				outcome = machined.AckRejected
			}
			h.deliver(guest, event, &outcome)
			after, err := q.GetMythicalItemByNumber(ctx, h.f.row.RepositoryID, 1)
			require.NoError(t, err)
			if !c.accepted {
				refused++
				require.Equal(t, before, after)
				result := h.effects()
				require.Equal(t, effects.fact, result.fact)
				require.Equal(t, effects.waits, result.waits)
				require.Equal(t, effects.events, result.events)
				require.Equal(t, state, read()["state"])
				h.deliver(guest, event, &outcome)
				return
			}
			accepted++
			require.Equal(t, before.State, after.State)
			require.Equal(t, before.PausedAt, after.PausedAt)
			card := read()
			require.Equal(t, "needs_you", card["state"])
			waits := card["waits"].([]any)
			require.Len(t, waits, 1+boolQuestionInt(c.question))
			require.Equal(t, "moved_off", waits[0].(map[string]any)["kind"])
			fact := func(kind, from, to string) {
				t.Helper()
				var raw []byte
				var n int
				require.NoError(t, h.f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type=$1`, kind).Scan(&n))
				require.Equal(t, 1, n)
				require.NoError(t, h.f.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type=$1`, kind).Scan(&raw))
				var data map[string]any
				require.NoError(t, json.Unmarshal(raw, &data))
				require.Equal(t, from, data["from"])
				require.Equal(t, to, data["to"])
				require.Equal(t, "presence-owner", data["actor"].(map[string]any)["login"])
			}
			fact("todo.moved-off", state, "needs_you")
			replay := machined.AckDuplicate
			h.deliver(guest, event, &replay)
			// A distinct transport identity still cannot open a second wait.
			event.Seq, event.EventID = 2, [16]byte{72}
			h.deliver(guest, event, &outcome)
			fact("todo.moved-off", state, "needs_you")
			payload := event.Payload
			fields, err := wire.Fields("moved_off", payload[1:])
			require.NoError(t, err)
			event.Seq, event.EventID = 3, [16]byte{73}
			event.Payload = wire.Union(4, wire.Field(1, fields[1]), wire.Field(2, fields[2]), wire.Field(3, fields[3]), wire.Field(4, []byte{1}))
			h.deliver(guest, event, &outcome)
			require.Equal(t, state, read()["state"])
			fact("todo.returned-to-item", "needs_you", state)
			if c.question {
				require.Equal(t, "question", read()["waits"].([]any)[0].(map[string]any)["kind"])
			}
			h.deliver(guest, event, &replay)
			fact("todo.returned-to-item", "needs_you", state)
		})
	}
	t.Logf("executed moved-off sources: %d accepted return cycles, %d terminal refusals", accepted, refused)
}

func TestTodoMovedOffFactRollbackComposedInstall(t *testing.T) {
	h := newMovedOffHost(t)
	ctx := t.Context()
	q := db.New(h.f.pool)
	before, err := q.GetMythicalItemByNumber(ctx, h.f.row.RepositoryID, 1)
	require.NoError(t, err)
	effects := h.effects()
	_, err = h.f.pool.Exec(ctx, `CREATE FUNCTION refuse_moved_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event_type='todo.moved-off' THEN RAISE EXCEPTION 'injected moved fact failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_moved_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_moved_fact()`)
	require.NoError(t, err)
	event := machined.Event{Seq: 1, EventID: [16]byte{74}, Payload: h.payload(h.actor, 1)}
	h.deliver(h.attach(h.service), event, nil)
	after, err := q.GetMythicalItemByNumber(ctx, h.f.row.RepositoryID, 1)
	require.NoError(t, err)
	require.Equal(t, before, after, "wait, version and projection must roll back with the fact")
	require.Equal(t, effects, h.effects(), "branch fact, activity and transport receipt must also roll back")
	_, err = h.f.pool.Exec(ctx, `DROP TRIGGER refuse_moved_fact ON product_job_events; DROP FUNCTION refuse_moved_fact()`)
	require.NoError(t, err)
	outcome := machined.AckApplied
	h.deliver(h.attach(h.service), event, &outcome)
	require.Len(t, h.effects().waits, 1)
	require.Equal(t, effects.events+2, h.effects().events)
}
