package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDelegatedCredentialComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-04T22:00:00Z"}`)}))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'admin',101,'owner')`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos','101','{}')`, owner.ID)
	require.NoError(t, err)
	github := &rosterGitHub{roles: map[string]string{"owner": "admin", "writer": "write", "maintainer": "maintain", "admin": "admin", "reader": "read"}, login: "owner"}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionSecret = "fixture-secret"
	cfg.Auth.SessionCookieName = "session"
	svc := services.NewAuthService(q, cfg.Auth, nil, auth.NewGitHubClient(ownerOAuthCredentials{"client", "secret"}, "", provider.URL, provider.URL))
	svc.InstallSetup = &services.InstallSetupSessions{Pool: pool}
	svc.Members = members
	handler := &routes.AuthHandler{Service: svc, AuthConfig: cfg.Auth, InstallSetup: svc.InstallSetup}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{queries: q, members: members}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, handler, &routes.UserHandler{ProfileService: services.NewUserService(q), TokenService: svc, AuditService: services.NewAuditService(q)}, &routes.SSHKeyHandler{Service: services.NewSSHKeyService(q)}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: services.NewMythicalService(pool, nil)}, Members: &routes.MembersHandler{Service: members}, Live: liveHandler})
	server.Start()
	defer server.Close()

	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "queued", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,state='blocked',owner_id=$2,title='Retry',stack_position=1,attempt=1,revisions='[]' WHERE id=$1`, item.ID, owner.ID)
	require.NoError(t, err)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	callbackState := strings.Repeat("c", 43)
	start, err := client.Get(origin + "/api/auth/github/cli?callback_port=43210&callback_state=" + callbackState + "&agent=claude-code")
	require.NoError(t, err)
	require.Equal(t, 302, start.StatusCode)
	start.Body.Close()
	githubURL, err := url.Parse(start.Header.Get("Location"))
	require.NoError(t, err)
	request, err := http.NewRequest("GET", origin+"/api/auth/github/callback?code=fixture-code&state="+githubURL.Query().Get("state"), nil)
	require.NoError(t, err)
	for _, cookie := range start.Cookies() {
		request.AddCookie(cookie)
	}
	callback, err := client.Do(request)
	require.NoError(t, err)
	data, _ := io.ReadAll(callback.Body)
	callback.Body.Close()
	require.Equal(t, 302, callback.StatusCode, string(data))
	target, err := url.Parse(callback.Header.Get("Location"))
	require.NoError(t, err)
	values, err := url.ParseQuery(target.Fragment)
	require.NoError(t, err)
	require.Equal(t, "delegated", values.Get("kind"))
	require.Equal(t, "claude-code", values.Get("via"))
	require.Equal(t, callbackState, values.Get("callback_state"))
	raw := values.Get("token")
	require.NotEmpty(t, raw)
	digest := sha256.Sum256([]byte(raw))
	token, err := q.GetAuthInfoByTokenHash(ctx, hex.EncodeToString(digest[:]))
	require.NoError(t, err)
	require.True(t, token.TokenSystemIssued)
	require.Contains(t, token.TokenScopes, "via:claude-code")
	require.NotContains(t, token.TokenScopes, "approval")
	var expiry time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at FROM access_tokens WHERE id=$1`, token.TokenID).Scan(&expiry))
	require.WithinDuration(t, time.Now().Add(30*24*time.Hour), expiry, 10*time.Second)
	require.Equal(t, middleware.CredentialDelegated, middleware.TokenCredentialKind(token.TokenSystemIssued, token.TokenScopes, "person"))
	call := func(method, path, body, bearer string) (int, string) {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Smithers-Via", "codex")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "delegated-retry-key")
		res, err := client.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		return res.StatusCode, string(data)
	}
	status, body := call("GET", "/api/user", "", raw)
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"via":"claude-code"`)
	status, body = call("POST", "/api/todos/1", `{"op":"retry","steer":"Keep the retry guard"}`, raw)
	require.Equal(t, 202, status, body)
	var actor []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'actor' FROM product_job_requests WHERE operation='todo.retried' ORDER BY created_at DESC LIMIT 1`).Scan(&actor))
	require.Contains(t, string(actor), `"agent": "claude-code"`)
	require.Contains(t, string(actor), `"login": "owner"`)
	status, body = call("POST", "/api/user/tokens", `{"name":"laptop","scopes":["repo","user"],"via":"smithers"}`, raw)
	require.Equal(t, 201, status, body)
	var minted services.CreateTokenResult
	require.NoError(t, json.Unmarshal([]byte(body), &minted))
	require.Equal(t, "delegated", minted.Kind)
	require.Equal(t, "cli", minted.Via)
	require.NotContains(t, minted.Scopes, "write:approval")
	var metadata []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata FROM audit_log WHERE event_type='token.create' ORDER BY id DESC LIMIT 1`).Scan(&metadata))
	require.Contains(t, string(metadata), `"via": "claude-code"`)
	for _, agent := range []string{"smithers", "terminal", "Bad", "a_b", strings.Repeat("x", 33)} {
		res, err := client.Get(origin + "/api/auth/github/cli?callback_port=43210&agent=" + agent)
		require.NoError(t, err)
		res.Body.Close()
		require.Equal(t, 400, res.StatusCode, agent)
		require.Empty(t, res.Cookies())
	}
	legacyRaw := "smithers_" + strings.Repeat("f", 40)
	legacySum := sha256.Sum256([]byte(legacyRaw))
	legacyHash := hex.EncodeToString(legacySum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "legacy-pat", TokenHash: legacyHash, TokenLastEight: legacyHash[len(legacyHash)-8:], Scopes: "repo,user,write:approval,VIA:SMITHERS,PROFILE:terminal_s1", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	status, body = call("GET", "/api/user", "", legacyRaw)
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"credential_kind":"delegated"`)
	// A generic cli credential accepts codex as attribution only; it never
	// acquires smithers/app-agent authority from old, non-issuer bindings.
	require.Contains(t, body, `"via":"cli"`)
	var attributedVia string
	require.NoError(t, pool.QueryRow(ctx, `SELECT metadata->>'via' FROM audit_log WHERE event_type='delegated.request' ORDER BY id DESC LIMIT 1`).Scan(&attributedVia))
	require.Equal(t, "codex", attributedVia)
	row, err := q.GetAuthInfoByTokenHash(ctx, legacyHash)
	require.NoError(t, err)
	require.False(t, row.TokenSystemIssued)
	require.Equal(t, middleware.CredentialPerson, middleware.TokenCredentialKind(row.TokenSystemIssued, row.TokenScopes, "person"))
	turn, err := svc.MintForTurn(ctx, owner.ID, "turn-1")
	require.NoError(t, err)
	require.Equal(t, "smithers", turn.Via)
	require.WithinDuration(t, time.Now().Add(time.Hour), *turn.ExpiresAt, 10*time.Second)
	status, body = call("GET", "/api/user", "", turn.Token)
	require.Equal(t, 200, status, body)
	require.NoError(t, svc.DeleteToken(ctx, owner.ID, turn.ID))
	status, body = call("GET", "/api/user", "", turn.Token)
	require.Equal(t, 401, status, body)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "terminal", Kind: "agent", Status: "running", TargetBookmark: "mythical", EnvironmentSource: "repository"})
	require.NoError(t, err)
	terminalSession, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: workspace.ID, RepositoryID: repo.ID, UserID: owner.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	terminal, err := svc.MintForTerminal(ctx, owner.ID, repo.ID, workspace.ID, terminalSession.ID)
	require.NoError(t, err)
	require.Equal(t, "terminal", terminal.Via)
	require.WithinDuration(t, time.Now().Add(time.Hour), *terminal.ExpiresAt, 10*time.Second)
	status, body = call("GET", "/api/user", "", terminal.Token)
	require.Equal(t, 200, status, body)
	_, err = q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: terminalSession.ID, Status: "stopped"})
	require.NoError(t, err)
	_, err = svc.MintForTerminal(ctx, owner.ID, repo.ID, workspace.ID, terminalSession.ID)
	require.Error(t, err)
	before := time.Now()
	require.NoError(t, svc.DeleteToken(ctx, owner.ID, terminal.ID))
	require.Less(t, time.Since(before), 5*time.Second)
	status, body = call("GET", "/api/user", "", terminal.Token)
	require.Equal(t, 401, status, body)
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET expires_at=NOW()-interval '1 minute' WHERE id=$1`, minted.ID)
	require.NoError(t, err)
	status, body = call("GET", "/api/user", "", minted.Token)
	require.Equal(t, 401, status, body)
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	status, body = call("GET", "/api/user", "", raw)
	require.Equal(t, 401, status, body)
	_, err = svc.MintForTurn(ctx, owner.ID, "dead-turn")
	require.Error(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	savedOrigins := handler.Origins
	handler.Origins = nil
	noOrigin, err := client.Get(origin + "/api/auth/github/cli?callback_port=43210")
	require.NoError(t, err)
	data, _ = io.ReadAll(noOrigin.Body)
	noOrigin.Body.Close()
	require.Equal(t, 503, noOrigin.StatusCode, string(data))
	require.Empty(t, noOrigin.Cookies())
	status, body = call("POST", "/api/user/tokens", `{"name":"no-origin","scopes":["repo"]}`, raw)
	require.Equal(t, 503, status, body)
	handler.Origins = savedOrigins
	// The source executable calls makeCli against this real composed install;
	// the browser helper completes GitHub consent without substituting a token.
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	home := t.TempDir()
	browser := filepath.Join(home, "browser.mjs")
	require.NoError(t, os.WriteFile(browser, []byte("#!/usr/bin/env node\n"+`
