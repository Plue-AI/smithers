package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Exercise production runtime ingestion and the installed HTTP card with real
// PostgreSQL. This is an attachment transaction receipt, not guest execution.
func TestTodoAttachmentAtomicComposedInstall(t *testing.T) {
	var service *services.MythicalService
	h := newTodoLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { service = s })
	ctx := t.Context()
	const digest = "e274ce85c2e7f9fdef2bb4de75700e9847920893d24e6f69d692a573ff11ed3d"
	const source = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const workspace = "11111111-1111-4111-8111-111111111111"
	_, err := h.pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=1,request_run_id='run-1',flow_digest=$2,workspace_id=$3,checks='{"todo":true,"run_launched":true,"run_attached":false,"flowSource":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","attempts":[{"attempt":1,"run_id":"run-1"}]}' WHERE id=$1`, h.item.ID, digest, workspace)
	require.NoError(t, err)
	before, err := h.q.GetMythicalItem(ctx, h.item.ID)
	require.NoError(t, err)
	status, card := h.call(t, "GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "starting", card["state"])
	// A candidate generation may change within the same attempt before attach.
	// The launch payload still identifies its original generation and run.
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(h.item.ID.Bytes).String(), "attempt": 1, "generation": before.Generation, "phase": "todo", "flowDigest": digest, "flowSource": source})
	require.NoError(t, err)
	_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, h.item.ID)
	require.NoError(t, err)
	before, err = h.q.GetMythicalItem(ctx, h.item.ID)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", before.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", RunID: "run-1", ExecutionDigest: digest,
			Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()},
			Run:    &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: "running"}}}
	count := func(table string) int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	events, requests, streams := count("product_job_events"), count("product_job_requests"), count("product_job_streams")
	for _, crossing := range []struct{ name, sql string }{
		{"after item save before fact", `CREATE TRIGGER refuse_attach BEFORE INSERT ON product_job_events FOR EACH ROW WHEN (NEW.event_type='todo.run_updated') EXECUTE FUNCTION refuse_attach()`},
		{"after item save before source cursor", `CREATE TRIGGER refuse_attach BEFORE INSERT ON product_job_streams FOR EACH ROW WHEN (NEW.principal_id='repository:todos') EXECUTE FUNCTION refuse_attach()`},
	} {
		t.Run(crossing.name, func(t *testing.T) {
			_, err := h.pool.Exec(ctx, `CREATE FUNCTION refuse_attach() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'attachment crossing unavailable'; END $$; `+crossing.sql)
			require.NoError(t, err)
			err = service.ProjectFlowRuntime(ctx, update)
			require.ErrorContains(t, err, "attachment crossing unavailable")
			rolledBack, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			require.Equal(t, before, rolledBack, "the version, binding, checks and generation roll back together")
			require.Equal(t, events, count("product_job_events"))
			require.Equal(t, requests, count("product_job_requests"))
			require.Equal(t, streams, count("product_job_streams"))
			status, card := h.call(t, "GET", "", "")
			require.Equal(t, 200, status, card)
			require.Equal(t, "starting", card["state"])
			require.Equal(t, false, card["run"].(map[string]any)["executing"])
			table := "product_job_events"
			if crossing.name == "after item save before source cursor" {
				table = "product_job_streams"
			}
			_, err = h.pool.Exec(ctx, "DROP TRIGGER refuse_attach ON "+table+"; DROP FUNCTION refuse_attach()")
			require.NoError(t, err)
		})
	}
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	attached, err := h.q.GetMythicalItem(ctx, h.item.ID)
	require.NoError(t, err)
	require.Equal(t, before.Generation, attached.Generation)
	require.Equal(t, before.Attempt, attached.Attempt)
	require.Equal(t, before.RequestRunID, attached.RequestRunID)
	require.Equal(t, events+1, count("product_job_events"))
	status, card = h.call(t, "GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "working", card["state"], "attachment has no FirstStep")
	require.Equal(t, true, card["run"].(map[string]any)["executing"])
	var data []byte
	require.NoError(t, h.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&data))
	var fact map[string]any
	require.NoError(t, json.Unmarshal(data, &fact))
	require.Equal(t, "starting", fact["from"])
	require.Equal(t, "working", fact["to"])
	require.Equal(t, map[string]any{"kind": "run", "id": "run-1"}, fact["actor"])
	require.Equal(t, "working", fact["card"].(map[string]any)["state"])
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	replayed, err := h.q.GetMythicalItem(ctx, h.item.ID)
	require.NoError(t, err)
	require.Equal(t, attached, replayed)
	require.Equal(t, events+1, count("product_job_events"), "duplicate attachment has one fact")

	// Race a member's answer with re-attachment, retaining an independent branch
	// wait throughout. The runtime still reports its ask until signal delivery;
	// that stale summary must not reopen the first accepted answer.
	store, err := jobs.NewStore(h.pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service,
		Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			t.Fatal("answer admission must not await a guest")
			return nil, nil
		})})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"foreign","kind":"foreign_push","prompt":"Outside push","since":"2026-10-02T12:00:00Z"}]') WHERE id=$1`, h.item.ID)
	require.NoError(t, err)
	for round := 0; round < 20; round++ {
		t.Run(fmt.Sprintf("answer races attachment %02d", round), func(t *testing.T) {
			racing := update
			racing.Checkpoint.Run = &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: "waiting-approval", PendingWaits: []flowruntime.PendingWait{
				{RunID: "planning-execution", Token: fmt.Sprintf("race-%d", round), Name: "ask", Reason: "approval", Request: json.RawMessage(`{"kind":"ask","prompt":"Continue?"}`)},
			}}
			require.NoError(t, service.ProjectFlowRuntime(ctx, racing))
			_, card := h.call(t, "GET", "", "")
			require.Equal(t, "needs_you", card["state"])
			waits := card["waits"].([]any)
			require.Len(t, waits, 2)
			require.Equal(t, "foreign", waits[0].(map[string]any)["id"])
			questionID := waits[1].(map[string]any)["id"].(string)
			_, err := h.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{run_attached}','false') WHERE id=$1`, h.item.ID)
			require.NoError(t, err)
			var factsBefore, signalsBefore int
			require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&factsBefore))
			require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&signalsBefore))
			start := make(chan struct{})
			projected := make(chan error, 1)
			answered := make(chan int, 1)
			go func() { <-start; projected <- service.ProjectFlowRuntime(ctx, racing) }()
			go func() {
				<-start
				body, _ := json.Marshal(map[string]any{"wait": questionID, "answer": "Continue"})
				status, _ := h.call(t, "POST", string(body), fmt.Sprintf("race-answer-%d", round), "answer")
				answered <- status
			}()
			close(start)
			select {
			case err := <-projected:
				require.NoError(t, err)
			case <-time.After(10 * time.Second):
				t.Fatal("attachment did not settle")
			}
			select {
			case status := <-answered:
				require.Equal(t, 202, status)
			case <-time.After(10 * time.Second):
				t.Fatal("answer did not settle")
			}
			saved, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			require.Equal(t, "run-1", saved.RequestRunID)
			require.Equal(t, before.Attempt, saved.Attempt)
			var factsAfter, signalsAfter int
			require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type LIKE 'todo.%'`).Scan(&factsAfter))
			require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&signalsAfter))
			require.Equal(t, factsBefore+2, factsAfter, "one attachment and one accepted answer commit")
			require.Equal(t, signalsBefore+1, signalsAfter, "one answer delivery intent")
			_, card = h.call(t, "GET", "", "")
			require.Equal(t, "needs_you", card["state"])
			waits = card["waits"].([]any)
			require.Len(t, waits, 1)
			require.Equal(t, "foreign", waits[0].(map[string]any)["id"])
			require.Equal(t, true, card["run"].(map[string]any)["executing"])
			require.Equal(t, "Continue", card["first_answer"].(map[string]any)["text"])
			require.NoError(t, service.ProjectFlowRuntime(ctx, racing))
			replayed, err := h.q.GetMythicalItem(ctx, h.item.ID)
			require.NoError(t, err)
			require.Equal(t, saved, replayed, "a late ask summary cannot undo a committed answer")
		})
	}
}
