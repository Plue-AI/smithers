package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Literal permissions are independent of the production transition table.
// Reviews enter through the GitHub HTTP transport and fetched worker; each
// result is read through the installed card route, not a guard helper.
func TestTodoReviewSourceTransitionLiteralCases(t *testing.T) {
	f := newTodoSourceCycle(t)
	f.stack.EnableTodoPublication(f.credentials, f.sync.connections, nil)
	_, err := f.pool.Exec(t.Context(), `UPDATE collaborators SET github_id=7,github_login='acme' WHERE repository_id=$1 AND user_id=$2`, f.repository, f.user.ID)
	require.NoError(t, err)
	sources := []struct {
		name, engine, to    string
		held, steer, paused bool
	}{
		{"queued", "queued", "queued", true, false, false},
		{"starting", "queued", "starting", true, false, false},
		{"working", "running", "working", false, true, false},
		{"needs_you", "running", "needs_you", false, true, false},
		{"paused", "running", "paused", true, false, true},
		{"failed", "blocked", "failed", true, false, false},
		{"in_review", "proposed", "working", false, true, false},
		{"merged", "landed", "merged", false, false, false},
		{"dropped", "cancelled", "dropped", false, false, false},
	}
	type fixture struct {
		item        db.MythicalItem
		name, to    string
		held, steer bool
	}
	var fixtures []fixture
	for _, source := range sources {
		for _, review := range []string{"CHANGES_REQUESTED", "COMMENTED"} {
			n := int64(len(fixtures) + 1)
			checks := map[string]any{"run_launched": true, "run_attached": true, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}
			if source.name == "queued" {
				checks["retries"] = []map[string]any{{"attempt": 2, "key": "retry"}}
			}
			if source.name == "starting" {
				checks["run_attached"] = false
			}
			if source.name == "needs_you" {
				checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
			}
			item := f.item(t, n, source.engine, checks, source.paused)
			body := fmt.Sprintf(`{"repo":"acme/app","number":%d,"login":"acme","state":%q,"body":"Use the shared helper %d"}`, item.PRNumber.Int64, review, n)
			response, err := f.upstream.Client().Post(f.upstream.URL+"/_fake/reviews", "application/json", strings.NewReader(body))
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, response.StatusCode)
			require.NoError(t, response.Body.Close())
			fixtures = append(fixtures, fixture{item, source.name + "/" + review, source.to, source.held, source.steer})
		}
	}
	f.start(t)
	f.clock.Store(time.Now().Unix() + 2)
	f.cycle(t)
	f.refs(t)
	row, err := f.q.GetGitHubSyncedRepo(t.Context(), db.GetGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app"})
	require.NoError(t, err)
	// Exercise the production per-PR review reader for every literal source,
	// independently of the offering phase's scheduled follow cadence.
	for _, fixture := range fixtures {
		require.Eventually(t, func() bool {
			var cached int
			err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM github_synced_issues WHERE resource='pulls' AND number=$1`, fixture.item.PRNumber.Int64).Scan(&cached)
			return err == nil && cached == 1
		}, 10*time.Second, 20*time.Millisecond)
		require.NoError(t, f.sync.synced.ReadInstallPullFacts(t.Context(), row, fixture.item.PRNumber.Int64, fixture.item.PRHead, "reviews"))
	}
	accepted, recordOnly := 0, 0
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			var next db.MythicalItem
			require.Eventually(t, func() bool {
				var err error
				next, err = f.q.GetMythicalItem(t.Context(), fixture.item.ID)
				if err != nil {
					return false
				}
				var checks struct {
					Inputs []json.RawMessage `json:"githubInputs"`
				}
				if json.Unmarshal(next.Checks, &checks) != nil {
					return false
				}
				return len(checks.Inputs) == 1
			}, 10*time.Second, 20*time.Millisecond)
			status, card := f.call(t, fixture.item.Number.Int64, "GET", "", "")
			require.Equal(t, 200, status)
			require.Equal(t, fixture.to, card["state"])
			var checks struct {
				Steers []struct {
					ReleasePending bool  `json:"release_pending"`
					Author         int64 `json:"author"`
				} `json:"steers"`
				Waits []struct {
					ID        string     `json:"id"`
					SettledAt *time.Time `json:"settled_at"`
				} `json:"waits"`
			}
			require.NoError(t, json.Unmarshal(next.Checks, &checks))
			if fixture.held || fixture.steer {
				accepted++
				require.Len(t, checks.Steers, 1)
				require.Equal(t, fixture.held, checks.Steers[0].ReleasePending)
			} else {
				recordOnly++
				require.Empty(t, checks.Steers)
			}
			var intents int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer' AND payload->>'body'=$1`, fmt.Sprintf("Use the shared helper %d", fixture.item.Number.Int64)).Scan(&intents))
			expectedIntents := 0
			if fixture.steer {
				expectedIntents = 1
			}
			require.Equal(t, expectedIntents, intents)
			var events int
			var raw []byte
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*),min(data::text)::jsonb FROM product_job_events WHERE event_type='todo.github_input' AND data->>'n'=$1`, fmt.Sprint(fixture.item.Number.Int64)).Scan(&events, &raw))
			require.Equal(t, 1, events)
			var fact map[string]any
			require.NoError(t, json.Unmarshal(raw, &fact))
			require.Equal(t, strings.Split(fixture.name, "/")[0], fact["from"])
			require.Equal(t, fixture.to, fact["to"])
			parts := strings.Split(fixture.name, "/")
			trigger := "review_comment"
			if parts[1] == "CHANGES_REQUESTED" {
				trigger = "changes_requested"
			}
			recordTodoGuardPair(t, parts[0], trigger, fact["to"].(string))
			require.Equal(t, fact["by"], fact["actor"])
			require.Equal(t, "person", fact["actor"].(map[string]any)["kind"])
			if strings.HasPrefix(fixture.name, "needs_you/") {
				require.Len(t, checks.Waits, 1)
				require.Equal(t, "question", checks.Waits[0].ID)
				require.Nil(t, checks.Waits[0].SettledAt)
			}
		})
	}
	require.Equal(t, 14, accepted)
	require.Equal(t, 4, recordOnly)
	f.clock.Add(46)
	f.cycle(t)
	var events int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_input'`).Scan(&events))
	require.Equal(t, 18, events)
	t.Logf("literal review source matrix: %d accepted inputs, %d terminal record-only inputs", accepted, recordOnly)
}
