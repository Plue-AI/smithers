package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Resume admits its bound parked run. Its HTTP acknowledgment is not a runtime
// completion; the protocol/card journey proves the subsequent park settlement.
func TestTodoResumeTransitionLiteralCases(t *testing.T) {
	h := newTodoSignalLiteralInstall(t)
	digest := rehearsalBuiltinTodoDigest(t) // Input identity; permission expectations stay literal.
	ctx := t.Context()
	cases := []struct {
		engine, plain, resumed string
		unmerged               bool
	}{
		{"queued", "queued", "queued", true}, {"skipped", "queued", "queued", true},
		{"running", "working", "queued", true}, {"delivering", "working", "queued", true},
		{"integrating", "working", "queued", true}, {"verifying", "working", "queued", true},
		{"proposing", "working", "queued", true}, {"waiting", "working", "queued", true},
		{"retrying", "retrying", "queued", true}, {"proposed", "in_review", "queued", true},
		{"blocked", "failed", "queued", true}, {"landed", "merged", "merged", false},
		{"cancelled", "dropped", "dropped", false}, {"rejected", "dropped", "dropped", false},
		{"declined", "dropped", "dropped", false},
	}
	modes := []struct {
		name           string
		parked, branch bool
	}{
		{"unpaused", false, false}, {"parked", true, false}, {"parked branch wait", true, true},
	}
	count := func(table, predicate string) int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE "+predicate).Scan(&n))
		return n
	}
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	accepted, refused := 0, 0
	for _, c := range cases {
		for _, mode := range modes {
			t.Run(c.engine+"/resume/"+mode.name, func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": true, "run_attached": true, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
				if mode.parked {
					checks["pause"] = map[string]any{"generation": 1, "run": "run-1", "requested": true, "at": "2026-10-02T12:00:00Z", "wait": services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "run-1", Name: "resume#1"}}
				}
				if mode.branch {
					checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$4,flow_digest=$6,paused_at=CASE WHEN $5 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, target.WorkspaceID, mode.parked, digest)
				require.NoError(t, err)
				from := c.plain
				if c.unmerged && mode.parked {
					from = "paused"
				}
				if c.unmerged && mode.branch {
					from = "needs_you"
				}
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, from, card["state"])
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				events := count("product_job_events", "event_type LIKE 'todo.%'")
				signals := count("product_job_requests", "operation='flow.runtime.signal'")
				key := fmt.Sprintf("literal-resume-%s-%t-%t", c.engine, mode.parked, mode.branch)
				status, receipt := h.call(t, "POST", `{"op":"resume"}`, key)
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				if !c.unmerged || !mode.parked {
					require.Equal(t, 409, status, receipt)
					require.Equal(t, "todo_transition_refused", receipt["code"])
					require.Equal(t, from, receipt["from"])
					require.Equal(t, "resume", receipt["trigger"])
					require.Equal(t, before, after)
					require.Equal(t, events, count("product_job_events", "event_type LIKE 'todo.%'"))
					require.Equal(t, signals, count("product_job_requests", "operation='flow.runtime.signal'"))
					refused++
					return
				}
				require.Equal(t, 202, status, receipt)
				require.Equal(t, before.State, after.State)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.Attempt, after.Attempt)
				require.Equal(t, before.FlowDigest, after.FlowDigest)
				require.False(t, after.PausedAt.Valid)
				var saved struct {
					Attached bool `json:"run_attached"`
					Pause    struct {
						Requested, Resuming, Delivered bool
						Run                            string
					} `json:"pause"`
					Waits []struct {
						ID        string
						SettledAt *string `json:"settled_at"`
					} `json:"waits"`
				}
				require.NoError(t, json.Unmarshal(after.Checks, &saved))
				require.False(t, saved.Attached)
				require.True(t, saved.Pause.Requested)
				require.True(t, saved.Pause.Resuming)
				require.False(t, saved.Pause.Delivered)
				require.Equal(t, "run-1", saved.Pause.Run)
				if mode.branch {
					require.Len(t, saved.Waits, 1)
					require.Equal(t, "foreign", saved.Waits[0].ID)
					require.Nil(t, saved.Waits[0].SettledAt)
				} else {
					require.Empty(t, saved.Waits)
				}
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				require.Equal(t, signals+1, count("product_job_requests", "operation='flow.runtime.signal'"))
				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				expected := c.resumed
				if mode.branch {
					expected = "needs_you"
				}
				require.Equal(t, expected, card["state"])
				var factRaw []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.resume.requested' ORDER BY sequence DESC LIMIT 1`).Scan(&factRaw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(factRaw, &fact))
				require.Equal(t, from, fact["from"])
				require.Equal(t, expected, fact["to"])
				require.Equal(t, "maya", fact["actor"].(map[string]any)["login"])
				require.Contains(t, card, "pause", "admission is not completion")
				replayStatus, replay := h.call(t, "POST", `{"op":"resume"}`, key)
				require.Equal(t, 202, replayStatus, replay)
				require.Equal(t, receipt, replay)
				replayed, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replayed)
				require.Equal(t, events+1, count("product_job_events", "event_type LIKE 'todo.%'"))
				require.Equal(t, signals+1, count("product_job_requests", "operation='flow.runtime.signal'"))
				accepted++
			})
		}
	}
	require.Equal(t, 22, accepted)
	require.Equal(t, 23, refused)
	t.Logf("literal Resume cases: %d accepted, %d refused", accepted, refused)
}
