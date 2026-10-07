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
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Production install authorization, TODO service and real PostgreSQL. No
// worker runs: a queued edit must remain durable before a machine is admitted.
func TestTodoCardCommitAndAmendTransactions(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "card-owner", LowerUsername: "card-owner", DisplayName: "Ben"})
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"card-owner","repository_name":"app","repository_id":%d}`, repo))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"card-owner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo, time.Now().UTC().Format(time.RFC3339)))}))
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	token := "todo-card-cookie"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	service.EnableTodoSteering()
	service.SetTodoFlow(func(ctx context.Context, repository int64, source string) (string, error) {
		return services.ActiveFlowDigest(ctx, q, repository, "todo")
	})
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return &reviewFixtureReceiver{messages: map[string]flowruntime.Steer{}}, nil
	}), SteerAuthorizer: service, Projector: service})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	bus := revocation.NewBus(pool, q)
	busContext, stopBus := context.WithCancel(ctx)
	defer stopBus()
	require.NoError(t, bus.Start(busContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	topics := &liveTopics{queries: q, todos: service, jobs: store}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: liveHandler, mythical: &routes.MythicalHandler{Service: service}})
	server.Start()
	t.Cleanup(server.Close)
	call := func(method, path, body, key string, status int) map[string]any {
		t.Helper()
		request, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		request.Header.Set("X-CSRF-Token", "csrf")
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		var result map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
		require.Equal(t, status, response.StatusCode, result)
		return result
	}
	alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "card-alice", LowerUsername: "card-alice", DisplayName: "Alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, alice.ID)
	require.NoError(t, err)
	aliceToken := "card-alice-cookie"
	aliceHash := sha256.Sum256([]byte(aliceToken))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(aliceHash[:]), UserID: alice.ID, Username: alice.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	readFrame := func(socket *websocket.Conn) live.Frame {
		t.Helper()
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := socket.Read(deadline)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	var sockets []*websocket.Conn
	for _, cookie := range []string{token, aliceToken} {
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + cookie}, "Origin": {origin}}})
		require.NoError(t, err)
		t.Cleanup(func() { socket.CloseNow() })
		sockets = append(sockets, socket)
		require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
		initial := readFrame(socket)
		require.Equal(t, "snap", initial.T)
		require.NotContains(t, string(initial.Data), "PROMPT-A")
	}
	// Drafts are browser-private in mvp §14.5.1. A draft makes no shared
	// server record; Commit is the first public transaction both members see.
	const commit = `{"title":"Retry webhooks","prompt":"PROMPT-A","acceptance":["A"],"place":{"mode":"append"}}`
	first := call("POST", "/api/todos", commit, "commit-once", 202)
	require.Equal(t, first, call("POST", "/api/todos", commit, "commit-once", 202))
	for _, socket := range sockets {
		delta := readFrame(socket)
		require.Equal(t, "delta", delta.T)
		require.Contains(t, string(delta.Data), "Retry webhooks")
	}
	n := int64(first["n"].(float64))
	path := fmt.Sprintf("/api/todos/%d", n)
	require.Equal(t, "idempotency_mismatch", call("POST", "/api/todos", strings.Replace(commit, "PROMPT-A", "changed", 1), "commit-once", 409)["code"])
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND source='todo'`, repo).Scan(&count))
	require.Equal(t, 1, count)
	const amend = `{"prompt":"PROMPT-B","acceptance":["B"]}`
	revision := call("PATCH", path, amend, "amend-once", 202)
	require.EqualValues(t, 2, revision["rev"])
	require.Equal(t, revision, call("PATCH", path, amend, "amend-once", 202))
	card := call("GET", path, "", "", 200)
	revisions := card["prompt_revisions"].([]any)
	require.Len(t, revisions, 2)
	require.Equal(t, "PROMPT-A", revisions[0].(map[string]any)["text"])
	require.Equal(t, "PROMPT-B", revisions[1].(map[string]any)["text"])
	require.Equal(t, []any{"B"}, revisions[1].(map[string]any)["acceptance"])
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND source='todo'`, repo).Scan(&count))
	require.Equal(t, 1, count)
	// A native guest result is injected at the runtime boundary on this Linux
	// host. The completed receipt, verifier and HTTP card are production paths.
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	workspace := "11111111-1111-4111-8111-111111111111"
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=1,request_run_id='card-run',workspace_id=$2,lane_started_at=NOW()-interval '1 second',flow_digest=$3,checks=checks||jsonb_build_object('flowSource',$4::text,'run_launched',true,'run_attached',true) WHERE repository_id=$1 AND number=$5`, repo, workspace, digest, source, n)
	require.NoError(t, err)
	var itemID string
	var generation int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text,generation FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo, n).Scan(&itemID, &generation))
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": itemID, "generation": generation, "attempt": 1, "phase": "todo", "flowDigest": digest, "flowSource": source})
	update := flowdispatch.ProjectionUpdate{Scope: scope, State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "todo", ExecutionDigest: digest, RunID: "card-run", Target: flowruntime.Target{WorkspaceID: workspace}, Projection: projection, Run: &flowruntime.Run{RunID: "card-run", FlowID: "todo", Status: "failed", FailureFault: "factory", FailureTag: "coding/Error/fast_gate"}}}
	waits, _ := json.Marshal([]services.TodoWait{{ID: "card-question", Kind: "question", Prompt: "Backoff or fixed?", Since: time.Now().UTC(), Signal: &services.TodoWaitSignal{Scope: scope, Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: workspace, BindingKind: "mythical-item", BindingID: itemID}, Flow: "todo", Run: "card-run", Name: "answer:card-question"}}})
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}',$2::jsonb) WHERE id=$1`, itemID, waits)
	require.NoError(t, err)
	call("POST", path+"/answer", `{"wait":"card-question","answer":"Backoff"}`, "first-answer", 202)
	conflict := call("POST", path+"/answer", `{"wait":"card-question","answer":"Fixed"}`, "late-answer", 409)
	require.Equal(t, "card-owner", conflict["answered_by"])
	certified, err := service.CertifyFlowFailure(ctx, update)
	require.NoError(t, err)
	require.Nil(t, certified)
	result := workspaceapi.CommandResult{ExitCode: 127, Stderr: "sh: 1: figlet: not found\n"}
	var refusal *microsandbox.RecipeError
	require.ErrorAs(t, microsandbox.MissingToolError(workspaceapi.Command{Args: []string{"sh", "-c", "figlet"}}, result), &refusal)
	receipt, _ := json.Marshal(map[string]any{"exit_code": 127, "stderr": []byte(result.Stderr), "error": refusal})
	payload, _ := json.Marshal(map[string]any{"WorkspaceID": workspace, "RepositoryID": repo, "UserID": owner.ID, "EncryptedInput": "test-only-guest-boundary"})
	admitted, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: "workspace.command", RequestID: "missing-figlet", Payload: payload, EffectPolicy: jobs.EffectUnsafe})
	require.NoError(t, err)
	claim, err := store.ClaimForOperations(ctx, "card-command", time.Minute, []string{"workspace.command"})
	require.NoError(t, err)
	require.NoError(t, store.Complete(ctx, claim, receipt))
	certified, err = service.CertifyFlowFailure(ctx, update)
	require.NoError(t, err)
	require.Equal(t, &flowdispatch.CertifiedMissingTool{Name: "figlet", File: ".smithers/machine.json", OperationID: admitted.OperationID}, certified)
	for _, change := range []string{"old attempt", "wrong run", "wrong workspace", "infra"} {
		altered := update
		altered.Checkpoint = update.Checkpoint
		switch change {
		case "old attempt":
			altered.Checkpoint.Projection = json.RawMessage(strings.Replace(string(projection), `"attempt":1`, `"attempt":2`, 1))
		case "wrong run":
			altered.Checkpoint.RunID = "other"
		case "wrong workspace":
			altered.Checkpoint.Target.WorkspaceID = "other"
		case "infra":
			run := *update.Checkpoint.Run
			run.FailureFault = "infra"
			altered.Checkpoint.Run = &run
		}
		tool, err := service.CertifyFlowFailure(ctx, altered)
		require.NoError(t, err)
		require.Nil(t, tool, change)
	}
	for _, bad := range []string{
		`{"exit_code":126,"stderr":"c2g6IDE6IGZpZ2xldDogbm90IGZvdW5kXG4=","error":{"code":"missing_machine_tool","class":"user","missing_tool":{"name":"figlet","file":".smithers/machine.json"}}}`,
		`{"exit_code":127,"stderr":"","error":{"code":"missing_machine_tool","class":"user","missing_tool":{"name":"figlet","file":".smithers/machine.json"}}}`,
		`{"exit_code":127,"stderr":"c2g6IDE6IGZpZ2xldDogbm90IGZvdW5kCg=="}`,
		`{"exit_code":127,"stderr":"c2g6IDE6IGZpZ2xldDogbm90IGZvdW5kCg==","error":{"code":"missing_machine_tool","class":"infra","missing_tool":{"name":"figlet","file":".smithers/machine.json"}}}`,
		`{"exit_code":127,"stderr":"c2g6IDE6IGZpZ2xldDogbm90IGZvdW5kCg==","error":{"code":"missing_machine_tool","class":"user","missing_tool":{"name":"cargo","file":".smithers/machine.json"}}}`,
	} {
		_, err = pool.Exec(ctx, `UPDATE product_job_requests SET terminal_receipt=$2::jsonb WHERE id=$1`, admitted.OperationID, bad)
		require.NoError(t, err)
		tool, err := service.CertifyFlowFailure(ctx, update)
		require.NoError(t, err)
		require.Nil(t, tool, bad)
	}
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET terminal_receipt=$2::jsonb WHERE id=$1`, admitted.OperationID, receipt)
	require.NoError(t, err)
	newer, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: "workspace.command", RequestID: "newer-command", Payload: payload, EffectPolicy: jobs.EffectUnsafe})
	require.NoError(t, err)
	tool, err := service.CertifyFlowFailure(ctx, update)
	require.NoError(t, err)
	require.Nil(t, tool, "a newer unfinished command hides the earlier failure")
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET created_at=NOW()-interval '1 day' WHERE id=$1`, newer.OperationID)
	require.NoError(t, err)
	update.Checkpoint.FailureMissingTool = certified
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	failedCard := call("GET", path, "", "", 200)
	failure := failedCard["failure"].(map[string]any)
	require.Equal(t, map[string]any{"name": "figlet", "file": ".smithers/machine.json"}, failure["missing_tool"])
	require.Equal(t, "user", failure["class"])
	retry := call("POST", path, `{"op":"retry","steer":"Use the repaired image"}`, "retry-once", 202)
	require.EqualValues(t, 2, retry["attempt"])
	require.Equal(t, retry, call("POST", path, `{"op":"retry","steer":"Use the repaired image"}`, "retry-once", 202))
	retriedCard := call("GET", path, "", "", 200)
	require.Equal(t, failedCard["evidence"], retriedCard["evidence"], "Retry retains the ended attempt verbatim")
	var attempts []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'attempts' FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo, n).Scan(&attempts))
	require.Contains(t, string(attempts), "card-run")
}
