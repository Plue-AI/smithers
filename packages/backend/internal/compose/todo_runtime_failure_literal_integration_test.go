package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Literal destinations exercise the production ingestion transaction and the
// installed card. Late terminal evidence is retained without reviving a TODO.
func TestTodoRuntimeFailureTransitionLiteralCases(t *testing.T) {
	for _, failure := range []string{"uncertain", "missing-tool"} {
		t.Run(failure, func(t *testing.T) { testTodoRuntimeFailureTransitionLiteralCases(t, failure) })
	}
}

func testTodoRuntimeFailureTransitionLiteralCases(t *testing.T, failure string) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	const digest = "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e"
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cases := []struct {
		engine, from, to string
		attached         bool
	}{
		{"queued", "queued", "queued", true}, {"skipped", "queued", "queued", true},
		{"running", "starting", "failed", false}, {"running", "working", "failed", true},
		{"delivering", "working", "failed", true}, {"integrating", "working", "failed", true},
		{"verifying", "working", "failed", true}, {"proposing", "working", "failed", true},
		{"waiting", "working", "failed", true}, {"retrying", "working", "failed", true},
		{"proposed", "in_review", "in_review", true}, {"blocked", "failed", "failed", true},
		{"landed", "merged", "merged", true}, {"cancelled", "dropped", "dropped", true},
		{"rejected", "dropped", "dropped", true}, {"declined", "dropped", "dropped", true},
	}
	modes := []struct {
		name           string
		attempt        int
		run, pin       string
		paused, branch bool
	}{
		{"bound", 1, "run-1", digest, false, false}, {"prior-attempt", 2, "run-1", digest, false, false},
		{"missing-attempt", 0, "run-1", digest, false, false}, {"wrong-run", 1, "other-run", digest, false, false},
		{"wrong-pin", 1, "run-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false, false},
		{"bound-paused", 1, "run-1", digest, true, false},
		{"bound-branch", 1, "run-1", digest, false, true},
		{"bound-question", 1, "run-1", digest, false, false},
	}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&n))
		return n
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		for _, mode := range modes {
			t.Run(c.from+"/"+c.engine+"/"+mode.name, func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": true, "run_attached": c.attached, "flowSource": source, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}
				if mode.branch {
					checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
				}
				if mode.name == "bound-question" {
					checks["waits"] = []map[string]any{{"id": "question", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z", "signal": map[string]any{"run": "run-1"}}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome='',paused_at=CASE WHEN $5 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END,flow_digest=$4 WHERE id=$1`, h.item.ID, c.engine, raw, digest, mode.paused)
				require.NoError(t, err)
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				from, to := c.from, c.to
				if failure == "missing-tool" && from != "merged" && from != "dropped" {
					to = "failed"
				}
				if c.from != "merged" && c.from != "dropped" {
					if mode.paused {
						from, to = "paused", "paused"
					}
					if mode.branch {
						from, to = "needs_you", "needs_you"
					}
				}
				if mode.name == "bound-question" && from != "merged" && from != "dropped" {
					from = "needs_you"
				}
				require.Equal(t, from, card["state"])
				projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(h.item.ID.Bytes).String(), "generation": before.Generation, "attempt": mode.attempt, "phase": "todo", "flowDigest": mode.pin, "flowSource": source})
				require.NoError(t, err)
				scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", before.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
				update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateUncertain, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", ExecutionDigest: digest, RunID: mode.run, Run: &flowruntime.Run{RunID: mode.run, Status: "uncertain"}}}
				if failure == "missing-tool" {
					update.State = jobs.StateFailed
					update.Checkpoint.Run.Status = "failed"
					update.Checkpoint.FailureMissingTool = &flowdispatch.CertifiedMissingTool{Name: "git", File: "machine.json", OperationID: "literal-check"}
				}
				events := count()
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				if mode.attempt != 1 || mode.run != "run-1" || mode.pin != digest {
					require.Equal(t, before, after)
					require.Equal(t, events, count())
					refused++
					return
				}
				accepted++
				require.Equal(t, events+1, count())
				require.Equal(t, before.Attempt, after.Attempt)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.PausedAt, after.PausedAt)

				status, card = h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, to, card["state"])
				if failure == "uncertain" && c.to == "failed" {
					require.Equal(t, "blocked", after.State, "a wait must not hide the underlying failure")
				}
				if mode.name == "bound-question" {
					require.Empty(t, card["waits"], "terminal run withdraws its question")
				}
				if mode.branch && from == "needs_you" {
					require.Len(t, card["waits"], 1)
				}
				var data []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, from, fact["from"])
				require.Equal(t, to, fact["to"])
				require.Equal(t, map[string]any{"kind": "run", "id": "run-1"}, fact["actor"])
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				replayed, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replayed)
				require.Equal(t, events+1, count())
			})
		}
	}
	require.Equal(t, 64, accepted)
	require.Equal(t, 64, refused)
	t.Logf("literal failure ingestion: %d accepted evidence facts, %d binding refusals", accepted, refused)
}

