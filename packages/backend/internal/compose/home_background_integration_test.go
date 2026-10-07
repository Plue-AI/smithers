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

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type homeMachineBoundary struct{ level workspace.IsolationLevel }

func (m homeMachineBoundary) Isolation() workspace.IsolationLevel { return m.level }

// This proves HTTP admission/storage, not guest execution: the VM has no microVM.
func TestHomeBackgroundRetryIdempotent(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "homeowner", LowerUsername: "homeowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "homemember", LowerUsername: "homemember"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id IN ($1,$2)`, owner.ID, member.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin'),($1,$3,'write')`, repo, owner.ID, member.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"homeowner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo, time.Now().UTC().Format(time.RFC3339Nano)))}))
	}
	for token, user := range map[string]db.User{"home-owner": owner, "home-member": member} {
		hash := sha256.Sum256([]byte(token))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo, owner.ID)
	require.NoError(t, err)
	def, err := q.EnsureWorkflowDefinitionReference(ctx, db.EnsureWorkflowDefinitionReferenceParams{RepositoryID: repo, Name: "wiki", Path: "flows/wiki/flow.ts", Config: []byte(`{}`)})
	require.NoError(t, err)
	failed, err := q.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{RepositoryID: repo, WorkflowDefinitionID: def.ID, Status: "failure", TriggerEvent: "invoke", TriggerRef: "main", DispatchInputs: []byte(`{"page":"Home"}`), ExecutionPlane: "flow"})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	resolved := 0
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		resolved++
		return nil, errors.New("test admission must not resolve a host")
	})})
	require.NoError(t, err)
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	original, err := dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: "original-home-run", Target: flowruntime.Target{BindingKind: "workflow-invoke", BindingID: fmt.Sprint(failed.ID)}, FlowID: "wiki", Payload: failed.DispatchInputs, ApprovalPolicy: flowdispatch.ApprovalAuto, Pin: &flowruntime.Pin{Flow: "wiki", SourceCommit: source, ExecutionDigest: digest}})
	require.NoError(t, err)
	var originalPayload []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE id=$1`, original.OperationID).Scan(&originalPayload))
	checkpoint, _ := json.Marshal(flowdispatch.RuntimeCheckpoint{Version: 1, ExecutionDigest: digest})
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, original.OperationID, checkpoint)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workflow_run_flow_invocations(workflow_run_id,user_id,flow_id,operation_id,trigger_commit,source_revision) VALUES($1,$2,'wiki',$3,$4,$4)`, failed.ID, owner.ID, original.OperationID, source)
	require.NoError(t, err)
	invoker := services.NewInvokedFlowService(pool, nil, nil)
	invoker.SetFlowDispatcher(dispatcher)
	provider := &services.HomeBackground{Pool: pool, Invoker: invoker, Billing: services.NewUnlimitedBillingPolicy(), Machine: homeMachineBoundary{workspace.IsolationSandboxed}}
	service := services.NewMythicalService(pool, nil)
	service.SetHomeBackground(provider)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	server := httptest.NewUnstartedServer(nil)
	defer server.Close()
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	hubCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(hubCtx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	topics := &liveTopics{queries: q, todos: service}
	liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubCtx, nil), Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, routerExtras{Background: provider, Live: liveHandler, Mythical: &routes.MythicalHandler{Service: service}})
	server.Start()
	post := func(token, op, key string) *http.Response {
		t.Helper()
		request, err := http.NewRequest(http.MethodPost, origin+fmt.Sprintf("/api/runs/%d", failed.ID), strings.NewReader(`{"op":"`+op+`"}`))
		require.NoError(t, err)
		request.Header.Set("Cookie", "smithers_session="+token+"; __csrf=home-csrf")
		request.Header.Set("X-CSRF-Token", "home-csrf")
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		response, err := server.Client().Do(request)
		require.NoError(t, err)
		t.Cleanup(func() { response.Body.Close() })
		return response
	}
	t.Run("HomeBackgroundAdmissionRefusals", func(t *testing.T) {
		require.Equal(t, 400, post("home-member", "retry", "").StatusCode)
		require.Equal(t, 400, post("home-member", "delete", "invalid").StatusCode)
		_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status='success' WHERE id=$1`, failed.ID)
		require.NoError(t, err)
		require.Equal(t, 409, post("home-member", "dismiss", "completed").StatusCode)
		require.Equal(t, 409, post("home-member", "retry", "completed").StatusCode)
		_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status='failure' WHERE id=$1`, failed.ID)
		require.NoError(t, err)
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, repo).Scan(&count))
		require.Equal(t, 1, count)
		var dismissed bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT dismissed_at IS NOT NULL FROM workflow_runs WHERE id=$1`, failed.ID).Scan(&dismissed))
		require.False(t, dismissed)
	})
	first := post("home-member", "retry", "one")
	if first.StatusCode != 202 {
		var refusal any
		_ = json.NewDecoder(first.Body).Decode(&refusal)
		t.Fatalf("Retry status %d: %#v", first.StatusCode, refusal)
	}
	var receipt services.HomeBackgroundReceipt
	require.NoError(t, json.NewDecoder(first.Body).Decode(&receipt))
	duplicate := post("home-member", "retry", "one")
	require.Equal(t, 202, duplicate.StatusCode)
	var replay services.HomeBackgroundReceipt
	require.NoError(t, json.NewDecoder(duplicate.Body).Decode(&replay))
	require.Equal(t, receipt, replay)
	require.Equal(t, 202, post("home-member", "retry", "two").StatusCode)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 3, count)
	require.Zero(t, resolved)
	var retryPayload []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE payload->'projection'->>'workflowRunId'=$1`, fmt.Sprint(receipt.RunID)).Scan(&retryPayload))
	var launch struct {
		Flow  string            `json:"flowId"`
		Pin   flowruntime.Pin   `json:"pin"`
		Input map[string]string `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(retryPayload, &launch))
	require.Equal(t, "wiki", launch.Flow)
	require.Equal(t, flowruntime.Pin{Flow: "wiki", SourceCommit: source, ExecutionDigest: digest}, launch.Pin)
	require.Equal(t, map[string]string{"page": "Home"}, launch.Input)
	require.Equal(t, 400, post("home-member", `retry","flow":"evil`, "tamper").StatusCode)
	require.Equal(t, 401, post("no-session", "retry", "unknown").StatusCode)
	t.Run("HomeDependencyUnavailable", func(t *testing.T) {
		provider.Billing = nil
		require.Equal(t, 503, post("home-member", "retry", "missing").StatusCode)
		provider.Billing = services.NewUnlimitedBillingPolicy()
		provider.Invoker = nil
		require.Equal(t, 503, post("home-member", "retry", "missing").StatusCode)
		provider.Invoker = invoker
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt='{}' WHERE operation_id=$1`, original.OperationID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE product_job_requests SET payload=payload-'pin' WHERE id=$1`, original.OperationID)
		require.NoError(t, err)
		require.Equal(t, 409, post("home-member", "retry", "missing-pin").StatusCode)
		_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, original.OperationID, checkpoint)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE product_job_requests SET payload=$2 WHERE id=$1`, original.OperationID, originalPayload)
		require.NoError(t, err)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, repo).Scan(&count))
		require.Equal(t, 3, count)
	})
	externalToken := "smithers_" + strings.Repeat("c", 40)
	tokenHash := sha256.Sum256([]byte(externalToken))
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: member.ID, Name: "external-home", TokenHash: hex.EncodeToString(tokenHash[:]), TokenLastEight: hex.EncodeToString(tokenHash[:])[56:], Scopes: "write:repository,read:user,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	delegated, err := http.NewRequest(http.MethodPost, origin+fmt.Sprintf("/api/runs/%d", failed.ID), strings.NewReader(`{"op":"retry"}`))
	require.NoError(t, err)
	delegated.Header.Set("Authorization", "Bearer "+externalToken)
	delegated.Header.Set("Content-Type", "application/json")
	delegated.Header.Set("Idempotency-Key", "external")
	delegatedResponse, err := server.Client().Do(delegated)
	require.NoError(t, err)
	defer delegatedResponse.Body.Close()
	require.Equal(t, 403, delegatedResponse.StatusCode)
	provider.Machine = homeMachineBoundary{workspace.IsolationTrustedProcess}
	require.Equal(t, 503, post("home-member", "retry", "three").StatusCode)
	provider.Machine = nil
	require.Equal(t, 503, post("home-member", "retry", "three").StatusCode)
	require.Equal(t, 200, post("home-member", "dismiss", "dismiss").StatusCode)
	require.Equal(t, 200, post("home-owner", "dismiss", "dismiss-again").StatusCode)
	var dismissed int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT dismissed_by FROM workflow_runs WHERE id=$1 AND dismissed_at IS NOT NULL`, failed.ID).Scan(&dismissed))
	require.Equal(t, member.ID, dismissed)
	// Independently seed the ticket's 200-item send-budget boundary. Both
	// members read it through the composed live door, never a helper builder.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,number,stack_position,base_commit,candidate_head)
        SELECT $1,'chat','queued','Queued TODO ' || n,n,n,'main-' || n,'candidate-' || n FROM generate_series(1,200) n`, repo)
	require.NoError(t, err)
	var sharedHome json.RawMessage
	for _, token := range []string{"home-owner", "home-member"} {
		readCtx, done := context.WithTimeout(ctx, 10*time.Second)
		conn, _, err := websocket.Dial(readCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"smithers_session=" + token}}})
		require.NoError(t, err)
		conn.SetReadLimit(2 << 20)
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
			if sharedHome == nil {
				sharedHome = append(json.RawMessage(nil), frame.Data...)
			} else {
				require.Equal(t, sharedHome, frame.Data, "members must receive identical committed Home bytes")
			}
			require.Less(t, len(raw), 2<<20, "200-item Home exceeds the live send budget")
			var home struct {
				Runs  []map[string]any `json:"background_runs"`
				Items []struct {
					N     int    `json:"n"`
					Title string `json:"title"`
				} `json:"items"`
				Counts map[string]int `json:"counts"`
			}
			require.NoError(t, json.Unmarshal(frame.Data, &home))
			require.Len(t, home.Items, 200)
			require.Equal(t, 200, home.Counts["queued"])
			for index, item := range home.Items {
				require.Equal(t, index+1, item.N)
				require.Equal(t, fmt.Sprintf("Queued TODO %d", index+1), item.Title)
			}
			require.Len(t, home.Runs, 2)
			for _, row := range home.Runs {
				require.NotEqual(t, fmt.Sprint(failed.ID), row["id"])
			}
			break
		}
		conn.CloseNow()
		done()
	}
	statusRequest, err := http.NewRequest(http.MethodGet, origin+fmt.Sprintf("/api/runs/%d/background-status", receipt.RunID), nil)
	require.NoError(t, err)
	statusRequest.Header.Set("Cookie", "smithers_session=home-member")
	statusResponse, err := server.Client().Do(statusRequest)
	require.NoError(t, err)
	require.Equal(t, 200, statusResponse.StatusCode)
	var status services.HomeBackgroundReceipt
	require.NoError(t, json.NewDecoder(statusResponse.Body).Decode(&status))
	statusResponse.Body.Close()
	require.Equal(t, services.HomeBackgroundReceipt{State: "queued", RunID: receipt.RunID}, status)
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status='success' WHERE id=$1`, receipt.RunID)
	require.NoError(t, err)
	statusResponse, err = server.Client().Do(statusRequest)
	require.NoError(t, err)
	require.Equal(t, 200, statusResponse.StatusCode)
	require.NoError(t, json.NewDecoder(statusResponse.Body).Decode(&status))
	statusResponse.Body.Close()
	require.Equal(t, services.HomeBackgroundReceipt{State: "success", RunID: receipt.RunID}, status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 3, count)
}
