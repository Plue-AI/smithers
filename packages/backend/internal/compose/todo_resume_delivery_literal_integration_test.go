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

// Production Resume admission and signal receipt ingestion, real PostgreSQL
// and installed HTTP cards. Receipt inputs do not qualify guest execution.
func TestTodoResumeDeliveryFactsComposedInstall(t *testing.T) {
	var service *services.MythicalService
	h := newTodoSignalLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	for _, failed := range []bool{false, true} {
		for _, branch := range []bool{false, true} {
			t.Run(fmt.Sprintf("failed=%t/branch=%t", failed, branch), func(t *testing.T) {
				checks := map[string]any{"todo": true, "run_launched": true, "run_attached": true, "flowSource": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "attempts": []map[string]any{{"attempt": 1, "run_id": "run-1"}}, "pause": map[string]any{"generation": 1, "run": "run-1", "requested": true, "at": "2026-10-02T12:00:00Z", "wait": services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "run-1", Name: "resume#1"}}}
				if branch {
					checks["waits"] = []map[string]any{{"id": "foreign", "kind": "foreign_push", "prompt": "Alice pushed", "since": "2026-10-02T12:00:00Z"}}
				}
				raw, err := json.Marshal(checks)
				require.NoError(t, err)
				_, err = h.pool.Exec(t.Context(), `UPDATE mythical_items SET state='running',checks=$2,attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$3,flow_digest=$4,paused_at='2026-10-02T12:00:00Z' WHERE id=$1`, h.item.ID, raw, target.WorkspaceID, rehearsalBuiltinTodoDigest(t))
				require.NoError(t, err)
				status, receipt := h.call(t, "POST", `{"op":"resume"}`, fmt.Sprintf("resume-%t-%t", failed, branch))
				require.Equal(t, 202, status, receipt)
				before, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				projection, _ := json.Marshal(map[string]any{"kind": "mythical-pause", "itemId": target.BindingID, "run": "run-1", "attempt": 1, "generation": 1, "op": "resume"})
				update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateCompleted, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, Target: target, FlowID: "todo", RunID: "run-1"}}
				kind, from, to := "todo.resume.delivered", "queued", "starting"
				if failed {
					update.State = jobs.StateFailed
					kind, to = "todo.resume.failed", "paused"
				}
				if branch {
					from, to = "needs_you", "needs_you"
				}
				count := func() int {
					var n int
					require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type=$1`, kind).Scan(&n))
					return n
				}
				events := count()
				_, err = h.pool.Exec(t.Context(), `CREATE FUNCTION refuse_resume_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type IN ('todo.resume.delivered','todo.resume.failed') THEN RAISE EXCEPTION 'injected resume fact failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_resume_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_resume_fact()`)
				require.NoError(t, err)
				require.ErrorContains(t, service.ProjectFlowRuntime(t.Context(), update), "injected resume fact failure")
				after, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				require.Equal(t, before, after)
				require.Equal(t, events, count())
				_, err = h.pool.Exec(t.Context(), `DROP TRIGGER refuse_resume_fact ON product_job_events;DROP FUNCTION refuse_resume_fact()`)
				require.NoError(t, err)
				require.NoError(t, service.ProjectFlowRuntime(t.Context(), update))
				require.Equal(t, events+1, count())
				status, card := h.call(t, "GET", "", "")
				require.Equal(t, 200, status, card)
				require.Equal(t, to, card["state"])
				after, err = h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				require.Equal(t, before.RequestRunID, after.RequestRunID)
				require.Equal(t, before.Attempt, after.Attempt)
				require.Equal(t, before.FlowDigest, after.FlowDigest)
				var factRaw []byte
				require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT data FROM product_job_events WHERE event_type=$1 ORDER BY sequence DESC LIMIT 1`, kind).Scan(&factRaw))
				var fact map[string]any
				require.NoError(t, json.Unmarshal(factRaw, &fact))
				require.Equal(t, from, fact["from"])
				require.Equal(t, to, fact["to"])
				require.Equal(t, map[string]any{"kind": "system", "id": "smithers"}, fact["actor"])
				require.NoError(t, service.ProjectFlowRuntime(t.Context(), update))
				require.Equal(t, events+1, count())
				replayed, err := h.q.GetMythicalItem(t.Context(), h.item.ID)
				require.NoError(t, err)
				require.Equal(t, after, replayed, "duplicate receipt changes no item version")
				if branch {
					require.Equal(t, "foreign", card["waits"].([]any)[0].(map[string]any)["id"])
				}
			})
		}
	}
}
