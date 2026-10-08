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

// Retained conflict receipts are literal inputs. The real runtime ingestion
// transaction, jobs projection and install HTTP card enforce admission; this
// does not qualify a reference guest or manufacture a native resolution.
func TestTodoRuntimeConflictTransitionLiteralCases(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	digest := "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e"
	source := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	change, onto := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccccccccccccccc"
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	cases := []struct {
		name, engine            string
		paused, existing, allow bool
	}{
		{"queued", "queued", false, false, true}, {"starting", "running", false, false, true},
		{"working", "running", false, false, true}, {"needs_you", "running", false, true, true},
		{"paused", "running", true, false, true}, {"failed", "blocked", false, false, true},
		{"in_review", "proposed", false, false, true}, {"merged", "landed", false, false, false},
		{"dropped", "cancelled", false, false, false},
	}
	accepted, refused := 0, 0
	for _, phase := range []string{"todo", "conflict"} {
		for _, c := range cases {
			for _, valid := range []bool{true, false} {
				t.Run(fmt.Sprintf("%s/%s/bound=%t", phase, c.name, valid), func(t *testing.T) {
					checks := map[string]any{"todo": true, "run_launched": true, "run_attached": c.name != "starting", "flowSource": source, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}, "rebase": map[string]any{"onto": onto, "name": "main"}, "conflictReservation": map[string]any{"run": "run-1", "change": change, "onto": onto, "limit": 1}}
					run, flow := "run-1", "todo"
					if phase == "conflict" {
						run, flow = "repair-run", "coding/rebase-conflict"
						checks["conflictReservation"].(map[string]any)["resolution_run"] = run
						checks["conflictReservation"].(map[string]any)["dispatched"] = true
					}
					if c.existing {
						checks["waits"] = []map[string]any{{"id": "question-1", "kind": "question", "prompt": "Choose", "since": "2026-10-02T12:00:00Z"}}
					}
					raw, err := json.Marshal(checks)
					require.NoError(t, err)
					integration, _ := json.Marshal(map[string]any{"conflict": map[string]any{"head": change, "onto": onto, "paths": []string{"a.txt"}}})
					_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,integration=$4,workspace_id=$5,attempt=1,request_run_id='run-1',request_outcome='',flow_digest=$6,paused_at=CASE WHEN $7 THEN now() ELSE NULL END WHERE id=$1`, h.item.ID, c.engine, raw, integration, target.WorkspaceID, digest, c.paused)
					require.NoError(t, err)
					projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": target.BindingID, "generation": h.item.Generation, "attempt": 1, "phase": phase, "flowDigest": digest, "flowSource": source})
					update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Scope: scope, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: flow, ExecutionDigest: digest, Projection: projection, Target: target, RunID: run, Run: &flowruntime.Run{RunID: run, Status: "running", PendingWaits: []flowruntime.PendingWait{{RunID: "conflict-step", Token: "conflict-token", Name: "done", Request: json.RawMessage(`{"kind":"unknown"}`)}}}}}
					// First establish unchanged runtime evidence, isolating the wait fact.
					if c.name != "starting" || !valid || phase == "conflict" {
						require.NoError(t, service.ProjectFlowRuntime(ctx, update))
					}
					before, err := h.q.GetMythicalItem(ctx, h.item.ID)
					require.NoError(t, err)
					count := func() int {
						var n int
						require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&n))
						return n
					}
					events := count()
					requestedOnto := onto
					if !valid {
						requestedOnto = source
					}
					request, _ := json.Marshal(map[string]string{"kind": "conflict", "conflict_change": change, "onto_revision": requestedOnto})
					update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{RunID: "conflict-step", Token: "conflict-token", Name: "done", Request: request}}
					require.NoError(t, service.ProjectFlowRuntime(ctx, update))
					after, err := h.q.GetMythicalItem(ctx, h.item.ID)
					require.NoError(t, err)
					if valid && ((phase == "todo" && c.name == "starting") || (phase == "conflict" && c.name != "starting")) {
						recordTodoGuardPair(t, c.name, "conflict", func() string {
							if c.allow {
								return "needs_you"
							}
							return ""
						}())
					}
					expected := c.name
					if c.name == "starting" && !valid && phase == "todo" {
						expected = "working"
					}

					// A failed composition cannot revive itself with a late checkpoint;
					// only its separately bound repair run may open that branch wait.
					allow := c.allow && valid && !(phase == "conflict" && c.name == "starting") && !(phase == "todo" && c.name == "failed")
					if allow {
						accepted++
						expected = "needs_you"
						require.Equal(t, events+1, count())
						var facts struct {
							Waits []services.TodoWait `json:"waits"`
						}
						require.NoError(t, json.Unmarshal(after.Checks, &facts))
						require.Len(t, facts.Waits, 1+boolQuestionInt(c.existing))
						require.Equal(t, "conflict", facts.Waits[len(facts.Waits)-1].Kind)
						var data []byte
						require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
						var fact map[string]any
						require.NoError(t, json.Unmarshal(data, &fact))
						from := c.name

						require.Equal(t, from, fact["from"])
						require.Equal(t, "needs_you", fact["to"])
						require.Equal(t, map[string]any{"kind": "run", "id": run}, fact["actor"])
					} else {
						refused++
						require.Equal(t, before, after)
						require.Equal(t, events, count())
					}
					require.NoError(t, service.ProjectFlowRuntime(ctx, update))
					require.Equal(t, events+boolQuestionInt(allow), count(), "duplicate wait writes no fact")
					status, card := h.call(t, "GET", "", "")
					require.Equal(t, 200, status, card)
					require.Equal(t, expected, card["state"])
				})
			}
		}
	}
	require.Equal(t, 12, accepted)
	require.Equal(t, 24, refused)
	t.Logf("conflict source cases: %d accepted, %d refused", accepted, refused)
}