// A failed launch with no host/run observation is distinct from an attached
// run failing. Only Starting can consume this attempt's pre-host failure.
func TestTodoPreHostFailureTransitionLiteralCases(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	const digest = "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e"
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cases := []struct {
		engine, from, to   string
		launched, attached bool
	}{
		{"queued", "queued", "queued", false, false},
		{"running", "starting", "failed", true, false},
		{"running", "working", "working", true, true},
		{"running", "needs_you", "needs_you", true, true},
		{"running", "paused", "paused", true, true},
		{"blocked", "failed", "failed", true, true},
		{"proposed", "in_review", "in_review", true, true},
		{"landed", "merged", "merged", true, true},
		{"cancelled", "dropped", "dropped", true, true},
	}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&n))
		return n
	}
	accepted, refused := 0, 0
	for _, c := range cases {
		for _, attempt := range []int{1, 2, 0} {
			t.Run(fmt.Sprintf("%s/attempt-%d", c.from, attempt), func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": c.launched, "run_attached": c.attached, "flowSource": source, "attempts": []map[string]any{{"attempt": 1}}}
				if c.from == "needs_you" {
					checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='',request_outcome='',flow_digest=$4,paused_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, digest, c.from == "paused")
				require.NoError(t, err)
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				events := count()
				projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(h.item.ID.Bytes).String(), "generation": before.Generation, "attempt": attempt, "phase": "todo", "flowDigest": digest, "flowSource": source})
				require.NoError(t, err)
				// No FirstStep, RunID or Run exists: the dispatcher could not start it.
				update := flowdispatch.ProjectionUpdate{Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}, State: jobs.StateUncertain, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", ExecutionDigest: digest}}
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				if c.from != "starting" || attempt != 1 {
					refused++
					require.Equal(t, before, after)
					require.Equal(t, events, count())
					return
				}
				accepted++
				require.Equal(t, events+1, count())
				require.Equal(t, "blocked", after.State)
				require.Empty(t, after.RequestRunID)
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, c.to, card["state"])
				require.Equal(t, "start", card["failure"].(map[string]any)["step"])
				var eventRaw []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated' ORDER BY sequence DESC LIMIT 1`).Scan(&eventRaw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(eventRaw, &fact))
				require.Equal(t, "starting", fact["from"])
				require.Equal(t, "failed", fact["to"])
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				require.Equal(t, events+1, count())
			})
		}
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 26, refused)
	t.Logf("literal pre-host failure: %d accepted, %d refused", accepted, refused)
}

// A resolver refusal before a run exists retains its provisioning cause on
// the card served by the composed install, rather than a generic start fault.
func TestTodoFailedLaneCardThroughComposedInstall(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	const digest = "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e"
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	checks, err := json.Marshal(map[string]any{"todo": true, "run_launched": true, "run_attached": false, "flowSource": source})
	require.NoError(t, err)
	_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state='queued',checks=$2,attempt=1,request_run_id='',request_outcome='',flow_digest=$3 WHERE id=$1`, h.item.ID, checks, digest)
	require.NoError(t, err)
	before, err := h.q.GetMythicalItem(ctx, h.item.ID)
	require.NoError(t, err)
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(h.item.ID.Bytes).String(), "generation": before.Generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
	require.NoError(t, err)
	update := flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", FailureCode: "runtime_workspace_failed"}}
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	status, card := h.call(t, "GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "failed", card["state"])
	require.Equal(t, map[string]any{"step": "provisioning", "class": "infra", "message": "Smithers could not set up a lane", "retryable": true}, card["failure"])
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	status, repeated := h.call(t, "GET", "", "")
	require.Equal(t, 200, status, repeated)
	require.Equal(t, card["failure"], repeated["failure"])
}
