package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Draft is text with no mythical item. Each producer receives a real unbound
// input, not a fabricated stored draft state, and must create no TODO fact.
func TestTodoDraftProducerGuardPairsComposedInstall(t *testing.T) {
	t.Run("scheduler", func(t *testing.T) {
		f := newTodoSourceCycle(t)
		f.cycle(t)
		var facts, items int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&items))
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&facts))
		require.Zero(t, items)
		require.Zero(t, facts)
		recordTodoGuardPair(t, "draft", "admit", "")
		recordTodoGuardPair(t, "draft", "propose", "")
	})
	t.Run("conflict", func(t *testing.T) {
		f := newTodoSourceCycle(t)
		id := "99999999-9999-4999-8999-999999999999"
		projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": id, "attempt": 1, "generation": 1, "phase": "conflict", "flowDigest": strings.Repeat("d", 64), "flowSource": strings.Repeat("a", 40)})
		target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.repository), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: id}
		require.NoError(t, f.stack.ProjectFlowRuntime(t.Context(), flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "coding/rebase-conflict", RunID: "unbound-repair", Target: target, Run: &flowruntime.Run{RunID: "unbound-repair", Status: "running", PendingWaits: []flowruntime.PendingWait{{RunID: "step", Name: "done", Token: "repair-token", Request: json.RawMessage(`{"kind":"conflict","conflict_change":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","onto_revision":"cccccccccccccccccccccccccccccccccccccccc"}`)}}}}}))
		var facts int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&facts))
		require.Zero(t, facts)
		recordTodoGuardPair(t, "draft", "conflict", "")
	})
	t.Run("discard", func(t *testing.T) {
		f := newTodoSourceCycle(t)
		code, _ := f.call(t, 999, "POST", `{"op":"discard-foreign","id":"unbound","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, "/api/branches/smithers%2Funplaced")
		require.GreaterOrEqual(t, code, 400)
		var facts int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&facts))
		require.Zero(t, facts)
		recordTodoGuardPair(t, "draft", "discard", "")
	})
	for _, op := range []string{"rebase", "bring-in"} {
		t.Run(op, func(t *testing.T) {
			f := newTodoSourceCycle(t)
			code, _ := f.call(t, 999, "POST", fmt.Sprintf(`{"op":%q,"id":"unbound","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, op), "/api/branches/smithers%2Funplaced")
			require.GreaterOrEqual(t, code, 400)
			var facts int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&facts))
			require.Zero(t, facts)
			trigger := op
			if op == "rebase" {
				trigger = "rebase-requested"
			}
			recordTodoGuardPair(t, "draft", trigger, "")
		})
	}
	t.Run("moved-off", func(t *testing.T) {
		h := newMovedOffHost(t)
		before := h.effects()
		guest := h.attach(h.service)
		h.deliver(guest, machined.Event{Seq: 1, EventID: [16]byte{83}, Payload: h.payload(h.actor, 999)}, nil)
		after := h.effects()
		require.Equal(t, before.fact, after.fact)
		require.Equal(t, before.waits, after.waits)
		require.Equal(t, before.events, after.events)
		recordTodoGuardPair(t, "draft", "moved_off", "")
	})
	for _, trigger := range []string{"foreign_push", "github_merged", "github_closed", "github_reopened", "changes_requested", "review_comment", "checks_updated"} {
		t.Run(trigger, func(t *testing.T) {
			f := newTodoSourceCycle(t)
			pull := f.openPull(t, 999)
			switch trigger {
			case "github_merged", "github_closed":
				f.upstream.UpdatePull("acme/app", pull.Number, func(p *githubfake.Pull) {
					p.State = "closed"
					if trigger == "github_merged" {
						p.Merged = true
						at := time.Unix(f.clock.Load(), 0).UTC()
						p.MergedAt = &at
						p.MergeCommitSHA = f.base
					}
				})
			case "changes_requested", "review_comment":
				review := "CHANGES_REQUESTED"
				if trigger == "review_comment" {
					review = "COMMENTED"
				}
				response, err := f.upstream.Client().Post(f.upstream.URL+"/_fake/reviews", "application/json", strings.NewReader(fmt.Sprintf(`{"repo":"acme/app","number":%d,"login":"acme","state":%q,"body":"Use the helper"}`, pull.Number, review)))
				require.NoError(t, err)
				require.Equal(t, 200, response.StatusCode)
				require.NoError(t, response.Body.Close())
			case "checks_updated":
				f.upstream.SetCheck("acme/app", pull.Head.SHA, "unit", "completed", "success")
			case "foreign_push":
				_, err := f.upstream.PushAs("acme/app", "smithers/literal-999", 7, "acme", "Outside push", map[string]string{"other.txt": "Outside bytes"})
				require.NoError(t, err)
			}
			stop := f.start(t)
			defer stop()
			f.refs(t)
			f.cycle(t)
			require.Eventually(t, func() bool {
				var n int
				return f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND payload->>'number'=$1 AND state='completed'`, fmt.Sprint(pull.Number)).Scan(&n) == nil && n > 0
			}, 10*time.Second, 20*time.Millisecond)
			if trigger == "checks_updated" || trigger == "changes_requested" || trigger == "review_comment" {
				row, err := f.q.GetGitHubSyncedRepo(t.Context(), db.GetGitHubSyncedRepoParams{OwnerLogin: "acme", RepoName: "app"})
				require.NoError(t, err)
				kind := "reviews"
				if trigger == "checks_updated" {
					kind = "checks"
				}
				require.NoError(t, f.sync.synced.ReadInstallPullFacts(t.Context(), row, pull.Number, pull.Head.SHA, kind))
				require.NoError(t, f.sync.synced.RetryStreams(t.Context()))
			}
			var facts, items int
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&items))
			require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&facts))
			require.Zero(t, items)
			require.Zero(t, facts)
			status, _ := f.call(t, 999, "GET", "", "")
			require.Equal(t, 404, status)
			recordTodoGuardPair(t, "draft", trigger, "")
		})
	}
}