const startURL = new URL(process.argv[2]);
const start = await fetch(startURL, {redirect:'manual'});
if(start.status!==302) throw Error(await start.text());
const cookies = start.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const github = new URL(start.headers.get('location'));
const callback = new URL('/api/auth/github/callback',startURL);
callback.search = new URLSearchParams({code:'fixture-code',state:github.searchParams.get('state')});
const consent = await fetch(callback,{redirect:'manual',headers:{cookie:cookies}});
if(consent.status!==302) throw Error(await consent.text());
const loopback = new URL(consent.headers.get('location'));
const values = Object.fromEntries(new URLSearchParams(loopback.hash.slice(1)));
loopback.hash='';
const settled = await fetch(loopback,{method:'POST',headers:{'content-type':'application/json',origin:loopback.origin},body:JSON.stringify(values)});
if(settled.status!==200) throw Error(await settled.text());
`), 0700))
	_, sourceFile, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
	cliCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	command := exec.CommandContext(cliCtx, node, filepath.Join(root, "packages/smithers/bin/smithers.mjs"), "login", origin, "--agent", "claude-code", "--format", "json")
	command.Dir = root
	command.Env = append(os.Environ(), "HOME="+home, "XDG_CONFIG_HOME="+home, "XDG_DATA_HOME="+home, "SMITHERS_AUTH_FILE="+filepath.Join(home, "auth.json"), "SMITHERS_DISABLE_SYSTEM_KEYRING=1", "SMITHERS_API_ORIGIN="+origin, "SMITHERS_TOKEN=", "SMITHERS_TOKEN_FILE=", "BROWSER="+browser)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.NotContains(t, string(output), `"token":`)
	saved, err := os.ReadFile(filepath.Join(home, "auth.json"))
	require.NoError(t, err)
	var credential struct {
		Kind  string `json:"kind"`
		Via   string `json:"via"`
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(saved, &credential))
	require.Equal(t, "claude-code", credential.Via)
	require.Equal(t, "delegated", credential.Kind)
	require.NotEmpty(t, credential.Token)
	require.NotContains(t, string(output), credential.Token)
	status, body = call("GET", "/api/user", "", credential.Token)
	require.Equal(t, 200, status, body)
	unavailableAuth := *handler
	withoutAuthorization := buildRouterCompat(cfg, nil, pool, &routes.RepoHandler{}, &unavailableAuth, &routes.UserHandler{ProfileService: services.NewUserService(q), TokenService: svc, AuditService: services.NewAuditService(q)}, &routes.SSHKeyHandler{Service: services.NewSSHKeyService(q)}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: services.NewMythicalService(pool, nil)}, Members: &routes.MembersHandler{Service: members}, Live: liveHandler})
	noAuthorizationRequest := httptest.NewRequest("GET", origin+"/api/auth/github/cli?callback_port=43210", nil)
	noAuthorizationRequest.RemoteAddr = "127.0.0.1:43211"
	noAuthorizationResponse := httptest.NewRecorder()
	withoutAuthorization.ServeHTTP(noAuthorizationResponse, noAuthorizationRequest)
	require.Equal(t, 503, noAuthorizationResponse.Code, noAuthorizationResponse.Body.String())
	require.Empty(t, noAuthorizationResponse.Result().Cookies())
	// Missing membership provider refuses before a new OAuth state or cookie.
	svc.Members = nil
	res, err := client.Get(origin + "/api/auth/github/cli?callback_port=43210")
	require.NoError(t, err)
	data, _ = io.ReadAll(res.Body)
	res.Body.Close()
	require.Equal(t, 503, res.StatusCode, string(data))
	require.Contains(t, string(data), "credential_issuer_unavailable")
	require.Empty(t, res.Cookies())
	status, body = call("POST", "/api/user/tokens", `{"name":"refused","scopes":["repo"]}`, raw)
	require.Equal(t, 503, status, body)
}
