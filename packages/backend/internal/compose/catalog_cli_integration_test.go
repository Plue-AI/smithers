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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-CAT-02: the source CLI parser and production dispatcher cross a real HTTP
// listener, delegated authorization, and PostgreSQL confirmation transactions.
func TestCatalogCLIConfirmationsPostgres(t *testing.T) {
	for _, via := range []string{"cli", "claude-code", "codex"} {
		t.Run(via, func(t *testing.T) { catalogCLIConfirmationsPostgres(t, via) })
	}
}

func catalogCLIConfirmationsPostgres(t *testing.T, via string) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"demo","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo.ID))}))
	for _, u := range []db.User{owner, other} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, u.ID)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `UPDATE collaborators SET github_id=199,github_login='maya' WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos','199','{}')`, owner.ID)
	require.NoError(t, err)
	session := func(u db.User) string {
		raw := u.Username + "-confirmation-session"
		sum := sha256.Sum256([]byte(raw))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return raw
	}
	ownerCookie := session(owner)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionSecret = "catalog-fixture-secret"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}

	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	todos := services.NewMythicalService(pool, nil)
	todos.EnableTodoSteering()
	todos.SetTodoFlow(func(ctx context.Context, repositoryID int64, source string) (string, error) {
		return services.ActiveFlowDigest(ctx, q, repositoryID, "todo")
	})
	receiver := &reviewFixtureReceiver{messages: map[string]flowruntime.Steer{}}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return receiver, nil
	}), SteerAuthorizer: todos, Projector: todos})
	require.NoError(t, err)
	todos.SetLauncher(dispatcher)
	approvals := services.NewApprovalsService(q, services.WithConfirmationTodos(pool, todos))
	github := &rosterGitHub{roles: map[string]string{"maya": "admin"}, login: "maya"}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = strings.Replace(r.URL.Path, "/repos/maya/demo", "/repos/owner/app", 1)
		github.serve(w, r)
	}))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	issuer := services.NewAuthService(q, cfg.Auth, nil, auth.NewGitHubClient(ownerOAuthCredentials{"client", "secret"}, "", provider.URL, provider.URL))
	issuer.Members = &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	issuer.InstallSetup = &services.InstallSetupSessions{Pool: pool}
	router := githubAppSetupComposeRouter(cfg, pool, nil,
		&routes.AuthHandler{Service: issuer, AuthConfig: cfg.Auth, InstallSetup: issuer.InstallSetup},
		&routes.UserHandler{ProfileService: services.NewUserService(q), TokenService: issuer},
		routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: approvals})
	var sshRequests atomic.Int32
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ssh" {
			sshRequests.Add(1)
		}
		router.ServeHTTP(w, r)
	})
	server.Start()
	defer server.Close()
	// The real CLI OAuth callback independently issues each agent identity.
	// Public token payloads cannot choose via, so header/payload variations on
	// one generic CLI token would not qualify Claude Code or Codex minting.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	callbackState := strings.Repeat("c", 43)
	start, err := client.Get(server.URL + "/api/auth/github/cli?callback_port=43210&callback_state=" + callbackState + "&agent=" + via)
	require.NoError(t, err)
	require.NoError(t, start.Body.Close())
	require.Equal(t, http.StatusFound, start.StatusCode)
	providerURL, err := url.Parse(start.Header.Get("Location"))
	require.NoError(t, err)
	callbackRequest, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/auth/github/callback?code=fixture-code&state="+providerURL.Query().Get("state"), nil)
	require.NoError(t, err)
	for _, cookie := range start.Cookies() {
		callbackRequest.AddCookie(cookie)
	}
	callback, err := client.Do(callbackRequest)
	require.NoError(t, err)
	callbackBody, err := io.ReadAll(callback.Body)
	require.NoError(t, err)
	require.NoError(t, callback.Body.Close())
	require.Equal(t, http.StatusFound, callback.StatusCode, string(callbackBody))
	redirect, err := url.Parse(callback.Header.Get("Location"))
	require.NoError(t, err)
	issued, err := url.ParseQuery(redirect.Fragment)
	require.NoError(t, err)
	require.Equal(t, callbackState, issued.Get("callback_state"))
	require.Equal(t, "delegated", issued.Get("kind"))
	require.Equal(t, via, issued.Get("via"))
	token := issued.Get("token")
	require.NotEmpty(t, token)
	sum := sha256.Sum256([]byte(token))
	stored, err := q.GetAuthInfoByTokenHash(ctx, hex.EncodeToString(sum[:]))
	require.NoError(t, err)
	require.Equal(t, owner.ID, stored.ID)
	require.True(t, stored.TokenSystemIssued)
	require.Contains(t, stored.TokenScopes, "via:"+via)
	require.NotContains(t, stored.TokenScopes, "profile:terminal_s1")
	require.Equal(t, middleware.CredentialDelegated, middleware.TokenCredentialKind(stored.TokenSystemIssued, stored.TokenScopes, "person", true))
	invoke := catalogCLIInvoker(t, ctx, server.URL, token)
	code, receipt := invoke("todo", "new", "--text", "Keep the exact delegated request", "--title", "Retry", "--idempotencyKey", "catalog-new")
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	require.Equal(t, "Waiting for maya to confirm", receipt["message"])
	id, ok := receipt["confirmation"].(string)
	require.True(t, ok, receipt)
	replayCode, replay := invoke("todo", "new", "--text", "Keep the exact delegated request", "--title", "Retry", "--idempotencyKey", "catalog-new")
	require.Equal(t, 3, replayCode)
	require.Equal(t, receipt, replay)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Zero(t, count, "CLI launch must not execute the confirmed operation")
	// Only the person's browser session can approve the same stored request.
	approve := func(confirmation, key string) {
		t.Helper()
		r := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/confirmations/"+confirmation+"/approve", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:51900"
		r.Header.Set("Origin", cfg.Server.PublicURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", key)
		r.Header.Set("X-CSRF-Token", "csrf")
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		r.AddCookie(&http.Cookie{Name: "session", Value: ownerCookie})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		require.Equal(t, 200, w.Code, w.Body.String())
	}
	approve(id, "catalog-approve")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Equal(t, 1, count)
	var number int64
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT number,issue_body FROM mythical_items`).Scan(&number, &prompt))
	require.Equal(t, "Keep the exact delegated request", prompt)
	// A delegated steer is immediate, durable feedback, not a confirmation.
	code, receipt = invoke("todo", "steer", fmt.Sprintf("T%d", number), "Keep the same retry helper", "--idempotencyKey", "catalog-steer")
	require.Equal(t, 0, code, receipt)
	require.NotContains(t, receipt, "confirmation")
	var feedback []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'steers' FROM mythical_items WHERE number=$1`, number).Scan(&feedback))
	var steers []map[string]any
	require.NoError(t, json.Unmarshal(feedback, &steers))
	require.Len(t, steers, 1)
	require.Equal(t, "Keep the same retry helper", steers[0]["text"])
	code, replay = invoke("todo", "steer", fmt.Sprintf("T%d", number), "Keep the same retry helper", "--idempotencyKey", "catalog-steer")
	require.Equal(t, 0, code, replay)
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_array_length(checks->'steers') FROM mythical_items WHERE number=$1`, number).Scan(&count))
	require.Equal(t, 1, count, "replayed steering must not append feedback twice")
	code, receipt = invoke("todo", "show", fmt.Sprintf("T%d", number))
	require.Equal(t, 0, code, receipt)
	code, receipt = invoke("todo", "drop", fmt.Sprintf("T%d", number))
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items`).Scan(&state))
	require.Equal(t, "queued", state)
	// The placement consumer has landed: preserve --before through the
	// source CLI and private confirmation, with no item before the press.
	code, receipt = invoke("todo", "new", "--text", "Before the first item", "--before", fmt.Sprintf("T%d", number), "--idempotencyKey", "catalog-before")
	require.Equal(t, 3, code, receipt)
	require.Equal(t, "pending", receipt["state"])
	beforeID, ok := receipt["confirmation"].(string)
	require.True(t, ok, receipt)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Equal(t, 1, count)
	code, replay = invoke("todo", "new", "--text", "Before the first item", "--before", fmt.Sprintf("T%d", number), "--idempotencyKey", "catalog-before")
	require.Equal(t, 3, code, replay)
	require.Equal(t, receipt, replay)
	approve(beforeID, "catalog-before-approve")
	var placed int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT number FROM mythical_items WHERE issue_body=$1`, "Before the first item").Scan(&placed))
	var order []int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(number ORDER BY stack_position) FROM mythical_items WHERE repository_id=$1`, repo.ID).Scan(&order))
	require.Equal(t, []int64{placed, number}, order, "the approved TODO must precede its named item, not append")
	approve(beforeID, "catalog-before-approve")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
	require.Equal(t, 2, count, "a repeated approval must not create another item")
	// Missing merge evidence is never fabricated into pending or success.
	code, receipt = invoke("merge", fmt.Sprintf("T%d", number), "--reviewed_head_sha", strings.Repeat("a", 40))
	require.Equal(t, 1, code, receipt)
	require.Equal(t, "confirmation_unavailable", receipt["code"])
	require.NotContains(t, receipt, "confirmation")
	// 5d21b2a5a6 gave Debug API its CLI door through the install's shared
	// authorization; a delegated CLI credential is refused there with never.
	code, receipt = invoke("debug", "api")
	require.Equal(t, 1, code, receipt)
	require.Equal(t, "never", receipt["code"])
	// The independently OAuth-minted issuer crosses the same person-only CLI
	// door in all three states. Each state must reach the install exactly once;
	// a local never refusal would conceal both scope and credential death.
	var beforeTodos, beforeConfirm, beforeJobs int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&beforeTodos))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&beforeConfirm))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&beforeJobs))
	for i, state := range []string{"full", "narrow", "dead"} {
		if state == "narrow" {
			_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$1 WHERE token_hash=$2`, "read:user,via:"+via, hex.EncodeToString(sum[:]))
			require.NoError(t, err)
		} else if state == "dead" {
			_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(sum[:]))
			require.NoError(t, err)
		}
		code, refusal := invoke("ssh", "main")
		require.Equal(t, 1, code, state)
		expectedClass, expectedCode := "never", "never"
		if state == "narrow" {
			expectedClass, expectedCode = "permission", "permission"
		}
		if state == "dead" {
			expectedClass, expectedCode = "permission", "unauthenticated"
		}
		require.Equal(t, expectedClass, refusal["class"], state)
		require.Equal(t, expectedCode, refusal["code"], state)
		require.NotContains(t, refusal, "confirmation")
		require.NotContains(t, refusal, "state")
		require.Equal(t, int32(i+1), sshRequests.Load(), state)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&count))
		require.Equal(t, beforeTodos, count)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&count))
		require.Equal(t, beforeConfirm, count)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests`).Scan(&count))
		require.Equal(t, beforeJobs, count)
	}
}

