package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
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

// The guest's measured output is the only fixture. Authentication, storage,
// catalog projection and the install router are real; this is not a microVM receipt.
func TestInstallFlowCatalogShowsReservedDeclarationRefusal(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "flow-owner", LowerUsername: "flow-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES ($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES ($1,'app','app','main') RETURNING id`, owner.ID).Scan(&repo))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: json.RawMessage(`{"owner_login":"flow-owner","repository_name":"app"}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: json.RawMessage(`{"owner_login":"flow-owner","repository_name":"app","last_access_check_at":"2026-10-06T17:00:00Z"}`)}))
	cookie := "flow-reserved-owner-session"
	digest := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(digest[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 100, false)
	require.NoError(t, err)
	load, err := q.EnsureFlowLoad(ctx, repo)
	require.NoError(t, err)
	load.CommitID, load.LoadedCommit = strings.Repeat("a", 40), strings.Repeat("a", 40)
	load.Versions = json.RawMessage(`[{"name":"merge","path":"flows/merge/flow.ts","digest":"` + strings.Repeat("b", 64) + `","status":"failed","error":"flows/merge/flow.ts: reserved_name"},{"name":"custom","path":"flows/custom/flow.ts","digest":"` + strings.Repeat("c", 64) + `","status":"failed","error":"invalid type"},{"name":"checks/canary","path":"flows/checks/canary/flow.ts","digest":"` + strings.Repeat("d", 64) + `","status":"failed","error":"invalid type"}]`)
	load, err = q.SaveFlowLoad(ctx, load)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	var resolutions atomic.Int64
	var success atomic.Bool
	runtime := &installFlowRuntime{launches: make(chan flowruntime.Launch, 2)}
	entered, release := make(chan struct{}, 1), make(chan struct{})
	revocationEntered, revocationRelease := make(chan struct{}, 1), make(chan struct{})
	const revokedMachine = "22222222-2222-4222-8222-222222222222"
	targetResolver := browserFlowTarget{queries: q, install: q}
	// Keep the real worker's idle backoff within the fixture's completion window.
	// Production polling may back off to 30 seconds; this test waits five.
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, ObservationDelay: 10 * time.Millisecond, MaxObservationDelay: 20 * time.Millisecond, Resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		resolutions.Add(1)
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if target.WorkspaceID == revokedMachine {
			select {
			case revocationEntered <- struct{}{}:
			default:
			}
			select {
			case <-revocationRelease:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if _, err := targetResolver.ResolveFlowHostTarget(ctx, target); err != nil {
			return nil, err
		}
		if success.Load() {
			return runtime, nil
		}
		return nil, installFlowFixtureFailure{}
	})})
	require.NoError(t, err)
	runs := &services.InstallFlowRuns{Queries: q, Dispatcher: dispatcher, Jobs: store}

	router := buildRouterCompat(cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{FlowRuns: runs, GitHubAppSetup: &routes.GitHubAppSetupHandler{Origins: middleware.FixedOrigins(cfg.Server.AllowedOrigins...)}})
	server.Config.Handler = router
	server.Start()
	t.Cleanup(server.Close)
	read := func() []services.FlowCard {
		request := httptest.NewRequest(http.MethodGet, cfg.Server.PublicURL+"/api/flows", nil)
		request.RemoteAddr = "127.0.0.1:51999"
		request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, 200, response.Code, response.Body.String())
		var cards []services.FlowCard
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &cards))
		return cards
	}
	for _, name := range []string{"todo", "merge", "checks/canary", "missing"} {
		request := httptest.NewRequest(http.MethodGet, cfg.Server.PublicURL+"/api/flows/"+url.PathEscape(name), nil)
		request.RemoteAddr = "127.0.0.1:51999"
		request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if name == "missing" {
			require.Equal(t, 404, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), "flow_not_found")
			continue
		}
		require.Equal(t, 200, response.Code, response.Body.String())
		var card services.FlowCard
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card))
		require.Equal(t, name, card.Name)
		require.Equal(t, name == "merge", card.System)
	}
	cards := read()
	var refused, custom, builtin bool
	for _, card := range cards {
		switch card.Name {
		case "merge":
			refused = true
			require.True(t, card.System)
			require.Equal(t, "flows/merge/flow.ts", card.Source.Path)
			require.Len(t, card.Versions, 1)
			require.Equal(t, "merged-failed", card.Versions[0].State)
			require.Equal(t, "reserved_name", card.Versions[0].Error)
			require.Empty(t, card.Versions[0].Steps)
		case "custom":
			custom = true
			require.False(t, card.System)
			require.Equal(t, "invalid type", card.Versions[0].Error)
		case "todo":
			builtin = true
			require.Equal(t, "active", card.Versions[0].State)
		}
	}
	require.True(t, refused)
	require.True(t, custom, "failed-only declarations must remain visible")
	require.True(t, builtin)
	_, err = services.ActiveFlowDigest(ctx, q, repo, "merge")
	require.ErrorContains(t, err, "install-owned")
	// Removing the declaration removes the refusal without changing the builtin.
	load.Versions = json.RawMessage(`[]`)
	load, err = q.SaveFlowLoad(ctx, load)
	require.NoError(t, err)
	for _, card := range read() {
		require.NotEqual(t, "merge", card.Name)
	}
	t.Run("durable run door", func(t *testing.T) {
		machine := "11111111-1111-4111-8111-111111111111"
		_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status) VALUES ($1,$2,$3,'canary','canary','running')`, machine, repo, owner.ID)
		require.NoError(t, err)
		call := func(method, path, body, key string, signed bool) *httptest.ResponseRecorder {
			request := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
			request.RemoteAddr = "127.0.0.1:51999"
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", cfg.Server.PublicURL)
			request.Header.Set("Idempotency-Key", key)
			if signed {
				request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
				request.AddCookie(&http.Cookie{Name: "__csrf", Value: "flow-csrf"})
				request.Header.Set("X-CSRF-Token", "flow-csrf")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			return response
		}
		body := fmt.Sprintf(`{"name":"canary","workspaceId":%q,"input":{"hello":"guest"}}`, machine)
		for _, tc := range []struct {
			name, body, key string
			signed          bool
			status          int
			code            string
		}{
			{"signed out", body, "run", false, 401, "unauthenticated"},
			{"missing key", body, "", true, 400, "invalid_flow_run"},
			{"unknown field", `{"name":"canary","repo":"elsewhere"}`, "run", true, 400, "invalid_flow_run"},
			{"extra JSON", body + `{}`, "run", true, 400, "invalid_flow_run"},
			{"reserved", strings.Replace(body, "canary", "merge", 1), "run", true, 403, "reserved_name"},
			{"todo", strings.Replace(body, "canary", "todo", 1), "run", true, 403, "todo_requires_stack_admission"},
			{"review", strings.Replace(body, "canary", "review", 1), "run", true, 403, "review_requires_pr"},
			{"another branch", strings.Replace(body, machine, "22222222-2222-4222-8222-222222222222", 1), "run", true, 404, "branch_not_found"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				answer := call("POST", "/api/flows", tc.body, tc.key, tc.signed)
				require.Equal(t, tc.status, answer.Code, answer.Body.String())
				require.Contains(t, answer.Body.String(), tc.code)
			})
		}
		t.Run("encoded reserved name", func(t *testing.T) {
			request := fmt.Sprintf(`{"workspaceId":%q,"input":{}}`, machine)
			refused := call("POST", "/api/flows/%6derge/run", request, "encoded-reserved", true)
			require.Equal(t, 403, refused.Code, refused.Body.String())
			require.Contains(t, refused.Body.String(), "reserved_name")
			double := call("POST", "/api/flows/%256derge/run", request, "double-encoded", true)
			require.Equal(t, 400, double.Code, double.Body.String())
			require.Contains(t, double.Body.String(), "invalid_flow_run")
		})
		// The generated CLI descriptor must supply the same strict body as
		// the browser/API door, with real install authentication and storage.
		token := "smithers_" + strings.Repeat("d", 40)
		tokenDigest := sha256.Sum256([]byte(token))
		tokenHash := hex.EncodeToString(tokenDigest[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "canary-cli", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		cliCtx, stopCLI := context.WithTimeout(ctx, 30*time.Second)
		defer stopCLI()
		code, cliReceipt := catalogCLIInvoker(t, cliCtx, server.URL, token)("flow", "run", "checks/canary", "--workspaceId", machine, "--repo", "flow-owner/app", "--input", `{"hello":"guest"}`)
		require.Equal(t, 0, code, cliReceipt)
		require.Equal(t, string(jobs.StateAccepted), cliReceipt["state"])
		cliID, ok := cliReceipt["operationId"].(string)
		require.True(t, ok, cliReceipt)
		require.NotEmpty(t, cliID)
		answer := call("POST", "/api/flows", body, "run", true)
		require.Equal(t, 202, answer.Code, answer.Body.String())
		var receipt jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(answer.Body.Bytes(), &receipt))
		require.Equal(t, jobs.StateAccepted, receipt.State)
		require.Equal(t, int64(0), resolutions.Load(), "HTTP must not contact the runtime")
		// A lost reply or reloaded client joins the same persisted request.
		again := call("POST", "/api/flows/canary/run", body, "run", true)
		require.Equal(t, 202, again.Code, again.Body.String())
		require.JSONEq(t, answer.Body.String(), again.Body.String())
		conflict := call("POST", "/api/flows", strings.Replace(body, "guest", "changed", 1), "run", true)
		require.Equal(t, 409, conflict.Code, conflict.Body.String())
		require.Contains(t, conflict.Body.String(), "idempotency_mismatch")
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE request_id='install-flow-run:run'`).Scan(&count))
		require.Equal(t, 1, count)
		workerCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "install-flow-proof", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond})
		}()
		t.Cleanup(func() { cancel(); require.NoError(t, <-done) })
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("worker never reached runtime")
		}
		// The runtime is deliberately unresolved. Catalog and progress still answer.
		require.NotEmpty(t, read())
		cliPending := call("GET", "/api/flows/runs/"+cliID, "", "", true)
		require.Equal(t, 200, cliPending.Code, cliPending.Body.String())
		require.NotContains(t, cliPending.Body.String(), `"state":"completed"`)
		pending := call("GET", "/api/flows/runs/"+receipt.OperationID, "", "", true)
		require.Equal(t, 200, pending.Code, pending.Body.String())
		require.NotContains(t, pending.Body.String(), `"state":"completed"`)
		close(release)
		require.Eventually(t, func() bool {
			failed := call("GET", "/api/flows/runs/"+receipt.OperationID, "", "", true)
			return failed.Code == 200 && strings.Contains(failed.Body.String(), `"state":"failed"`)
		}, 5*time.Second, 10*time.Millisecond)
		require.Equal(t, 401, call("GET", "/api/flows/runs/"+receipt.OperationID, "", "", false).Code)
		failure := call("GET", "/api/flows/runs/"+receipt.OperationID, "", "", true)
		require.Contains(t, failure.Body.String(), `"code":"runtime_unavailable"`)
		require.NotContains(t, failure.Body.String(), "authorization")
		success.Store(true)
		retry := call("POST", "/api/flows", body, "retry", true)
		require.Equal(t, 202, retry.Code, retry.Body.String())
		var retried jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(retry.Body.Bytes(), &retried))
		require.NotEqual(t, receipt.OperationID, retried.OperationID)
		select {
		case launch := <-runtime.launches:
			require.Equal(t, "canary", launch.FlowID)
			require.JSONEq(t, `{"hello":"guest"}`, string(launch.Payload))
		case <-time.After(5 * time.Second):
			t.Fatal("retry did not launch")
		}
		require.Eventually(t, func() bool {
			status := call("GET", "/api/flows/runs/"+retried.OperationID, "", "", true)
			return strings.Contains(status.Body.String(), `"runId":"guest-run"`) && !strings.Contains(status.Body.String(), `"state":"completed"`)
		}, 5*time.Second, 10*time.Millisecond)
		runtime.finished.Store(true)
		require.Eventually(t, func() bool {
			status := call("GET", "/api/flows/runs/"+retried.OperationID, "", "", true)
			return strings.Contains(status.Body.String(), `"state":"completed"`)
		}, 5*time.Second, 10*time.Millisecond)
		// Revocation after HTTP admission must win before any guest launch.
		_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status) VALUES($1,$2,$3,'revoked','revoked','running')`, revokedMachine, repo, owner.ID)
		require.NoError(t, err)
		before := runtime.started.Load()
		queued := call("POST", "/api/flows", strings.Replace(body, machine, revokedMachine, 1), "revoked", true)
		require.Equal(t, 202, queued.Code, queued.Body.String())
		var revoked jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(queued.Body.Bytes(), &revoked))
		select {
		case <-revocationEntered:
		case <-time.After(5 * time.Second):
			t.Fatal("request did not reach held resolver")
		}
		_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, owner.ID)
		require.NoError(t, err)
		close(revocationRelease)
		require.Eventually(t, func() bool {
			operation, err := store.Get(ctx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}, revoked.OperationID)
			if err != nil || operation.State != jobs.StateFailed {
				return false
			}
			var terminal struct {
				Code string `json:"errorCode"`
			}
			return json.Unmarshal(operation.TerminalReceipt, &terminal) == nil && terminal.Code == "permission"
		}, 5*time.Second, 10*time.Millisecond)
		require.Equal(t, before, runtime.started.Load(), "revoked authority must start no flow")
	})

}

// A runtime refusal is test-only; no fake successful microVM execution is claimed.
type installFlowFixtureFailure struct{}

func (installFlowFixtureFailure) Error() string              { return "runtime unavailable" }
func (installFlowFixtureFailure) FlowRuntimeCode() string    { return "runtime_unavailable" }
func (installFlowFixtureFailure) FlowRuntimeClass() string   { return "infra" }
func (installFlowFixtureFailure) FlowRuntimeRetryable() bool { return false }

// Test-only runtime contract for delayed completion through the production worker.
type installFlowRuntime struct {
	flowruntime.Runtime
	launches chan flowruntime.Launch
	finished atomic.Bool
	started  atomic.Int64
}

func (*installFlowRuntime) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}, nil
}
func (r *installFlowRuntime) Launch(_ context.Context, input flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.started.Add(1)
	select {
	case r.launches <- input:
	default:
	}
	return flowruntime.LaunchResult{ApplicationRequestID: input.ApplicationRequestID, OwnerGeneration: input.OwnerGeneration, RuntimeArtifactDigest: input.RuntimeArtifactDigest, SourceRevision: input.SourceRevision, PlanID: "guest-plan", Receipt: flowruntime.Receipt{Tag: "Accepted", RunID: "guest-run"}}, nil
}
func (r *installFlowRuntime) Observe(context.Context, string, string, int) (flowruntime.Observation, error) {
	status := "running"
	if r.finished.Load() {
		status = "completed"
	}
	output := `"guest output"`
	return flowruntime.Observation{Run: flowruntime.Run{RunID: "guest-run", FlowID: "canary", Status: status, FinalOutput: &output}, Terminal: r.finished.Load()}, nil
}
