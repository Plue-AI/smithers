package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This exercises the real Home socket and durable dispatch projection. It
// deliberately does not claim to prove merged admission or machine execution.
func TestLearningBackgroundHomeComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	digest := sha256.Sum256([]byte("fixture-person"))
	sessionHash := hex.EncodeToString(digest[:])
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "learnowner", LowerUsername: "learnowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"learnowner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo, time.Now().UTC().Format(time.RFC3339Nano)))}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: sessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: sessionHash})
	service := services.NewMythicalService(pool, nil)
	_, err = service.FileTodo(ctx, repo, owner.ID, services.MythicalTodoInput{Title: "Retry", Prompt: "Use retry", Request: "fixture", Place: services.MythicalTodoPlace{Mode: "append"}})
	require.NoError(t, err)
	var itemID string
	require.NoError(t, pool.QueryRow(ctx, `UPDATE mythical_items SET state='landed',pr_state='merged' WHERE repository_id=$1 RETURNING id::text`, repo).Scan(&itemID))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "background-machine", BindingKind: "learning", BindingID: itemID}
	admit := func(id string, target flowruntime.Target, todo int) string {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"target": target, "flowId": "learning", "payload": map[string]int{"todo": todo}, "pin": flowruntime.Pin{Flow: "learning", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: strings.Repeat("b", 64)}})
		receipt, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: id, Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: id})
		require.NoError(t, err)
		return receipt.OperationID
	}
	operation := admit("learning-run:"+itemID, target, 1)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, fmt.Errorf("HTTP must not resolve a runtime")
	})})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	service.SetLearningMachines(homeLearningMachines{})
	provider := &services.HomeBackground{Pool: pool, Billing: services.NewUnlimitedBillingPolicy()}
	service.SetHomeBackground(provider)
	_, err = q.EnsureMythicalWiki(ctx, repo)
	require.NoError(t, err)
	// The merge-refresh worker records each refresh as a flow-plane run.
	wikiDefinition, err := q.EnsureWorkflowDefinitionReference(ctx, db.EnsureWorkflowDefinitionReferenceParams{RepositoryID: repo, Name: "Refresh wiki", Path: "flows/coding/wiki/flow.ts", Config: []byte(`{}`)})
	require.NoError(t, err)
	wikiRun, err := q.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{RepositoryID: repo, WorkflowDefinitionID: wikiDefinition.ID, Status: "queued", TriggerEvent: "main", TriggerRef: "main", DispatchInputs: []byte(`{}`), ExecutionPlane: "flow"})
	require.NoError(t, err)
	// A payload cannot borrow an item from a different tenant or TODO.
	wrong := target
	wrong.TenantID = "repository:999"
	wrongOperation := admit("wrong-repo", wrong, 1)
	admit("wrong-todo", target, 2)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	hubCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	require.NoError(t, bus.Start(hubCtx))
	topics := &liveTopics{queries: q, todos: service}
	handler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubCtx, nil), Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, routerExtras{Background: provider, Live: handler, Mythical: &routes.MythicalHandler{Service: service}})
	server.Config.Handler = router
	server.Start()
	for _, row := range []struct {
		stored, visible, wikiStored, wikiRun, wikiVisible string
	}{
		{"accepted", "queued", "idle", "queued", "queued"},
		{"dispatching", "queued", "off", "cancelled", ""},
		{"running", "running", "running", "running", "running"},
		{"waiting", "waiting", "idle", "success", ""},
		{"failed", "failed", "failed", "failure", "failed"},
		{"uncertain", "failed", "failed", "failure", "failed"},
		{"completed", "", "idle", "success", ""},
		{"cancelled", "", "off", "cancelled", ""},
	} {
		t.Run(row.stored, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE product_job_requests SET state=$2,terminal_receipt=CASE WHEN $2 IN ('failed','uncertain','completed','cancelled') THEN '{}'::jsonb ELSE NULL END WHERE id=$1`, operation, row.stored)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_wikis SET state=$2,run_id='wiki-run-1',error='Page review failed' WHERE repository_id=$1`, repo, row.wikiStored)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status=$2 WHERE id=$1`, wikiRun.ID, row.wikiRun)
			require.NoError(t, err)
			readCtx, done := context.WithTimeout(ctx, 10*time.Second)
			defer done()
			conn, _, err := websocket.Dial(readCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"smithers_session=fixture-person"}}})
			require.NoError(t, err)
			defer conn.CloseNow()
			require.NoError(t, conn.Write(readCtx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
			for {
				_, raw, err := conn.Read(readCtx)
				require.NoError(t, err)
				var frame liveFrame
				require.NoError(t, json.Unmarshal(raw, &frame))
				require.NotEqual(t, "err", frame.T, string(raw))
				if frame.T != "snap" {
					continue
				}
				var home struct {
					Runs   []map[string]any `json:"background_runs"`
					Items  []any            `json:"items"`
					Counts map[string]int   `json:"counts"`
				}
				require.NoError(t, json.Unmarshal(frame.Data, &home))
				require.Empty(t, home.Items)
				require.Equal(t, 0, home.Counts["merged"])
				expected := []map[string]any{}
				if row.visible != "" {
					actions := []any{}
					if row.visible == "failed" {
						if row.stored == "failed" {
							actions = append(actions, map[string]any{"tag": "background.retry", "label": "Retry"})
						}
						actions = append(actions, map[string]any{"tag": "background.dismiss", "label": "Dismiss"})
					}
					expected = append(expected, map[string]any{"id": operation, "title": "Learning · T1", "state": row.visible, "actions": actions})
				}
				if row.wikiVisible != "" {
					wiki := map[string]any{"id": fmt.Sprint(wikiRun.ID), "title": "Refresh wiki", "state": row.wikiVisible, "actions": []any{}}
					if row.wikiVisible == "failed" {
						wiki["detail"] = "Page review failed"
						wiki["actions"] = []any{map[string]any{"tag": "background.dismiss", "label": "Dismiss"}}
					}
					expected = append(expected, wiki)
				}
				require.Equal(t, expected, home.Runs)
				break
			}
		})
	}
	post := func(id, op, key string) *http.Response {
		t.Helper()
		request, err := http.NewRequest("POST", origin+"/api/runs/"+id, strings.NewReader(`{"op":"`+op+`"}`))
		require.NoError(t, err)
		request.Header.Set("Origin", origin)
		request.Header.Set("Cookie", "smithers_session=fixture-person; __csrf=learn-csrf")
		request.Header.Set("X-CSRF-Token", "learn-csrf")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		t.Cleanup(func() { response.Body.Close() })
		if response.StatusCode == 403 {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("action refused: %s", body)
		}
		return response
	}
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{"reason":"lint"}' WHERE id=$1`, operation)
	require.NoError(t, err)
	// Only merged TODOs qualify for the Learning Home door. A retained issue
	// lane record must not borrow a Learning launch to expose controls.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='issue' WHERE id=$1`, itemID)
	require.NoError(t, err)
	ineligible, err := service.LearningBackgroundRuns(ctx, repo)
	require.NoError(t, err)
	require.Empty(t, ineligible)
	require.Equal(t, 404, post(operation, "retry", "wrong-source").StatusCode)
	require.Equal(t, 404, post(operation, "dismiss", "").StatusCode)
	statusRequest, err := http.NewRequest("GET", origin+"/api/runs/"+operation+"/background-status", nil)
	require.NoError(t, err)
	statusRequest.Header.Set("Cookie", "smithers_session=fixture-person")
	statusResponse, err := server.Client().Do(statusRequest)
	require.NoError(t, err)
	require.Equal(t, 404, statusResponse.StatusCode)
	statusResponse.Body.Close()
	unchanged, err := store.Get(ctx, scope, operation)
	require.NoError(t, err)
	require.Equal(t, jobs.StateFailed, unchanged.State)
	require.JSONEq(t, `{"reason":"lint"}`, string(unchanged.TerminalReceipt))
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo' WHERE id=$1`, itemID)
	require.NoError(t, err)
	// A retained launch without its immutable Learning pin remains dismissible,
	// but the Home projection must not offer a Retry the command will refuse.
	original, err := store.Get(ctx, scope, operation)
	require.NoError(t, err)
	for _, pin := range []string{`null`, `{}`, `{"flow":"todo","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","executionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`} {
		_, err = pool.Exec(ctx, `UPDATE product_job_requests SET payload=jsonb_set(payload,'{pin}',$2::jsonb) WHERE id=$1`, operation, pin)
		require.NoError(t, err)
		runs, err := service.LearningBackgroundRuns(ctx, repo)
		require.NoError(t, err)
		require.Equal(t, []map[string]any{{"id": operation, "title": "Learning · T1", "state": "failed", "actions": []any{map[string]any{"tag": "background.dismiss", "label": "Dismiss"}}}}, runs)
		before, err := store.Get(ctx, scope, operation)
		require.NoError(t, err)
		require.Equal(t, 409, post(operation, "retry", "invalid-pin").StatusCode)
		after, err := store.Get(ctx, scope, operation)
		require.NoError(t, err)
		require.Equal(t, before, after)
	}
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET payload=$2 WHERE id=$1`, operation, original.Payload)
	require.NoError(t, err)
	for _, missing := range []string{"machines", "launcher", "billing"} {
		t.Run("missing_"+missing, func(t *testing.T) {
			switch missing {
			case "machines":
				service.SetLearningMachines(nil)
				defer service.SetLearningMachines(homeLearningMachines{})
			case "launcher":
				service.SetLauncher(nil)
				defer service.SetLauncher(dispatcher)
			case "billing":
				provider.Billing = nil
				defer func() { provider.Billing = services.NewUnlimitedBillingPolicy() }()
			}
			runs, err := service.LearningBackgroundRuns(ctx, repo)
			require.NoError(t, err)
			require.Equal(t, []map[string]any{{"id": operation, "title": "Learning · T1", "state": "failed", "actions": []any{map[string]any{"tag": "background.dismiss", "label": "Dismiss"}}}}, runs)
			before, err := store.Get(ctx, scope, operation)
			require.NoError(t, err)
			require.Equal(t, 503, post(operation, "retry", "missing-"+missing).StatusCode)
			after, err := store.Get(ctx, scope, operation)
			require.NoError(t, err)
			require.Equal(t, before, after)
			require.Equal(t, 200, post(operation, "dismiss", "").StatusCode)
			runs, err = service.LearningBackgroundRuns(ctx, repo)
			require.NoError(t, err)
			require.Empty(t, runs)
			// Restore only this fixture's failure before the next boundary case.
			_, err = pool.Exec(ctx, `UPDATE product_job_requests SET terminal_receipt='{"reason":"lint"}' WHERE id=$1`, operation)
			require.NoError(t, err)
		})
	}
	require.Equal(t, 400, post(operation, "retry", "").StatusCode)
	require.Equal(t, 404, post(wrongOperation, "dismiss", "").StatusCode)
	require.Equal(t, 404, post("00000000-0000-0000-0000-000000000001", "retry", "missing").StatusCode)
	// Separate clients can replay the same durable Retry concurrently after a
	// reconnect. All receive acceptance, with one external attempt and event.
	start := make(chan struct{})
	type retryResponse struct {
		response *http.Response
		err      error
	}
	responses := make(chan retryResponse, 8)
	for range 8 {
		go func() {
			<-start
			request, err := http.NewRequestWithContext(ctx, "POST", origin+"/api/runs/"+operation, strings.NewReader(`{"op":"retry"}`))
			if err != nil {
				responses <- retryResponse{err: err}
				return
			}
			request.Header.Set("Origin", origin)
			request.Header.Set("Cookie", "smithers_session=fixture-person; __csrf=learn-csrf")
			request.Header.Set("X-CSRF-Token", "learn-csrf")
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "retry-one")
			response, err := server.Client().Do(request)
			responses <- retryResponse{response, err}
		}()
	}
	close(start)
	for range 8 {
		result := <-responses
		require.NoError(t, result.err)
		var accepted map[string]any
		err := json.NewDecoder(result.response.Body).Decode(&accepted)
		result.response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 202, result.response.StatusCode)
		require.Equal(t, map[string]any{"state": "accepted", "run_id": operation}, accepted)
	}
	first := post(operation, "retry", "retry-one")
	require.Equal(t, 202, first.StatusCode)
	var receipt map[string]any
	require.NoError(t, json.NewDecoder(first.Body).Decode(&receipt))
	require.Equal(t, map[string]any{"state": "accepted", "run_id": operation}, receipt)
	require.Equal(t, 202, post(operation, "retry", "retry-one").StatusCode)
	require.Equal(t, 409, post(operation, "retry", "retry-two").StatusCode)
	// Retry changes dispatch state, never the admitted Learning identity or
	// immutable payload (including its source pin and merged TODO binding).
	retried, err := store.Get(ctx, scope, operation)
	require.NoError(t, err)
	require.Equal(t, original.ID, retried.ID)
	require.Equal(t, original.Scope, retried.Scope)
	require.Equal(t, original.RequestID, retried.RequestID)
	require.Equal(t, original.Operation, retried.Operation)
	require.Equal(t, original.PayloadFingerprint, retried.PayloadFingerprint)
	require.JSONEq(t, string(original.Payload), string(retried.Payload))
	require.JSONEq(t, string(original.AuthorizationContext), string(retried.AuthorizationContext))
	require.Equal(t, original.EffectKey, retried.EffectKey)
	require.Equal(t, original.EffectPolicy, retried.EffectPolicy)
	var attempt int
	require.NoError(t, pool.QueryRow(ctx, `SELECT external_attempt FROM product_job_dispatches WHERE operation_id=$1`, operation).Scan(&attempt))
	require.Equal(t, 2, attempt)
	request, err := http.NewRequest("GET", origin+"/api/runs/"+operation+"/background-status", nil)
	require.NoError(t, err)
	request.Header.Set("Cookie", "smithers_session=fixture-person")
	response, err := server.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
	response.Body.Close()
	require.Equal(t, "queued", receipt["state"])
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='uncertain',terminal_receipt='{"reason":"ambiguous"}' WHERE id=$1`, operation)
	require.NoError(t, err)
	require.Equal(t, 409, post(operation, "retry", "unsafe").StatusCode)
	require.Equal(t, 200, post(operation, "dismiss", "").StatusCode)
	require.Equal(t, 200, post(operation, "dismiss", "").StatusCode)
	runs, err := service.LearningBackgroundRuns(ctx, repo)
	require.NoError(t, err)
	require.Empty(t, runs)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE id=$1`, itemID).Scan(&state))
	require.Equal(t, "landed", state)
	var retries, dismissals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE event_type='operation.retry_authorized'),count(*) FILTER(WHERE event_type='operation.dismissed') FROM product_job_events WHERE operation_id=$1`, operation).Scan(&retries, &dismissals))
	require.Equal(t, 1, retries)
	require.Equal(t, 4, dismissals)
	// Failures before the launch use the same Home door and retain the first
	// qualified pin in the admission checkpoint.
	merge := strings.Repeat("a", 40)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET pr_merge_commit=$2 WHERE id=$1`, itemID, merge)
	require.NoError(t, err)
	raw, _ := json.Marshal(map[string]any{"item": itemID, "todo": 1, "repository": repo, "actor": owner.ID, "commit": merge})
	admission, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: services.LearningAdmissionOperation, RequestID: "learning:" + itemID, Payload: raw, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning:" + itemID})
	require.NoError(t, err)
	checkpoint := `{"pin":{"flow":"learning","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","executionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{}' WHERE id=$1`, admission.OperationID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, admission.OperationID, []byte(checkpoint))
	require.NoError(t, err)
	require.Equal(t, 202, post(admission.OperationID, "retry", "retry-admission").StatusCode)
	saved, err := store.Get(ctx, scope, admission.OperationID)
	require.NoError(t, err)
	require.JSONEq(t, checkpoint, string(saved.ExternalReceipt))
	require.Equal(t, 2, saved.ExternalAttempt)
	require.Equal(t, admission.OperationID, saved.ID)

}

// The allocator is never called by the served Retry door; execution belongs to
// the production dispatch worker and the separately qualified machine boundary.
type homeLearningMachines struct{}

func (homeLearningMachines) EnsureLearningMachine(context.Context, int64, int64, string, flowruntime.Pin) (flowruntime.Target, error) {
	panic("HTTP allocated a machine")
}
func (homeLearningMachines) RetireLearningMachine(context.Context, flowruntime.Target) error {
	panic("HTTP retired a machine")
}
