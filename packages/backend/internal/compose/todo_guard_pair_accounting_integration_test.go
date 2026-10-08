package compose

import (
	"context"
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

// One literal ten-source table owns expectations across command guards. Empty
// cells mean refusal; no production guard or specification is read as an oracle.
// Draft is unplaced text, hence it has no row: only creation admits it, and the
// item command doors return not found. Every stored refusal names its pair.
func TestTodoCommandGuardPairAccountingComposedInstall(t *testing.T) {
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	h := newTodoSignalLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) {
		s.EnableTodoSteering()
		s.SetTodoFlow(func(context.Context, int64, string) (string, error) { return rehearsalBuiltinTodoDigest(t), nil })
	})
	digest := rehearsalBuiltinTodoDigest(t)
	_, err := h.pool.Exec(t.Context(), `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,$2,$3,'loaded')`, h.item.RepositoryID, source, digest)
	require.NoError(t, err)
	triggers := []string{"drop", "stop", "resume", "retry", "retry-current-flow", "steer"}
	sources := []struct {
		from, engine string
		destinations [6]string
	}{
		{"draft", "", [6]string{}},
		{"queued", "queued", [6]string{"dropped", "", "", "", "", "queued"}},
		{"starting", "running", [6]string{"dropped", "", "", "", "", "starting"}},
		{"working", "running", [6]string{"dropped", "working", "", "", "", "working"}},
		{"needs_you", "running", [6]string{"dropped", "needs_you", "", "", "", "needs_you"}},
		{"paused", "running", [6]string{"dropped", "", "queued", "", "", "paused"}},
		{"failed", "blocked", [6]string{"dropped", "", "", "queued", "queued", "queued"}},
		{"in_review", "proposed", [6]string{"dropped", "in_review", "", "", "", "working"}},
		{"merged", "landed", [6]string{}},
		{"dropped", "cancelled", [6]string{}},
	}
	ctx := t.Context()
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&n))
		return n
	}
	allowed, refused := 0, 0
	seen := map[string]bool{}
	for _, s := range sources {
		for i, trigger := range triggers {
			t.Run(s.from+"/"+trigger, func(t *testing.T) {
				pair := s.from + "/" + trigger
				require.False(t, seen[pair])
				seen[pair] = true
				checks := map[string]any{"todo": true, "run_launched": s.from != "queued", "run_attached": s.from != "starting", "flowSource": source, "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}}
				if s.from == "needs_you" {
					checks["waits"] = []map[string]any{{"id": "branch", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
				}
				if s.from == "paused" {
					checks["pause"] = map[string]any{"generation": 1, "run": "run-1", "requested": true, "at": "2026-10-02T12:00:00Z", "wait": services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "run-1", Name: "resume#1"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				engine := s.engine
				if engine == "" {
					engine = "queued"
				}
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$4,flow_digest=$5,pr_state='',paused_at=CASE WHEN $6 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, engine, raw, target.WorkspaceID, digest, s.from == "paused")
				require.NoError(t, err)
				// Drop source permissions use the retained, unpinned row path.
				// Final capture of an executing pinned writer is qualified separately.
				if trigger == "drop" {
					_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET flow_digest=NULL WHERE id=$1`, h.item.ID)
					require.NoError(t, err)
				}
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				events := count()
				body := fmt.Sprintf(`{"op":%q}`, trigger)
				if trigger == "steer" {
					body = `{"steer":"Keep the public API"}`
				}
				path := "/api/todos/1"
				if s.from == "draft" {
					path = "/api/todos/999"
				}
				if s.from != "draft" {
					status, card := h.call(t, "GET", "", "", path)
					require.Equal(t, 200, status)
					require.Equal(t, s.from, card["state"])
				}
				status, receipt := h.call(t, "POST", body, "pair-"+s.from+"-"+trigger, path)
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				recordTodoGuardPair(t, s.from, trigger, s.destinations[i])
				if s.destinations[i] == "" {
					refused++
					if s.from == "draft" {
						require.Equal(t, 404, status, receipt)
					} else {
						require.Equal(t, 409, status, receipt)
						require.Equal(t, "todo_transition_refused", receipt["code"])
						require.Equal(t, s.from, receipt["from"])
						require.Equal(t, trigger, receipt["trigger"])
					}
					require.Equal(t, before, after)
					require.Equal(t, events, count())
					return
				}
				allowed++
				require.Equal(t, 202, status, receipt)
				require.Equal(t, events+1, count(), "one accepted pair, one fact")
				var data []byte
				require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type LIKE 'todo.%' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(data, &fact))
				require.Equal(t, s.from, fact["from"])
				require.Equal(t, s.destinations[i], fact["to"])
				actor := fact["actor"].(map[string]any)
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "maya", actor["login"])
				if id, ok := actor["id"]; ok {
					require.Equal(t, float64(h.owner), id)
				}
				status, card := h.call(t, "GET", "", "", path)
				require.Equal(t, 200, status)
				require.Equal(t, s.destinations[i], card["state"])
			})
		}
	}
	require.Len(t, seen, 60)
	require.Equal(t, 20, allowed)
	require.Equal(t, 40, refused)
	t.Logf("literal command pairs: %d allowed, %d refused; 10 sources × 6 triggers = %d", allowed, refused, len(seen))
}

// Attachment and run waits use the production checkpoint transaction. Before
// attachment a HumanTask has no bound run to answer; its unbound report cannot
// jump from Starting to Needs you. Attachment itself remains a separate fact.
func TestTodoRuntimeGuardPairAccountingComposedInstall(t *testing.T) {
	const digest = "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e"
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	triggers := []string{"run_attached", "question", "approval", "start_failed", "run_uncertain", "missing_tool", "run_failed", "park"}
	sources := []struct {
		from, engine string
		destinations [8]string
	}{
		{"draft", "", [8]string{}},
		{"queued", "queued", [8]string{}},
		{"starting", "running", [8]string{"working", "", "", "failed", "failed", "failed", "failed", "working"}},
		{"working", "running", [8]string{"working", "needs_you", "needs_you", "", "failed", "failed", "failed", "paused"}},
		{"needs_you", "running", [8]string{"needs_you", "needs_you", "needs_you", "", "needs_you", "needs_you", "needs_you", "needs_you"}},
		{"paused", "running", [8]string{"paused", "", "", "", "paused", "paused", "paused", "paused"}},
		{"failed", "blocked", [8]string{"", "", "", "", "failed", "failed", "failed"}},
		{"in_review", "proposed", [8]string{"in_review", "", "", "", "in_review", "failed", "in_review", "paused"}},
		{"merged", "landed", [8]string{"", "", "", "", "merged", "merged", "merged"}},
		{"dropped", "cancelled", [8]string{"", "", "", "", "dropped", "dropped", "dropped"}},
	}
	ctx := t.Context()
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&n))
		return n
	}
	allowed, refused := 0, 0
	for _, s := range sources {
		for i, trigger := range triggers {
			t.Run(s.from+"/"+trigger, func(t *testing.T) {
				run := "run-1"
				if trigger == "start_failed" {
					run = ""
				}
				checks := map[string]any{"todo": true, "flowSource": source, "run_launched": s.from != "queued", "run_attached": s.from != "starting", "attempts": []map[string]any{{"attempt": 1, "run_id": run}}}
				if s.from == "needs_you" {
					checks["waits"] = []map[string]any{{"id": "branch", "kind": "foreign_push", "prompt": "Outside push", "since": "2026-10-02T12:00:00Z"}}
				}
				if trigger == "park" && (s.from == "working" || s.from == "needs_you" || s.from == "paused" || s.from == "in_review") {
					checks["pause"] = map[string]any{"generation": 1, "run": run, "requested": true}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				engine := s.engine
				if engine == "" {
					engine = "queued"
				}
				_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id=$4,request_outcome='',workspace_id=$5,flow_digest=$6,pr_state='',paused_at=CASE WHEN $7 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, engine, raw, run, target.WorkspaceID, digest, s.from == "paused")
				require.NoError(t, err)
				id := target.BindingID
				if s.from == "draft" {
					id = "99999999-9999-4999-8999-999999999999"
				}
				projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": id, "generation": h.item.Generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
				require.NoError(t, err)
				update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", ExecutionDigest: digest, RunID: run, Target: target, Run: &flowruntime.Run{RunID: run, Status: "running"}}}
				if trigger == "question" || trigger == "approval" {
					if s.from == "starting" {
						update.Checkpoint.RunID = ""
						update.Checkpoint.Run.RunID = ""
					} else {
						require.NoError(t, service.ProjectFlowRuntime(ctx, update))
					}
					kind := "ask"
					if trigger == "approval" {
						kind = "confirm"
					}
					request, _ := json.Marshal(map[string]string{"kind": kind, "prompt": "Proceed?"})
					update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{RunID: "step-3", Token: "human-token", Name: "choice", Reason: "approval", Request: request}}
				}
				if trigger == "run_uncertain" {
					update.State = jobs.StateUncertain
					update.Checkpoint.Run.Status = "uncertain"
				}
				if trigger == "park" {
					update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{RunID: "parked-child", Name: "resume#1", Token: "real-pause-token", Reason: "approval", Request: json.RawMessage(`{"kind":"pause"}`)}}
				}
				if trigger == "run_failed" {
					update.State = jobs.StateFailed
					update.Checkpoint.Run.Status = "failed"
					update.Checkpoint.Run.FailureFault = "user"
					update.Checkpoint.Run.FailureTag = "literal_runtime_failure"
				}
				if trigger == "missing_tool" {
					update.State = jobs.StateFailed
					update.Checkpoint.Run.Status = "failed"
					update.Checkpoint.FailureMissingTool = &flowdispatch.CertifiedMissingTool{Name: "git", File: "machine.json", OperationID: "pair-missing-tool"}
				}
				if trigger == "start_failed" {
					update.State = jobs.StateUncertain
					update.Checkpoint.Run = nil
				}
				before, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				if s.from != "draft" {
					status, card := h.call(t, "GET", "", "")
					require.Equal(t, 200, status)
					require.Equal(t, s.from, card["state"])
				}
				events := count()
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				after, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				expected := s.from
				if s.destinations[i] == "" {
					refused++
					require.Equal(t, before, after)
					require.Equal(t, events, count())
				} else {
					allowed++
					expected = s.destinations[i]
					require.Equal(t, events+1, count())
					var data []byte
					require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated' ORDER BY sequence DESC LIMIT 1`).Scan(&data))
					var fact map[string]any
					require.NoError(t, json.Unmarshal(data, &fact))
					require.Equal(t, s.from, fact["from"])
					require.Equal(t, expected, fact["to"])
					if trigger != "start_failed" {
						require.Equal(t, map[string]any{"kind": "run", "id": "run-1"}, fact["actor"])
					}
				}
				require.NoError(t, service.ProjectFlowRuntime(ctx, update))
				replay, err := h.q.GetMythicalItem(ctx, h.item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replay)
				require.Equal(t, events+boolQuestionInt(s.destinations[i] != ""), count())
				recordTodoGuardPair(t, s.from, trigger, s.destinations[i])
				if s.from != "draft" {
					status, card := h.call(t, "GET", "", "")
					require.Equal(t, 200, status)
					require.Equal(t, expected, card["state"])
				}
			})
		}
	}
	require.Equal(t, 39, allowed)
	require.Equal(t, 41, refused)
	t.Logf("literal runtime pairs: %d allowed, %d refused; 10 sources × 8 triggers = %d", allowed, refused, allowed+refused)
}