// The source parser and dispatcher run in an isolated home against the install listener.
func catalogCLIInvoker(t *testing.T, ctx context.Context, origin, token string) func(...string) (int, map[string]any) {
	t.Helper()
	invoke := catalogCLIValueInvoker(t, ctx, origin, token)
	return func(argv ...string) (int, map[string]any) {
		code, value := invoke(argv...)
		result, ok := value.(map[string]any)
		require.True(t, ok, "expected object CLI result: %v", value)
		return code, result
	}
}

func catalogCLIValueInvoker(t *testing.T, ctx context.Context, origin, token string) func(...string) (int, any) {
	t.Helper()
	cli, err := filepath.Abs("../../../smithers/src/Cli.ts")
	require.NoError(t, err)
	home := t.TempDir()
	return func(argv ...string) (int, any) {
		t.Helper()
		encoded, err := json.Marshal(append(argv, "--json"))
		require.NoError(t, err)
		script := `import { pathToFileURL } from "node:url";
const { makeCli } = await import(pathToFileURL(process.env.CATALOG_CLI).href);
let stdout = "", code = 0;
await makeCli({ environment: process.env, exit: n => { code = n } }).serve(JSON.parse(process.env.CATALOG_ARGV), {
 env: process.env, stdout: text => { stdout += text }, exit: n => { code = n }
});
console.log(JSON.stringify({ code, result: JSON.parse(stdout) }));`
		command := exec.CommandContext(ctx, "node", "--no-warnings", "--input-type=module")
		command.Stdin = strings.NewReader(script)
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "XDG_CONFIG_HOME=" + home, "XDG_DATA_HOME=" + home,
			"CATALOG_CLI=" + cli, "CATALOG_ARGV=" + string(encoded), "SMITHERS_API_ORIGIN=" + origin, "SMITHERS_TOKEN=" + token, "CODEX_TEST=1"}
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		var response struct {
			Code   int `json:"code"`
			Result any `json:"result"`
		}
		require.NoError(t, json.Unmarshal(output, &response), string(output))
		return response.Code, response.Result
	}
}
