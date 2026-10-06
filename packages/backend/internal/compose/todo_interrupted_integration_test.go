package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestTodoInterruptedComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-06T01:00:00Z"}`, repo.ID))}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "running", Checks: []byte(`{"todo":true,"run_launched":true,"run_attached":false}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,request_run_id='run-1',title='Interrupted',stack_position=1 WHERE id=$1`, item.ID, owner.ID)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]), "generation": item.Generation, "attempt": 1, "phase": "request"})
	raw := "interrupted-session"
	hash := sha256.Sum256([]byte(raw))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	call := func(method, body, key string) (int, map[string]any) {
		req, err := http.NewRequest(method, origin+"/api/todos/1", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: raw})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var value map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&value))
		return res.StatusCode, value
	}
	// Re-admission after a candidate generation change continues the same
	// bound attempt without a first-step event. Wrong identities are inert.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, item.ID)
	require.NoError(t, err)
	status, card := call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "starting", card["state"])
	var beforeEvents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&beforeEvents))
	for _, run := range []string{"", "wrong-run"} {
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: run}}))
	}
	var wrongAttempt map[string]any
	require.NoError(t, json.Unmarshal(projection, &wrongAttempt))
	wrongAttempt["attempt"] = 2
	stale, err := json.Marshal(wrongAttempt)
	require.NoError(t, err)
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: stale, RunID: "run-1"}}))
	var afterEvents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, beforeEvents, afterEvents)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "starting", card["state"])
	// Failure after saving the item but before recording its fact must roll
	// back the attachment, including the optimistic version increment.
	before, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_attachment_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'attachment fact failure'; END $$`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `CREATE TRIGGER refuse_attachment_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_attachment_fact()`)
	require.NoError(t, err)
	require.ErrorContains(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}), "attachment fact failure")
	after, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, beforeEvents, afterEvents)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_attachment_fact ON product_job_events`)
	require.NoError(t, err)
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}))
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "working", card["state"])
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, beforeEvents+1, afterEvents)
	// Replayed attachment produces no second lifecycle fact.
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, beforeEvents+1, afterEvents)
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateUncertain, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}))
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "failed", card["state"])
	require.Equal(t, map[string]any{"step": "runtime", "class": "interrupted", "message": "Interrupted", "retryable": true}, card["failure"])
	status, receipt := call("POST", `{"op":"retry"}`, "retry-1")
	require.Equal(t, 202, status, receipt)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status)
	require.Equal(t, "queued", card["state"])
	require.NotContains(t, card, "failure")
	// A reconnect can resend the same Retry. It must return the durable
	// receipt without creating another attempt or another lifecycle fact.
	var retryEvents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&retryEvents))
	queuedItem, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, float64(2), receipt["attempt"])
	status, replay := call("POST", `{"op":"retry"}`, "retry-1")
	require.Equal(t, 202, status, replay)
	require.Equal(t, receipt, replay)
	replayedItem, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, queuedItem, replayedItem)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, retryEvents, afterEvents)
	// Late observations from the interrupted run cannot fail the new attempt.
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateUncertain, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}))
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "queued", card["state"])
	require.NotContains(t, card, "failure")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, retryEvents, afterEvents)
	// Current-flow retry refuses before changing the failed item without an Active provider.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked',pr_state='open' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	status, receipt = call("POST", `{"op":"retry-current-flow"}`, "current-1")
	require.Equal(t, 503, status, receipt)
	current, err := q.GetMythicalItemByNumber(ctx, repo.ID, 1)
	require.NoError(t, err)
	require.Equal(t, "blocked", current.State)
	source := strings.Repeat("b", 40)
	digest := strings.Repeat("c", 64)
	activeSource := strings.Repeat("d", 40)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, repo.ID, source)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active,source_commit,digest,status) VALUES($1,'todo','flows/todo/flow.ts','{}',true,$2,$3,'loaded')`, repo.ID, activeSource, digest)
	require.NoError(t, err)
	service.SetTodoFlow(func(ctx context.Context, repository int64, commit string) (string, error) {
		require.Equal(t, repo.ID, repository)
		require.Equal(t, source, commit)
		return services.ActiveFlowDigest(ctx, q, repository, "todo")
	})
	status, receipt = call("POST", `{"op":"retry-current-flow","steer":"use the current helper"}`, "current-1")
	require.Equal(t, 202, status, receipt)
	require.EqualValues(t, 2, receipt["attempt"])
	current, err = q.GetMythicalItemByNumber(ctx, repo.ID, 1)
	require.NoError(t, err)
	require.Equal(t, "queued", current.State)
	require.False(t, current.FlowDigest.Valid, "the earlier attempt pin is unchanged until the next launch")
	var checks map[string]any
	require.NoError(t, json.Unmarshal(current.Checks, &checks))
	retries := checks["retries"].([]any)
	retryPin := retries[len(retries)-1].(map[string]any)["pin"].(map[string]any)
	require.Equal(t, activeSource, retryPin["sourceCommit"], "Active keeps its successfully loaded source after main moves")
	require.Equal(t, digest, retryPin["executionDigest"])
	status, currentReplay := call("POST", `{"op":"retry-current-flow","steer":"use the current helper"}`, "current-1")
	require.Equal(t, 202, status, currentReplay)
	require.Equal(t, receipt, currentReplay)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "queued", card["state"], "the earlier open PR does not hide a queued retry")
	status, mismatch := call("POST", `{"op":"retry"}`, "current-1")
	require.Equal(t, 409, status, mismatch)
	t.Run("Drop cancels the attempt across candidate generations atomically", func(t *testing.T) {
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service,
			Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
				return nil, errors.New("no host should be contacted by admission or Drop")
			})})
		require.NoError(t, err)
		service.SetLauncher(dispatcher)
		scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
		admit := func(request, itemID string, attempt int, principal string) string {
			launchScope := scope
			launchScope.PrincipalID = principal
			binding, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": itemID, "attempt": attempt, "generation": 1, "phase": "request"})
			require.NoError(t, err)
			receipt, err := dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: launchScope, RequestID: request,
				Target: flowruntime.Target{TenantID: launchScope.TenantID, PrincipalID: principal, WorkspaceID: "todo-lane", BindingKind: "mythical-item", BindingID: itemID},
				FlowID: "coding/request", Payload: []byte(`{"prompt":"continue"}`), Projection: binding})
			require.NoError(t, err)
			return receipt.OperationID
		}
		id := fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16])
		own := admit("old-generation-current-attempt", id, 2, scope.PrincipalID)
		otherAttempt := admit("prior-attempt", id, 1, scope.PrincipalID)
		otherItem := admit("other-item", "11111111-1111-1111-1111-111111111111", 2, scope.PrincipalID)
		otherPrincipal := admit("other-principal", id, 2, "user:999")
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running',generation=9,attempt=2,paused_at=NOW(),pending_op=NULL,
		 checks='{"todo":true,"run_launched":true,"run_attached":true,"waits":[{"id":"question","kind":"question","prompt":"Which?","since":"2026-10-06T00:00:00Z"},{"id":"foreign","kind":"foreign_push","prompt":"Push","since":"2026-10-06T00:00:00Z"}]}' WHERE id=$1`, item.ID)
		require.NoError(t, err)
		before, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		// Cancellation, wait settlement and the event must all roll back when
		// the event insert fails after cancellation has been requested.
		_, err = pool.Exec(ctx, `CREATE TRIGGER refuse_attachment_fact BEFORE INSERT ON product_job_events FOR EACH ROW WHEN (NEW.event_type='todo.dropped') EXECUTE FUNCTION refuse_attachment_fact()`)
		require.NoError(t, err)
		status, _ := call("POST", `{"op":"drop"}`, "drop-after-generation")
		require.Equal(t, 503, status)
		after, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, before, after)
		cancelled := func(operation string) bool {
			var value bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT cancellation_requested FROM product_job_requests WHERE id=$1`, operation).Scan(&value))
			return value
		}
		require.False(t, cancelled(own))
		_, err = pool.Exec(ctx, `DROP TRIGGER refuse_attachment_fact ON product_job_events`)
		require.NoError(t, err)
		status, _ = call("POST", `{"op":"drop"}`, "drop-after-generation")
		require.Equal(t, 202, status)
		require.True(t, cancelled(own), "candidate generation changes cannot orphan the continuing run")
		for _, untouched := range []string{otherAttempt, otherItem, otherPrincipal} {
			require.False(t, cancelled(untouched), "cancellation stays within this attempt and principal")
		}
		status, card = call("GET", "", "")
		require.Equal(t, 200, status)
		require.Equal(t, "dropped", card["state"])
		require.NotContains(t, card, "needs_you")
		after, err = q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.False(t, after.PausedAt.Valid)
		var settled struct {
			Waits []struct {
				SettledAt *string `json:"settled_at"`
			} `json:"waits"`
		}
		require.NoError(t, json.Unmarshal(after.Checks, &settled))
		require.Len(t, settled.Waits, 2)
		for _, wait := range settled.Waits {
			require.NotNil(t, wait.SettledAt)
		}
		var events int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&events))
		require.Equal(t, 1, events)
		var fact []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.dropped'`).Scan(&fact))
		var activity map[string]any
		require.NoError(t, json.Unmarshal(fact, &activity))
		require.Equal(t, "needs_you", activity["from"])
		require.Equal(t, "dropped", activity["to"])
		require.Equal(t, id, activity["item"])
		require.Equal(t, map[string]any{"kind": "person", "id": float64(owner.ID), "login": "owner"}, activity["actor"])
		status, _ = call("POST", `{"op":"drop"}`, "drop-after-generation")
		require.Equal(t, 202, status)
		replayed, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, after, replayed)
	})

}
