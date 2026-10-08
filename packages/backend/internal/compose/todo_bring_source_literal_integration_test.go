package compose

import (
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"net/http"
	"testing"
)

// Admission uses real retained branch rows, production guards and installed
// HTTP cards. Native safe-boundary consumption is independently qualified.
func proveTodoBringSourceCases(t *testing.T, pool *pgxpool.Pool, q *db.Queries, item db.MythicalItem, repo, owner int64, onto, head, origin string, call func(string, string) (int, map[string]any)) {
	ctx := t.Context()
	lane, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: "smithers/test", Status: "stopped"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: lane.ID, RepositoryID: repo, ItemID: item.ID, Name: "TODO 1 coding"})
	require.NoError(t, err)
	cases := []struct {
		source, engine   string
		paused, accepted bool
	}{
		{"queued", "queued", false, true}, {"starting", "running", false, true}, {"working", "running", false, true},
		{"needs_you", "running", false, true}, {"paused", "running", true, true}, {"failed", "blocked", false, true},
		{"in_review", "proposed", false, true}, {"merged", "landed", false, false}, {"dropped", "cancelled", false, false},
	}
	for _, c := range cases {
		t.Run("canonical/"+c.source, func(t *testing.T) {
			checks := map[string]any{"todo": true, "branch": "smithers/test", "run_launched": c.source != "queued", "run_attached": c.source != "starting"}
			if c.source == "needs_you" {
				checks["foreignHead"] = onto
				checks["waits"] = []map[string]any{{"id": "foreign-1", "kind": "foreign_push", "sha": onto, "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
			}
			raw, err := json.Marshal(checks)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id='',state=$2,checks=$3,pr_state='',candidate_head=$4,paused_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`, item.ID, c.engine, raw, head, c.paused)
			require.NoError(t, err)
			request, err := http.NewRequest("GET", origin+"/api/todos/1", nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, 200, response.StatusCode)
			var card map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
			require.Equal(t, c.source, card["state"])
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			count := func() int {
				var n int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_bring-in'`).Scan(&n))
				return n
			}
			facts := count()
			code, reply := call("canonical-bring-"+c.source, fmt.Sprintf(`{"op":"bring-in","id":"foreign-1","revision":%q}`, onto))
			if c.source != "needs_you" {
				require.Equal(t, 409, code, reply)
				after, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				require.Equal(t, facts, count())
				recordTodoGuardPair(t, c.source, "bring-in", "")
				return
			}
			require.Equal(t, 202, code, reply)
			require.Equal(t, facts+1, count())
			require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.foreign_bring-in' ORDER BY sequence DESC LIMIT 1`).Scan(&raw))
			var fact map[string]any
			require.NoError(t, json.Unmarshal(raw, &fact))
			require.Equal(t, "needs_you", fact["from"])
			require.Equal(t, "needs_you", fact["to"])
			recordTodoGuardPair(t, c.source, "bring-in", fact["to"].(string))
		})
	}
	for _, c := range cases {
		for _, question := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/question=%t", c.source, question), func(t *testing.T) {
				waits := []map[string]any{{"id": "foreign-1", "kind": "foreign_push", "sha": onto, "prompt": "Outside push", "since": "2026-10-02T12:00:00Z", "by": map[string]any{"kind": "github", "login": "alice"}}}
				if question {
					waits = append(waits, map[string]any{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"})
				}
				raw, err := json.Marshal(map[string]any{"todo": true, "branch": "smithers/test", "foreignHead": onto, "run_launched": true, "run_attached": c.source != "starting", "waits": waits})
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id='',state=$2,checks=$3,pr_number=1,pr_state='open',candidate_head=$4,paused_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`, item.ID, c.engine, raw, head, c.paused)
				require.NoError(t, err)
				before, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				read := func() map[string]any {
					req, err := http.NewRequest("GET", origin+"/api/todos/1", nil)
					require.NoError(t, err)
					req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
					res, err := http.DefaultClient.Do(req)
					require.NoError(t, err)
					defer res.Body.Close()
					require.Equal(t, 200, res.StatusCode)
					var card map[string]any
					require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
					return card
				}
				from := "needs_you"
				if !c.accepted {
					from = c.source
				}
				require.Equal(t, from, read()["state"])
				count := func() int {
					var n int
					require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_bring-in'`).Scan(&n))
					return n
				}
				facts := count()
				key := fmt.Sprintf("bring-%s-%t", c.source, question)
				for _, guard := range []struct{ name, wait, sha string }{{"stale", "foreign-1", head}, {"wrong-wait", "question", onto}} {
					code, reply := call(key+"-"+guard.name, fmt.Sprintf(`{"op":"bring-in","id":%q,"revision":%q}`, guard.wait, guard.sha))
					require.Equal(t, 409, code, reply)
					unchanged, err := q.GetMythicalItem(ctx, item.ID)
					require.NoError(t, err)
					require.Equal(t, before, unchanged)
					require.Equal(t, facts, count())
				}
				code, reply := call(key, fmt.Sprintf(`{"op":"bring-in","id":"foreign-1","revision":%q}`, onto))
				after, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				if !c.accepted {
					require.Equal(t, 409, code, reply)
					require.Equal(t, before, after)
					require.Equal(t, facts, count())
					require.Equal(t, from, read()["state"])

					return
				}
				require.Equal(t, 202, code, reply)
				require.Equal(t, facts+1, count())
				require.Equal(t, before.State, after.State)
				require.Equal(t, before.PausedAt, after.PausedAt)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.CandidateHead, after.CandidateHead)
				card := read()
				require.Equal(t, "needs_you", card["state"])
				require.Len(t, card["waits"], len(waits), "admission cannot settle any wait")
				require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.foreign_bring-in' ORDER BY sequence DESC LIMIT 1`).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, "needs_you", fact["from"])
				require.Equal(t, "needs_you", fact["to"])

				actor, ok := fact["actor"].(map[string]any)
				require.True(t, ok)
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "pin-owner", actor["login"])
				code, replay := call(key, fmt.Sprintf(`{"op":"bring-in","id":"foreign-1","revision":%q}`, onto))
				require.Equal(t, 202, code)
				require.Equal(t, reply, replay)
				require.Equal(t, facts+1, count())
				duplicate, err := q.GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				require.Equal(t, after, duplicate)
			})
		}
	}
}
