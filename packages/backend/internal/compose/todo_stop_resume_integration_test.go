package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The receiver is a test-only guest protocol contract. Runtime parks themselves
// are covered by flows/test/todo-pause.test.ts on the production SQLite engine.
type pauseReceiver struct {
	*reviewFixtureReceiver
	signals chan flowruntime.Signal
}

func (r *pauseReceiver) Signal(ctx context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	select {
	case r.signals <- input:
	case <-ctx.Done():
		return flowruntime.MutationResult{}, ctx.Err()
	}
	return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID, Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}
func TestTodoStopResumeComposedInstall(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr6todocontrol")
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
	source, digest := strings.Repeat("a", 40), "e274ce85c2e7f9fdef2bb4de75700e9847920893d24e6f69d692a573ff11ed3d"
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET flow_digest=$2,workspace_id='11111111-1111-4111-8111-111111111111',checks=jsonb_set(jsonb_set(checks,'{flowSource}',to_jsonb($3::text)),'{run_attached}','true') WHERE id=$1`, item.ID, digest, source)
	require.NoError(t, err)
	service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return digest, nil })
	receiver := &pauseReceiver{reviewFixtureReceiver: &reviewFixtureReceiver{}, signals: make(chan flowruntime.Signal, 10)}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: service, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return receiver, nil })})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(item.ID.Bytes).String()}
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]), "generation": item.Generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
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

	// Every refusal precedes runtime intent and leaves the item unchanged.
	original, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	for _, test := range []struct {
		name, sql string
		status    int
	}{
		{"question", `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"q","kind":"question","prompt":"Which?","since":"2026-10-06T00:00:00Z"}]') WHERE id=$1`, 409},
		{"approval", `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"a","kind":"approval","prompt":"Allow?","since":"2026-10-06T00:00:00Z"}]') WHERE id=$1`, 409},
		{"starting", `UPDATE mythical_items SET checks=jsonb_set(checks,'{run_attached}','false') WHERE id=$1`, 409},
		{"failed", `UPDATE mythical_items SET state='blocked' WHERE id=$1`, 409},
		{"unknown protocol", `UPDATE mythical_items SET flow_digest=repeat('f',64) WHERE id=$1`, 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, test.sql, item.ID)
			require.NoError(t, err)
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			status, body := call("POST", `{"op":"stop"}`, test.name)
			require.Equal(t, test.status, status, body)
			after, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,flow_digest=$4 WHERE id=$1`, item.ID, original.State, original.Checks, original.FlowDigest)
			require.NoError(t, err)
		})
	}
	service.SetLauncher(nil)
	status, body := call("POST", `{"op":"stop"}`, "uncomposed")
	require.Equal(t, 503, status, body)
	service.SetLauncher(dispatcher)
	token := "smithers_" + strings.Repeat("d", 40)
	tokenBytes := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenBytes[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "pause-agent", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	for _, op := range []string{"stop", "resume"} {
		req, err := http.NewRequest("POST", origin+"/api/todos/1", strings.NewReader(fmt.Sprintf(`{"op":%q}`, op)))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "agent-"+op)
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		response.Body.Close()
		require.Equal(t, 403, response.StatusCode)
	}
	var intents int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&intents))
	require.Zero(t, intents)
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_pause_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pause fact unavailable'; END $$;
 CREATE TRIGGER refuse_pause_fact BEFORE INSERT ON product_job_events FOR EACH ROW WHEN (NEW.event_type='todo.stop.requested') EXECUTE FUNCTION refuse_pause_fact()`)
	require.NoError(t, err)
	status, body = call("POST", `{"op":"stop"}`, "rollback")
	require.Equal(t, 503, status, body)
	afterFailure, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, original, afterFailure)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_pause_fact ON product_job_events; DROP FUNCTION refuse_pause_fact()`)
	require.NoError(t, err)
	status, card := call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "working", card["state"])
	status, receipt := call("POST", `{"op":"stop"}`, "stop-1")
	require.Equal(t, 202, status, receipt)
	status, card = call("GET", "", "")
	require.Equal(t, 200, status, card)
	require.Equal(t, "working", card["state"])
	require.Equal(t, "requested", card["stop"])
	status, replay := call("POST", `{"op":"stop"}`, "stop-1")
	require.Equal(t, 202, status, replay)
	require.Equal(t, receipt, replay)
	status, _ = call("POST", `{"op":"stop"}`, "stop-2")
	require.Equal(t, 409, status)
	status, _ = call("POST", `{"op":"resume"}`, "early-resume")
	require.Equal(t, 409, status)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "fr6-controls", Capacity: 1, Lease: time.Second, PollInterval: 10 * time.Millisecond})
	}()
	t.Cleanup(func() { cancel(); require.NoError(t, <-done) })
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "pause", signal.Name)
		require.JSONEq(t, "1", string(signal.Payload))
		require.Equal(t, "run-1", signal.RunID)
	case <-time.After(5 * time.Second):
		t.Fatal("Stop not dispatched")
	}
	project := func(name string) {
		var waits []flowruntime.PendingWait
		if name != "" {
			waits = []flowruntime.PendingWait{{RunID: "child", Token: "durable-token", Name: name, Reason: "approval", Request: json.RawMessage(`{"kind":"pause"}`)}}
		}
		require.NoError(t, service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, Target: target, FlowID: "todo", RunID: "run-1", ExecutionDigest: digest, Run: &flowruntime.Run{RunID: "run-1", FlowID: "todo", Status: "running", PendingWaits: waits}}}))
	}
	project("resume#99")
	_, card = call("GET", "", "")
	require.Equal(t, "working", card["state"])
	project("resume#1")
	_, card = call("GET", "", "")
	require.Equal(t, "paused", card["state"])
	require.Equal(t, "person", card["pause"].(map[string]any)["reason"])
	// A branch wait masks the pause, and Resume leaves that wait untouched.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[{"id":"foreign","kind":"foreign_push","prompt":"Push","since":"2026-10-06T00:00:00Z"}]') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	_, card = call("GET", "", "")
	require.Equal(t, "needs_you", card["state"])
	require.Contains(t, card, "pause")
	status, receipt = call("POST", `{"op":"resume"}`, "resume-1")
	require.Equal(t, 202, status, receipt)
	_, card = call("GET", "", "")
	require.Equal(t, "needs_you", card["state"])
	require.Contains(t, card, "pause", "admission is not completion")
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "resume#1", signal.Name)
		require.Equal(t, "run-1", signal.RunID)
	case <-time.After(5 * time.Second):
		t.Fatal("Resume not dispatched")
	}
	require.Eventually(t, func() bool {
		saved, e := q.GetMythicalItem(ctx, item.ID)
		return e == nil && strings.Contains(string(saved.Checks), `"delivered": true`)
	}, 5*time.Second, 10*time.Millisecond)
	project("resume#1")
	_, card = call("GET", "", "")
	require.Contains(t, card, "pause", "old parked checkpoints cannot report resumed")
	project("")
	_, card = call("GET", "", "")
	require.Equal(t, "needs_you", card["state"])
	require.NotContains(t, card, "pause")
	saved, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, "run-1", saved.RequestRunID)
	require.EqualValues(t, 1, saved.Attempt)
	require.Equal(t, digest, saved.FlowDigest.String)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}','[]') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	// A later Stop uses another wait, on the same run and pin.
	status, _ = call("POST", `{"op":"stop"}`, "stop-cycle-2")
	require.Equal(t, 202, status)
	select {
	case signal := <-receiver.signals:
		require.Equal(t, "pause", signal.Name)
		require.JSONEq(t, "2", string(signal.Payload))
	case <-time.After(5 * time.Second):
		t.Fatal("second Stop not dispatched")
	}
	project("resume#1")
	_, card = call("GET", "", "")
	require.Equal(t, "working", card["state"])
	project("resume#2")
	_, card = call("GET", "", "")
	require.Equal(t, "paused", card["state"])
}
