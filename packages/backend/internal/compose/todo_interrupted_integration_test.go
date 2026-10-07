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
	"time"

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
	require.Greater(t, afterEvents, beforeEvents)
	var attachmentFacts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.run_updated'`).Scan(&attachmentFacts))
	require.Equal(t, 1, attachmentFacts)
	attachedEvents := afterEvents

	// Replayed attachment produces no second lifecycle fact.
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, attachedEvents, afterEvents)
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateUncertain, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "run-1"}}))
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "failed", card["state"])
	require.Equal(t, map[string]any{"step": "runtime", "class": "interrupted", "message": "Interrupted", "retryable": true}, card["failure"])
	// A delayed nonterminal checkpoint of the failed run cannot open a new
	// question or change the failed attempt while a person decides Retry.
	failed, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	var failureEvents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&failureEvents))
	require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
		Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)},
		Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/request", Projection: projection, RunID: "run-1", Run: &flowruntime.Run{
			RunID: "run-1", PendingWaits: []flowruntime.PendingWait{{RunID: "request-step", Token: "late-question", Name: "choice",
				Request: []byte(`{"kind":"ask","prompt":"Too late?"}`)}},
		}}}))
	unchanged, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, failed, unchanged)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&afterEvents))
	require.Equal(t, failureEvents, afterEvents)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status)
	require.Equal(t, "failed", card["state"])
	require.NotContains(t, card, "needs_you")
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
	t.Run("Retry ignores late live checkpoints until admission", func(t *testing.T) {
		// Retry is committed, but the machine has not admitted attempt 2.
		// The old attempt number/run binding remain historical facts on the
		// queued row. Its delayed question must not reopen this ended run.
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
			Scope: jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)},
			Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/request", Projection: projection, RunID: "run-1", Run: &flowruntime.Run{
				RunID: "run-1", PendingWaits: []flowruntime.PendingWait{{RunID: "old-request-step", Token: "late-after-retry", Name: "choice",
					Request: []byte(`{"kind":"ask","prompt":"Too late after Retry?"}`)}},
			}}}))
		unchanged, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, queuedItem, unchanged)
		var events int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&events))
		require.Equal(t, retryEvents, events)
		status, card := call("GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, "queued", card["state"])
		require.Empty(t, card["waits"])
	})
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
	// A retained rebase conflict cannot use Retry to spend another attempt.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='integrating',reason='rebase_conflict_pending',
		candidate_head=$2,candidate_base=$3,integration=$4,checks=$5 WHERE id=$1`, item.ID,
		strings.Repeat("a", 40), strings.Repeat("b", 40),
		`{"conflict":{"paths":["src/retry.ts"],"onto":"cccccccccccccccccccccccccccccccccccccccc","head":"dddddddddddddddddddddddddddddddddddddddd"}}`,
		`{"todo":true,"runLaunched":true,"runAttached":true,"rebase":{"onto":"cccccccccccccccccccccccccccccccccccccccc","name":"main","since":"2026-10-06T00:00:00Z"}}`)
	require.NoError(t, err)
	retained, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "working", card["state"])
	require.Equal(t, map[string]any{"onto": "main"}, card["rebase_pending"])
	require.NotContains(t, card, "failure")
	for _, key := range []string{"conflict-1", "conflict-2", "conflict-3"} {
		status, receipt = call("POST", `{"op":"retry"}`, key)
		require.Equal(t, 409, status, receipt)
		saved, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, retained, saved)
	}

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
	t.Run("Attempt evidence keeps each run identity after Retry", func(t *testing.T) {
		source, digest := strings.Repeat("b", 40), strings.Repeat("c", 64)
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=1,request_run_id='history-run-1',request_outcome='',
		 pr_state='',pr_number=NULL,pending_op=NULL,paused_at=NULL,candidate_head='',candidate_base='',flow_digest=$2,
		 checks=jsonb_build_object('todo',true,'run_launched',true,'run_attached',false,'flowSource',$3::text) WHERE id=$1`, item.ID, digest, source)
		require.NoError(t, err)
		stored, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		binding, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]),
			"generation": stored.Generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
		require.NoError(t, err)
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateUncertain,
			Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: binding, RunID: "history-run-1", FlowID: "todo", ExecutionDigest: digest}}))
		status, card := call("GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, "failed", card["state"])
		first := card["evidence"].([]any)[0].(map[string]any)
		require.Equal(t, "history-run-1", first["run_id"])
		status, receipt := call("POST", `{"op":"retry"}`, "history-retry")
		require.Equal(t, 202, status, receipt)
		var frozen []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'attempts'->0 FROM mythical_items WHERE id=$1`, item.ID).Scan(&frozen))
		queued, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		var eventsBefore, eventsAfter int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&eventsBefore))
		// The pinned composition obeys the same ended-attempt fence as the
		// legacy request phase while Retry awaits its machine grant.
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
			Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: binding, RunID: "history-run-1", FlowID: "todo", ExecutionDigest: digest,
				Run: &flowruntime.Run{RunID: "history-run-1", PendingWaits: []flowruntime.PendingWait{{RunID: "old-pinned-step", Token: "late-pinned-question", Name: "choice",
					Request: []byte(`{"kind":"ask","prompt":"Too late for the pinned attempt?"}`)}}}}}))
		unchanged, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, queued, unchanged)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&eventsAfter))
		require.Equal(t, eventsBefore, eventsAfter)
		// Admission advances the attempt. Runtime ingestion and the served
		// card must preserve the prior snapshot rather than reattribute it.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=2,request_run_id='history-run-2',request_outcome='',
		 checks=jsonb_set(jsonb_set(checks,'{run_attached}','false'),'{run_launched}','true') WHERE id=$1`, item.ID)
		require.NoError(t, err)
		var nextBinding map[string]any
		require.NoError(t, json.Unmarshal(binding, &nextBinding))
		nextBinding["attempt"] = 2
		binding, err = json.Marshal(nextBinding)
		require.NoError(t, err)
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
			Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: binding, RunID: "history-run-2", FlowID: "todo", ExecutionDigest: digest}}))
		var retained []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'attempts'->0 FROM mythical_items WHERE id=$1`, item.ID).Scan(&retained))
		require.Equal(t, string(frozen), string(retained))
		status, card = call("GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, "working", card["state"])
		evidence := card["evidence"].([]any)
		require.Len(t, evidence, 2)
		require.Equal(t, first, evidence[0])
		require.Equal(t, "history-run-2", evidence[1].(map[string]any)["run_id"])
	})
	t.Run("Attachment retries a concurrent wait version without losing it", func(t *testing.T) {
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=2,request_run_id='race-run',request_outcome='',
		 flow_digest=NULL,paused_at=NULL,pending_op=NULL,candidate_head='',candidate_base='',checks='{"todo":true,"run_launched":true,"run_attached":false}' WHERE id=$1`, item.ID)
		require.NoError(t, err)
		before, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		var countBefore int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&countBefore))
		racing, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		tx, err := pool.Begin(racing)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		_, err = tx.Exec(racing, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repo.ID)
		require.NoError(t, err)
		id := fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16])
		binding, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": id, "generation": before.Generation, "attempt": 2, "phase": "request"})
		require.NoError(t, err)
		done := make(chan error, 1)
		go func() {
			done <- service.ProjectFlowRuntime(racing, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting,
				Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: binding, RunID: "race-run"}})
		}()
		// Observe the production projector waiting for the stack lock after
		// it read the old item version. No timing sleep supplies the barrier.
		require.Eventually(t, func() bool {
			var waiting bool
			err := pool.QueryRow(racing, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
			 AND wait_event_type='Lock' AND query LIKE 'SELECT 1 FROM mythical_stacks WHERE repository_id =%FOR UPDATE')`).Scan(&waiting)
			return err == nil && waiting
		}, 5*time.Second, 10*time.Millisecond)
		concurrent := before
		concurrent.Checks = []byte(`{"todo":true,"run_launched":true,"run_attached":false,"waits":[{"id":"raced-branch","kind":"foreign_push","prompt":"Alice pushed"}]}`)
		_, err = db.New(tx).SaveMythicalItem(racing, concurrent)
		require.NoError(t, err)
		_, err = jobs.RecordFactInTx(racing, tx, jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: "todo:" + id},
			"44444444-4444-4444-8444-444444444444", "todo.test_wait", "needs_you", json.RawMessage(`{"wait":"raced-branch"}`))
		require.NoError(t, err)
		require.NoError(t, tx.Commit(racing))
		require.NoError(t, <-done)
		after, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Equal(t, before.Version+2, after.Version)
		var checks struct {
			Attached bool `json:"run_attached"`
			Waits    []struct {
				ID        string  `json:"id"`
				SettledAt *string `json:"settled_at"`
			} `json:"waits"`
		}
		require.NoError(t, json.Unmarshal(after.Checks, &checks))
		require.True(t, checks.Attached)
		require.Len(t, checks.Waits, 1)
		require.Equal(t, "raced-branch", checks.Waits[0].ID)
		require.Nil(t, checks.Waits[0].SettledAt)
		var countAfter int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&countAfter))
		require.Equal(t, countBefore+2, countAfter, "the committed wait and accepted attachment each have one fact")
		var raw []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.run_updated' AND data->>'run'='race-run'`).Scan(&raw))
		var fact map[string]any
		require.NoError(t, json.Unmarshal(raw, &fact))
		require.Equal(t, "needs_you", fact["from"])
		require.Equal(t, "needs_you", fact["to"])
		require.Equal(t, map[string]any{"kind": "run", "id": "race-run"}, fact["actor"])
		status, card := call("GET", "", "")
		require.Equal(t, 200, status, card)
		require.Equal(t, "needs_you", card["state"])
		waits := card["waits"].([]any)
		require.Len(t, waits, 1)
		require.Equal(t, "foreign_push", waits[0].(map[string]any)["kind"])
	})
	t.Run("Literal Drop sources and terminal refusals", func(t *testing.T) {
		// These outcomes are literal fixtures, independent of the projection
		// and transition implementation. Exercise the served engine entry.
		cases := []struct {
			stored, product string
			accepted        bool
		}{
			{"queued", "queued", true}, {"skipped", "queued", true},
			{"running", "working", true}, {"delivering", "working", true},
			{"integrating", "working", true}, {"verifying", "working", true},
			{"proposing", "working", true}, {"waiting", "working", true},
			{"retrying", "working", true}, {"proposed", "in_review", true},
			{"blocked", "failed", true}, {"landed", "merged", false},
			{"cancelled", "dropped", false}, {"rejected", "dropped", false}, {"declined", "dropped", false},
		}
		accepted, refused := 0, 0
		for _, tc := range cases {
			for _, facts := range []struct {
				name          string
				paused, waits bool
			}{{"plain", false, false}, {"pause", true, false}, {"waits", false, true}, {"pause-and-waits", true, true}} {
				t.Run(tc.stored+"/"+facts.name, func(t *testing.T) {
					checks := `{"todo":true}`
					if facts.waits {
						checks = `{"todo":true,"waits":[{"id":"question","kind":"question","prompt":"Which?"},{"id":"branch","kind":"foreign_push","prompt":"Push"}]}`
					}
					_, err := pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,paused_at=CASE WHEN $4 THEN NOW() ELSE NULL END,
					 pending_op=NULL,stack_position=1,pr_number=NULL,pr_state='',flow_digest=NULL,request_run_id='',request_outcome='' WHERE id=$1`, item.ID, tc.stored, checks, facts.paused)
					require.NoError(t, err)
					before, err := q.GetMythicalItem(ctx, item.ID)
					require.NoError(t, err)
					var countBefore, countAfter int
					require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&countBefore))
					expected := tc.product
					if tc.accepted && facts.paused {
						expected = "paused"
					}
					if tc.accepted && facts.waits {
						expected = "needs_you"
					}
					status, card := call("GET", "", "")
					require.Equal(t, 200, status, card)
					require.Equal(t, expected, card["state"])
					key := "literal-drop-" + tc.stored + "-" + facts.name
					status, receipt := call("POST", `{"op":"drop"}`, key)
					after, err := q.GetMythicalItem(ctx, item.ID)
					require.NoError(t, err)
					require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&countAfter))
					if !tc.accepted {
						require.Equal(t, 409, status, receipt)
						require.Equal(t, "conflict", receipt["class"])
						require.Equal(t, "todo_transition_refused", receipt["code"])
						require.Equal(t, expected, receipt["from"])
						require.Equal(t, "drop", receipt["trigger"])
						require.Equal(t, before, after)
						require.Equal(t, countBefore, countAfter)
						refused++
						return
					}
					require.Equal(t, 202, status, receipt)
					require.Equal(t, countBefore+1, countAfter)
					require.Equal(t, "cancelled", after.State)
					require.False(t, after.PausedAt.Valid)
					var savedChecks struct {
						Waits []struct {
							SettledAt *string `json:"settled_at"`
						} `json:"waits"`
					}
					require.NoError(t, json.Unmarshal(after.Checks, &savedChecks))
					if facts.waits {
						require.Len(t, savedChecks.Waits, 2, "Drop settles and retains both independent waits")
					} else {
						require.Empty(t, savedChecks.Waits)
					}
					for _, wait := range savedChecks.Waits {
						require.NotNil(t, wait.SettledAt)
					}
					var raw []byte
					require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.dropped' ORDER BY recorded_at DESC,sequence DESC LIMIT 1`).Scan(&raw))
					var fact map[string]any
					require.NoError(t, json.Unmarshal(raw, &fact))
					require.Equal(t, expected, fact["from"])
					require.Equal(t, "dropped", fact["to"])
					require.Equal(t, map[string]any{"kind": "person", "id": float64(owner.ID), "login": "owner"}, fact["actor"])
					status, card = call("GET", "", "")
					require.Equal(t, 200, status, card)
					require.Equal(t, "dropped", card["state"])
					require.NotContains(t, card, "needs_you")
					status, replay := call("POST", `{"op":"drop"}`, key)
					require.Equal(t, 202, status, replay)
					require.Equal(t, receipt, replay)
					require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&countAfter))
					require.Equal(t, countBefore+1, countAfter)
					accepted++
				})
			}
		}
		require.Equal(t, 44, accepted)
		require.Equal(t, 16, refused)
		t.Logf("literal served Drop cases: %d accepted, %d refused", accepted, refused)
	})
}
