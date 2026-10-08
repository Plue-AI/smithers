package compose

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// No approval wait is seeded: a real SQLite-backed HumanTask produces it,
// the production checkpoint consumer projects it, and the installed card admits
// the real dispatcher's boolean signal. A fresh engine process consumes it.
// This receipt does not qualify the guest or the reference-host timing budget.
func TestTodoApprovalProducerAnswerComposedInstall(t *testing.T) {
	for _, answer := range []string{"true", "false"} {
		t.Run(answer, func(t *testing.T) {
			var service *services.MythicalService
			h := newTodoSignalLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
			ctx := t.Context()
			const digest = "11d0beb616ada0375414dffa11c9d9f1feb52a4b196f0db64d3d79bf33ed407e"
			const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			const workspace = "11111111-1111-4111-8111-111111111111"
			_, err := h.pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$2,flow_digest=$3,checks='{"todo":true,"run_launched":true,"run_attached":true,"flowSource":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","attempts":[{"attempt":1,"run_id":"run-1"}],"waits":[{"id":"branch","kind":"foreign_push","prompt":"Outside push","since":"2026-10-02T12:00:00Z"}]}' WHERE id=$1`, h.item.ID, workspace, digest)
			require.NoError(t, err)
			scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
			target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
			projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": target.BindingID, "attempt": 1, "generation": h.item.Generation, "phase": "todo", "flowDigest": digest, "flowSource": source})
			require.NoError(t, err)
			update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", ExecutionDigest: digest, Target: target, RunID: "run-1", Run: &flowruntime.Run{RunID: "run-1", Status: "waiting-approval"}}}
			require.NoError(t, service.ProjectFlowRuntime(ctx, update))
			count := func(table string) int {
				var n int
				predicate := " WHERE operation='flow.runtime.signal'"
				if table == "product_job_events" {
					predicate = " WHERE event_type LIKE 'todo.%'"
				}
				require.NoError(t, h.pool.QueryRow(ctx, "SELECT count(*) FROM "+table+predicate).Scan(&n))
				return n
			}
			events := count("product_job_events")
			node, err := exec.LookPath("node")
			require.NoError(t, err)
			fixture, err := filepath.Abs("testdata/todo-approval-producer.ts")
			require.NoError(t, err)
			sqlite := filepath.Join(t.TempDir(), "approval.sqlite")
			produced, err := exec.CommandContext(ctx, node, fixture, sqlite, "park").CombinedOutput()
			require.NoError(t, err, string(produced))
			var park struct {
				RunID, Reason, Token string
				Request              json.RawMessage
			}
			require.NoError(t, json.Unmarshal(produced, &park))
			require.Equal(t, "run-1", park.RunID)
			require.Equal(t, "approval", park.Reason)
			require.NotEmpty(t, park.Token)
			var request struct{ Kind, Name, Prompt string }
			require.NoError(t, json.Unmarshal(park.Request, &request))
			require.Equal(t, "confirm", request.Kind)
			require.Equal(t, "coding-plan-approval", request.Name)
			update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{RunID: park.RunID, Token: park.Token, Name: request.Name, Reason: park.Reason, Request: park.Request}}
			require.NoError(t, service.ProjectFlowRuntime(ctx, update))
			require.Equal(t, events+1, count("product_job_events"))
			status, card := h.call(t, "GET", "", "")
			require.Equal(t, 200, status)
			require.Equal(t, "needs_you", card["state"])
			waits := card["waits"].([]any)
			require.Len(t, waits, 2)
			require.Equal(t, "foreign_push", waits[0].(map[string]any)["kind"])
			approval := waits[1].(map[string]any)
			require.Equal(t, "approval", approval["kind"])
			actions := approval["actions"].([]any)
			require.Len(t, actions, 2)
			action := actions[0].(map[string]any)
			if answer == "false" {
				action = actions[1].(map[string]any)
			}
			require.Equal(t, "todo.answer", action["tag"])
			require.Equal(t, answer, action["args"].(map[string]any)["answer"])
			wait := approval["id"].(string)
			before, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			requests := count("product_job_requests")
			status, refusal := h.call(t, "POST", `{"op":"stop"}`, "approval-stop")
			require.Equal(t, 409, status, refusal)
			require.Equal(t, "todo_transition_refused", refusal["code"])
			require.Equal(t, "needs_you", refusal["from"])
			require.Equal(t, "stop", refusal["trigger"])
			status, refusal = h.call(t, "POST", fmt.Sprintf(`{"wait":%q,"answer":"yes"}`, wait), "invalid-approval", "answer")
			require.Equal(t, 400, status, refusal)
			unchanged, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			require.Equal(t, before, unchanged)
			require.Equal(t, events+1, count("product_job_events"))
			require.Equal(t, requests, count("product_job_requests"))
			// Failure after the item save cannot publish an answer or enqueue a signal.
			_, err = h.pool.Exec(ctx, `CREATE FUNCTION refuse_approval_signal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'approval signal unavailable'; END $$; CREATE TRIGGER refuse_approval_signal BEFORE INSERT ON product_job_requests FOR EACH ROW WHEN (NEW.operation='flow.runtime.signal') EXECUTE FUNCTION refuse_approval_signal()`)
			require.NoError(t, err)
			body := fmt.Sprintf(`{"wait":%q,"answer":%q}`, wait, answer)
			status, _ = h.call(t, "POST", body, "rollback-approval", "answer")
			require.Equal(t, 503, status)
			unchanged, err = h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			require.Equal(t, before, unchanged)
			require.Equal(t, events+1, count("product_job_events"))
			require.Equal(t, requests, count("product_job_requests"))
			_, err = h.pool.Exec(ctx, `DROP TRIGGER refuse_approval_signal ON product_job_requests; DROP FUNCTION refuse_approval_signal()`)
			require.NoError(t, err)
			status, receipt := h.call(t, "POST", body, "answer-approval", "answer")
			require.Equal(t, 202, status, receipt)
			require.Equal(t, events+2, count("product_job_events"))
			require.Equal(t, requests+1, count("product_job_requests"))
			var signal []byte
			require.NoError(t, h.pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&signal))
			var input struct {
				Payload bool   `json:"payload"`
				Name    string `json:"name"`
				RunID   string `json:"runId"`
			}
			require.NoError(t, json.Unmarshal(signal, &input), "HumanTask confirm requires a boolean, not a quoted string")
			require.Equal(t, answer == "true", input.Payload)
			require.Equal(t, "coding-plan-approval", input.Name)
			require.Equal(t, "run-1", input.RunID)
			completed, err := exec.CommandContext(ctx, node, fixture, sqlite, "answer", strconv.FormatBool(input.Payload)).CombinedOutput()
			require.NoError(t, err, string(completed))
			require.JSONEq(t, `{"completed":`+answer+`}`, string(completed), "the durable HumanTask consumes the admitted boolean after process restart")
			// A delayed pre-answer checkpoint cannot reopen the approval.
			require.NoError(t, service.ProjectFlowRuntime(ctx, update))
			require.Equal(t, events+2, count("product_job_events"))
			status, card = h.call(t, "GET", "", "")
			require.Equal(t, 200, status)
			require.Equal(t, "needs_you", card["state"])
			waits = card["waits"].([]any)
			require.Len(t, waits, 1)
			require.Equal(t, "branch", waits[0].(map[string]any)["id"])
			status, _ = h.call(t, "POST", body, "answer-approval", "answer")
			require.Equal(t, 202, status)
			late := "false"
			if answer == "false" {
				late = "true"
			}
			status, refusal = h.call(t, "POST", fmt.Sprintf(`{"wait":%q,"answer":%q}`, wait, late), "late-approval", "answer")
			require.Equal(t, 409, status, refusal)
			require.Equal(t, "maya", refusal["answered_by"])
			require.Equal(t, events+2, count("product_job_events"))
			require.Equal(t, requests+1, count("product_job_requests"))
		})
	}
}
