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

// Protocol fixture holds a delivered input while another worker tries to
// dispatch the next one. It does not substitute for guest/model-turn proof.
type orderedFeedbackReceiver struct {
	*reviewFixtureReceiver
	entered chan string
	holds   map[string]chan struct{}
	order   []string
}

func (r *orderedFeedbackReceiver) receive(ctx context.Context, text string) error {
	r.mu.Lock()
	r.order = append(r.order, text)
	r.mu.Unlock()
	if release, ok := r.holds[text]; ok {
		select {
		case r.entered <- text:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (r *orderedFeedbackReceiver) Steer(ctx context.Context, input flowruntime.Steer) (flowruntime.MutationResult, error) {
	if err := r.receive(ctx, input.Body); err != nil {
		return flowruntime.MutationResult{}, err
	}
	return r.reviewFixtureReceiver.Steer(ctx, input)
}
func (r *orderedFeedbackReceiver) Signal(ctx context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	var text string
	if err := json.Unmarshal(input.Payload, &text); err != nil {
		return flowruntime.MutationResult{}, err
	}
	if err := r.receive(ctx, text); err != nil {
		return flowruntime.MutationResult{}, err
	}
	return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}

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
	receiver := &orderedFeedbackReceiver{reviewFixtureReceiver: &reviewFixtureReceiver{messages: map[string]flowruntime.Steer{}},
		entered: make(chan string, 2), holds: map[string]chan struct{}{"Ordered steer": make(chan struct{}), "Ordered answer": make(chan struct{})}}
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
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "todo-feedback", Capacity: 2, Lease: time.Second, RetryDelay: 10 * time.Millisecond, MaxRetryDelay: 20 * time.Millisecond, PollInterval: 10 * time.Millisecond})
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

	// Both public input doors serialize by committed admission, even with two
	// workers and an earlier external call held deliberately unresolved.
	for index, pair := range []struct {
		first, second string
		answerFirst   bool
	}{
		{"Ordered steer", "Quick answer", false},
		{"Ordered answer", "Quick steer", true},
	} {
		waitID := fmt.Sprintf("ordered-question-%d", index)
		scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
		waits, err := json.Marshal([]services.TodoWait{{ID: waitID, Kind: "question", Prompt: "Which retry limit?", Since: time.Now().UTC(),
			Signal: &services.TodoWaitSignal{Scope: scope, Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID,
				WorkspaceID: read.WorkspaceID, BindingKind: "mythical-item", BindingID: fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16])},
				Flow: "todo", Run: "pinned-run", Name: "answer:" + waitID}}})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}',$2::jsonb) WHERE id=$1`, item.ID, waits)
		require.NoError(t, err)
		answer := func(text string) {
			body, err := json.Marshal(map[string]string{"wait": waitID, "answer": text})
			require.NoError(t, err)
			confirmationCall("POST", "/api/todos/1/answer", string(body), waitID, false, 202)
		}
		steer := func(text string) {
			body, err := json.Marshal(map[string]string{"steer": text})
			require.NoError(t, err)
			call("POST", string(body), fmt.Sprintf("ordered-steer-%d", index))
		}
		if pair.answerFirst {
			answer(pair.first)
		} else {
			steer(pair.first)
		}
		select {
		case got := <-receiver.entered:
			require.Equal(t, pair.first, got)
		case <-time.After(5 * time.Second):
			t.Fatal("first input never entered the runtime")
		}
		if !pair.answerFirst {
			var open int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items,jsonb_array_elements(checks->'waits') wait WHERE id=$1 AND NOT wait ? 'settled_at'`, item.ID).Scan(&open))
			require.Equal(t, 1, open, "a steer must leave the question open")
		}
		if pair.answerFirst {
			steer(pair.second)
		} else {
			answer(pair.second)
		}
		require.Eventually(t, func() bool {
			var attempted bool
			err := pool.QueryRow(ctx, `SELECT EXISTS (
			 SELECT 1 FROM product_job_requests request JOIN product_job_dispatches dispatch ON dispatch.operation_id=request.id
			 WHERE dispatch.attempt>0 AND (request.payload->>'body'=$1 OR request.payload->>'payload'=$1)
			)`, pair.second).Scan(&attempted)
			return err == nil && attempted
		}, 5*time.Second, 10*time.Millisecond, "second worker never attempted the later input")
		require.Never(t, func() bool {
			receiver.mu.Lock()
			defer receiver.mu.Unlock()
			for _, text := range receiver.order {
				if text == pair.second {
					return true
				}
			}
			return false
		}, 200*time.Millisecond, 10*time.Millisecond, "later input overtook an unresolved predecessor")
		close(receiver.holds[pair.first])
		require.Eventually(t, func() bool {
			receiver.mu.Lock()
			defer receiver.mu.Unlock()
			for _, text := range receiver.order {
				if text == pair.second {
					return true
				}
			}
			return false
		}, 5*time.Second, 10*time.Millisecond)
		receiver.mu.Lock()
		require.Equal(t, []string{pair.first, pair.second}, receiver.order[len(receiver.order)-2:])
		receiver.mu.Unlock()
	}

}
