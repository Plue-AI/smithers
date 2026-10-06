package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// Real PostgreSQL and the install router/auth; seeded attempt facts qualify
// the public projection, not production machine source loading.
func TestTodoFeedbackComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pin-owner", LowerUsername: "pin-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	access := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "running", Checks: []byte(fmt.Sprintf(`{"todo":true,"run_launched":true,"run_attached":true,"flowSource":"%s"}`, source))})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,flow_digest=$3,request_run_id='pinned-run',workspace_id='11111111-1111-4111-8111-111111111111',revisions='[{"text":"Original","acceptance":[],"reason":"create"}]',title='Pinned source' WHERE id=$1`, item.ID, owner.ID, digest)
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("pin-cookie"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'pin-owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Server.PublicURL, cfg.Server.AllowedOrigins = "selfhost", origin, []string{origin}
	service := services.NewMythicalService(pool, nil)
	service.SetTodoFlow(func(ctx context.Context, repositoryID int64, sourceCommit string) (string, error) {
		return services.ActiveFlowDigest(ctx, q, repositoryID, "todo")
	})
	service.EnableTodoSteering()
	receiver := &reviewFixtureReceiver{messages: map[string]flowruntime.Steer{}}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return receiver, nil }), SteerAuthorizer: service, Projector: service})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "todo-feedback", Capacity: 1, Lease: time.Second, RetryDelay: 10 * time.Millisecond, MaxRetryDelay: 20 * time.Millisecond, PollInterval: 10 * time.Millisecond})
	}()
	t.Cleanup(func() { cancel(); require.NoError(t, <-done) })
	call := func(method, body, key string) map[string]any {
		req, err := http.NewRequest(method, origin+"/api/todos/1", strings.NewReader(body))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var value map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&value))
		require.Equal(t, 202, res.StatusCode, value)
		return value
	}
	// The host has accepted a launch but has not acknowledged its run ID.
	// Feedback arriving in that window is durable without a destination.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET request_run_id='',checks=jsonb_set(checks,'{run_attached}','false') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	call("POST", `{"steer":"Keep the same working copy"}`, "attaching")
	var before int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&before))
	require.Zero(t, before)
	current, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]), "generation": current.Generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
	require.NoError(t, err)
	update := flowdispatch.ProjectionUpdate{State: jobs.StateRunning, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "pinned-run", FlowID: "todo", ExecutionDigest: digest}}
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	for _, input := range []struct{ method, body, key string }{
		{"POST", `{"steer":"Use the retry helper"}`, "steer"},
		{"PATCH", `{"prompt":"Cap retries at five","acceptance":[]}`, "amend"},
	} {
		first := call(input.method, input.body, input.key)
		require.Equal(t, first, call(input.method, input.body, input.key))
	}
	require.Eventually(t, func() bool {
		receiver.mu.Lock()
		defer receiver.mu.Unlock()
		return len(receiver.messages) == 3
	}, 5*time.Second, 100*time.Millisecond)
	receiver.mu.Lock()
	for _, message := range receiver.messages {
		require.Equal(t, "pinned-run", message.RunID)
		require.Contains(t, []string{"Keep the same working copy", "Use the retry helper", "Cap retries at five"}, message.Body)
		require.Equal(t, map[string]string{"person": "pin-owner"}, message.Attribution)
	}
	receiver.mu.Unlock()
	read, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	var revisions []any
	require.NoError(t, json.Unmarshal(read.Revisions, &revisions))
	require.Len(t, revisions, 2)
	require.Equal(t, "pinned-run", read.RequestRunID)
	require.Equal(t, int32(1), read.Attempt)
	require.Equal(t, "11111111-1111-4111-8111-111111111111", read.WorkspaceID)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&count))
	require.Equal(t, 3, count)
	// The same production dispatcher holds a delegated amendment for its
	// person's private Confirm card, then commits the revision and intent once.
	token := "smithers_" + strings.Repeat("d", 40)
	tokenSum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "amend-agent", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	confirmationCall := func(method, path, body, key string, delegated bool, status int) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		if delegated {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		}
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var result map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&result))
		require.Equal(t, status, res.StatusCode, result)
		return result
	}
	amendment := `{"prompt":"Keep cancellation responsive","acceptance":["Cancel stops retries"]}`
	pending := confirmationCall("PATCH", "/api/todos/1", amendment, "confirm-amend", true, 202)
	require.Equal(t, "pending", pending["state"])
	id := pending["confirmation"].(string)
	require.Len(t, pending, 2, "agent sees only id and state")
	require.Equal(t, pending, confirmationCall("PATCH", "/api/todos/1", amendment, "confirm-amend", true, 202))
	beforePress, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, read.Revisions, beforePress.Revisions)
	confirmationCall("POST", "/api/confirmations/"+id+"/approve", `{}`, "amend-press", true, 403)
	// A failure at the approval CAS rolls back the admitted revision and intent.
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_confirm_amend() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='approved' THEN RAISE EXCEPTION 'approval unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_confirm_amend BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION reject_confirm_amend()`)
	require.NoError(t, err)
	confirmationCall("POST", "/api/confirmations/"+id+"/approve", `{}`, "amend-press", false, 503)
	rolledBack, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, beforePress.Revisions, rolledBack.Revisions)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&count))
	require.Equal(t, 3, count)
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_confirm_amend ON approvals; DROP FUNCTION reject_confirm_amend()`)
	require.NoError(t, err)
	approved := confirmationCall("POST", "/api/confirmations/"+id+"/approve", `{}`, "amend-press", false, 200)
	require.Equal(t, "approved", approved["state"])
	var privateEffect []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'effect' FROM approvals WHERE id=$1`, id).Scan(&privateEffect))
	require.JSONEq(t, fmt.Sprintf(`{"todo":1,"request":"confirmation:%s","revision":3}`, id), string(privateEffect))
	require.Equal(t, approved, confirmationCall("POST", "/api/confirmations/"+id+"/approve", `{}`, "amend-press", false, 200))
	afterPress, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	var amended []struct {
		Text       string   `json:"text"`
		Acceptance []string `json:"acceptance"`
	}
	require.NoError(t, json.Unmarshal(afterPress.Revisions, &amended))
	require.Len(t, amended, 3)
	require.Equal(t, "Keep cancellation responsive", amended[2].Text)
	require.Equal(t, []string{"Cancel stops retries"}, amended[2].Acceptance)
	require.Eventually(t, func() bool { receiver.mu.Lock(); defer receiver.mu.Unlock(); return len(receiver.messages) == 4 }, 5*time.Second, 100*time.Millisecond)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&count))
	require.Equal(t, 4, count)
	// A moved TODO expires the confirmation before any revision or intent.
	stale := confirmationCall("PATCH", "/api/todos/1", `{"prompt":"Stale text"}`, "stale-amend", true, 202)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, item.ID)
	require.NoError(t, err)
	confirmationCall("POST", "/api/confirmations/"+stale["confirmation"].(string)+"/approve", `{}`, "stale-press", false, 409)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, stale["confirmation"]).Scan(&state))
	require.Equal(t, "expired", state)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&count))
	require.Equal(t, 4, count)

}
