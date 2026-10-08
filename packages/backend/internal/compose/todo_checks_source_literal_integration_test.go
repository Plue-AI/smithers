package compose

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Fetch through the production scoped GitHub reader and durable consumer. The
// literal source permissions never read the production transition descriptors.
func TestTodoChecksSourceTransitionLiteralCases(t *testing.T) {
	f := newTodoSourceCycle(t)
	sources := []struct {
		name, engine                         string
		paused, question, attached, accepted bool
	}{
		{"queued", "queued", false, false, true, false},
		{"starting", "running", false, false, false, false},
		{"working", "running", false, false, true, false},
		{"needs_you", "running", false, true, true, false},
		{"paused", "running", true, false, true, false},
		{"failed", "blocked", false, false, true, false},
		{"in_review", "proposed", false, false, true, true},
		{"merged", "landed", false, false, true, false},
		{"dropped", "cancelled", false, false, true, false},
	}
	var items []db.MythicalItem
	for i, source := range sources {
		checks := map[string]any{"run_launched": true, "run_attached": source.attached}
		if source.name == "queued" {
			checks["retries"] = []map[string]any{{"attempt": 2}}
		}
		if source.question {
			checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
		}
		item := f.item(t, int64(i+1), source.engine, checks, source.paused)
		f.upstream.SetCheck("acme/app", item.PRHead, "unit", "completed", "success")
		items = append(items, item)
	}
	stop := f.start(t)
	defer stop()
	f.refs(t)
	f.cycle(t)
	row, err := f.q.GetGitHubSyncedRepo(t.Context(), db.GetGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app"})
	require.NoError(t, err)
	count := func(n int64) int {
		var total int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.checks_updated' AND data->>'n'=$1`, fmt.Sprint(n)).Scan(&total))
		return total
	}
	for i, source := range sources {
		t.Run(source.name, func(t *testing.T) {
			item := items[i]
			require.Eventually(t, func() bool {
				var n int
				return f.pool.QueryRow(t.Context(), `SELECT count(*) FROM github_synced_issues WHERE resource='pulls' AND number=$1`, item.PRNumber.Int64).Scan(&n) == nil && n == 1
			}, 10*time.Second, 20*time.Millisecond)
			require.NoError(t, f.sync.synced.ReadInstallPullFacts(t.Context(), row, item.PRNumber.Int64, item.PRHead, "checks"))
			require.NoError(t, f.sync.synced.RetryStreams(t.Context()))
			if source.accepted {
				require.Eventually(t, func() bool { return count(item.Number.Int64) == 1 }, 10*time.Second, 20*time.Millisecond)
				var raw []byte
				require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type='todo.checks_updated' AND data->>'n'=$1`, fmt.Sprint(item.Number.Int64)).Scan(&raw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(raw, &fact))
				require.Equal(t, "in_review", fact["from"])
				require.Equal(t, "in_review", fact["to"])
				require.Equal(t, item.PRHead, fact["head"])
				require.Equal(t, map[string]any{"kind": "system", "id": "smithers"}, fact["actor"])
			} else {
				require.Zero(t, count(item.Number.Int64))
			}
			status, card := f.call(t, item.Number.Int64, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, source.name, card["state"])
			// Same HTTP representation/ETag is one delivery, not another self-loop.
			require.NoError(t, f.sync.synced.ReadInstallPullFacts(t.Context(), row, item.PRNumber.Int64, item.PRHead, "checks"))
			require.NoError(t, f.sync.synced.RetryStreams(t.Context()))
			require.Equal(t, boolQuestionInt(source.accepted), count(item.Number.Int64))
			// A stale reader cannot attribute another head's checks to this TODO.
			require.Error(t, f.sync.synced.ReadInstallPullFacts(t.Context(), row, item.PRNumber.Int64, f.base, "checks"))
			require.Equal(t, boolQuestionInt(source.accepted), count(item.Number.Int64))
			f.upstream.SetCheck("acme/app", item.PRHead, "unit", "completed", "failure")
			require.NoError(t, f.sync.synced.ReadInstallPullFacts(t.Context(), row, item.PRNumber.Int64, item.PRHead, "checks"))
			require.NoError(t, f.sync.synced.RetryStreams(t.Context()))
			if source.accepted {
				require.Eventually(t, func() bool { return count(item.Number.Int64) == 2 }, 10*time.Second, 20*time.Millisecond)
			} else {
				require.Zero(t, count(item.Number.Int64))
			}
			status, card = f.call(t, item.Number.Int64, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, source.name, card["state"])

		})
	}
	t.Log("literal checks-updated sources: 1 accepted self-loop, 8 non-review no-ops")
}
