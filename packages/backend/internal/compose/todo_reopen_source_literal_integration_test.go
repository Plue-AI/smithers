package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Reopening is read through the real fetched GitHub consumer and installed
// card. Only a dropped source within its window can enter In review; no
// machine, new attempt or publication is authorized by an open snapshot.
func TestTodoReopenSourceTransitionLiteralCases(t *testing.T) {
	f := newTodoSourceCycle(t)
	cases := []struct {
		state, engine, to          string
		attached, paused, question bool
	}{
		{"queued", "queued", "queued", true, false, false},
		{"starting", "running", "starting", false, false, false},
		{"working", "running", "working", true, false, false},
		{"needs_you", "running", "needs_you", true, false, true},
		{"paused", "running", "paused", true, true, false},
		{"failed", "blocked", "failed", true, false, false},
		{"in_review", "proposed", "in_review", true, false, false},
		{"merged", "landed", "merged", true, false, false},
		{"dropped", "rejected", "in_review", true, false, false},
	}
	var items []db.MythicalItem
	for i, c := range cases {
		checks := map[string]any{"run_launched": true, "run_attached": c.attached, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}
		if c.state == "queued" {
			checks["retries"] = []map[string]any{{"attempt": 2}}
		}
		if c.question {
			checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
		}
		if c.state == "dropped" {
			checks["githubClosedAt"] = time.Unix(f.clock.Load(), 0).UTC().Format(time.RFC3339Nano)
		}
		item := f.item(t, int64(i+1), c.engine, checks, c.paused)
		if c.state == "dropped" {
			_, err := f.pool.Exec(t.Context(), `UPDATE mythical_items SET pr_state='closed' WHERE id=$1`, item.ID)
			require.NoError(t, err)
		}
		items = append(items, item)
		status, card := f.call(t, int64(i+1), "GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, c.state, card["state"])
	}
	writes := f.upstream.Writes()
	stop := f.start(t)
	defer stop()
	f.cycle(t)
	accepted, refused := 0, 0
	for i, c := range cases {
		t.Run(c.state, func(t *testing.T) {
			item := items[i]
			require.Eventually(t, func() bool {
				var n int
				err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND payload->>'number'=$1 AND state='completed'`, fmt.Sprint(item.PRNumber.Int64)).Scan(&n)
				return err == nil && n > 0
			}, 10*time.Second, 20*time.Millisecond)
			status, card := f.call(t, item.Number.Int64, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, c.to, card["state"])
			recordTodoGuardPair(t, c.state, "github_reopened", func() string {
				if c.state == "dropped" {
					return card["state"].(string)
				}
				return ""
			}())
			row, err := f.q.GetMythicalItem(t.Context(), item.ID)
			require.NoError(t, err)
			require.Equal(t, item.Attempt, row.Attempt)
			require.Equal(t, item.CandidateHead, row.CandidateHead)
			var events int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review' AND data->>'n'=$1`, fmt.Sprint(item.Number.Int64)).Scan(&events))
			if c.state != "dropped" {
				refused++
				require.Zero(t, events)
				require.Equal(t, item.RequestRunID, row.RequestRunID)
				return
			}
			accepted++
			require.Equal(t, 1, events)
			require.Empty(t, row.RequestRunID)
			var raw []byte
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.github_in_review' AND data->>'n'=$1`, fmt.Sprint(item.Number.Int64)).Scan(&raw))
			var fact map[string]any
			require.NoError(t, json.Unmarshal(raw, &fact))
			require.Equal(t, "dropped", fact["from"])
			require.Equal(t, "in_review", fact["to"])
			require.Equal(t, map[string]any{"kind": "system", "id": "github"}, fact["actor"])
		})
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 8, refused)
	f.clock.Add(46)
	f.cycle(t)
	var events int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_in_review'`).Scan(&events))
	require.Equal(t, 1, events)
	for _, write := range f.upstream.Writes()[len(writes):] {
		if strings.HasSuffix(write.Path, "/access_tokens") {
			var request struct {
				Permissions map[string]string `json:"permissions"`
			}
			require.NoError(t, json.Unmarshal(write.Body, &request))
			for _, permission := range request.Permissions {
				require.Equal(t, "read", permission, write)
			}
			continue
		}
		require.True(t, strings.HasSuffix(write.Path, "/git-upload-pack"), "a reopen must only read the retained branch: %+v", write)
	}
	t.Logf("literal open/reopen sources: %d reopen, %d retained sources, duplicate snapshot applied once", accepted, refused)
}
