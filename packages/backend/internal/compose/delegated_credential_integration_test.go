package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
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
	cfg.Auth.WorkerExchangeToken = "fixture-worker-secret"
	cfg.Auth.SessionCookieName = "session"
	bus := revocation.NewBus(pool, q)
	busContext, stopBus := context.WithCancel(ctx)
	defer stopBus()
	require.NoError(t, bus.Start(busContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	svc := services.NewAuthService(q, cfg.Auth, nil, auth.NewGitHubClient(ownerOAuthCredentials{"client", "secret"}, "", provider.URL, provider.URL), services.WithAuthRevocationPublisher(revocation.NewDBPublisher(q, bus)))
	svc.InstallSetup = &services.InstallSetupSessions{Pool: pool}
	svc.Members = members
	handler := &routes.AuthHandler{Service: svc, AuthConfig: cfg.Auth, InstallSetup: svc.InstallSetup}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{queries: q, members: members}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	stackService := services.NewMythicalService(pool, nil)
	jobStore, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: jobStore, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, fmt.Errorf("this fixture tests durable admission, not guest execution")
	})})
	require.NoError(t, err)
	stackService.SetLauncher(dispatcher)
	topics.todos, topics.jobs = stackService, jobStore
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, handler, &routes.UserHandler{ProfileService: services.NewUserService(q), TokenService: svc, AuditService: services.NewAuditService(q)}, &routes.SSHKeyHandler{Service: services.NewSSHKeyService(q)}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: stackService}, Members: &routes.MembersHandler{Service: members}, Live: liveHandler})
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
		requestKey := sha256.Sum256([]byte(method + path + body))
		req.Header.Set("Idempotency-Key", hex.EncodeToString(requestKey[:]))
		res, err := client.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		return res.StatusCode, string(data)
	}
	t.Run("CLI-login-live-subscribe-and-token-revoke", func(t *testing.T) {
		dial := func(credential string, headers http.Header) (*websocket.Conn, *http.Response, error) {
			if headers == nil {
				headers = http.Header{}
			}
			headers.Set("Authorization", "Bearer "+credential)
			return websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
		}
		socket, response, err := dial(raw, nil) // Actual CLI OAuth login, no Cookie or Origin.
		require.NoError(t, err)
		require.Equal(t, 101, response.StatusCode)
		defer socket.CloseNow()
		require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1"}`)))
		readContext, stopRead := context.WithTimeout(ctx, 5*time.Second)
		defer stopRead()
		_, frame, err := socket.Read(readContext)
		require.NoError(t, err)
		require.Contains(t, string(frame), `"t":"snap"`)
		require.Contains(t, string(frame), `"n":1`)
		require.Contains(t, string(frame), `"state":"failed"`)
		require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":2,"topic":"confirmations:%d"}`, owner.ID))))
		_, frame, err = socket.Read(readContext)
		require.NoError(t, err)
		require.JSONEq(t, `{"t":"err","id":2,"code":"forbidden"}`, string(frame))
		mixed, refusal, err := dial(raw, http.Header{"Cookie": {"unrelated=1"}, "Origin": {"http://elsewhere.test"}})
		require.Error(t, err)
		require.Nil(t, mixed)
		require.Equal(t, 403, refusal.StatusCode)
		refusal.Body.Close()
		status, body := call("POST", "/api/user/tokens", `{"name":"live-revocation","scopes":["repo","user"]}`, raw)
		require.Equal(t, 201, status, body)
		var credential services.CreateTokenResult
		require.NoError(t, json.Unmarshal([]byte(body), &credential))
		revoked, _, err := dial(credential.Token, nil)
		require.NoError(t, err)
		defer revoked.CloseNow()
		start := time.Now()
		browserKey := "live-revocation-browser"
		browserHash := sha256.Sum256([]byte(browserKey))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(browserHash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		revokeRequest, err := http.NewRequest("DELETE", fmt.Sprintf("%s/api/user/tokens/%d", origin, credential.ID), nil)
		require.NoError(t, err)
		revokeRequest.Header.Set("Origin", origin)
		revokeRequest.Header.Set("X-CSRF-Token", "csrf")
		revokeRequest.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: browserKey})
		revokeRequest.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		revokeResponse, err := client.Do(revokeRequest)
		require.NoError(t, err)
		require.Equal(t, 204, revokeResponse.StatusCode)
		revokeResponse.Body.Close()
		deadline, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, _, err = revoked.Read(deadline)
		require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
		require.Less(t, time.Since(start), 5*time.Second)
		dead, refusal, err := dial(credential.Token, nil)
		require.Error(t, err)
		require.Nil(t, dead)
		require.Equal(t, 401, refusal.StatusCode)
		refusal.Body.Close()
	})
	status, body := call("POST", "/api/auth/github/token-exchange", `{"github_access_token":"fixture-github-token","token_name":"laptop-exchange"}`, "fixture-worker-secret")
	require.Equal(t, 200, status, body)
	var exchanged struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &exchanged))
	exchangeDigest := sha256.Sum256([]byte(exchanged.Token))
	exchangeRow, err := q.GetAuthInfoByTokenHash(ctx, hex.EncodeToString(exchangeDigest[:]))
	require.NoError(t, err)
	require.True(t, exchangeRow.TokenSystemIssued)
	require.Contains(t, exchangeRow.TokenScopes, "via:cli")
	require.NotContains(t, exchangeRow.TokenScopes, "approval")
	var exchangeExpiry time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at FROM access_tokens WHERE id=$1`, exchangeRow.TokenID).Scan(&exchangeExpiry))
	require.WithinDuration(t, time.Now().Add(30*24*time.Hour), exchangeExpiry, 10*time.Second)
	status, body = call("GET", "/api/user", "", raw)
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"via":"claude-code"`)
	status, body = call("POST", "/api/todos/1/merge", `{"reviewed_head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, raw)
	require.Equal(t, 503, status, body)
	require.Contains(t, body, `"code":"confirmation_unavailable"`)
	status, body = call("POST", "/api/members", `{"github_login":"writer"}`, raw)
	require.Equal(t, 403, status, body)
	require.Contains(t, body, `"code":"never"`)
	status, body = call("POST", "/api/todos/1", `{"op":"retry","steer":"Keep the retry guard"}`, raw)
	require.Equal(t, 202, status, body)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "member", LowerUsername: "member", DisplayName: "Member"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'write',102,'member')`, repo.ID, member.ID)
	require.NoError(t, err)
	memberCredential, err := svc.CreateToken(ctx, member.ID, services.CreateTokenRequest{Name: "member-cli", Scopes: []string{"repo", "user"}})
	require.NoError(t, err)
	var stateBeforeDrop string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE id=$1`, item.ID).Scan(&stateBeforeDrop))
	status, body = call("POST", "/api/todos/1", `{"op":"drop"}`, memberCredential.Token)
	require.Equal(t, 202, status, body)
	var confirmation map[string]string
	require.NoError(t, json.Unmarshal([]byte(body), &confirmation))
	require.Len(t, confirmation, 2, "the delegated receipt must contain no private card payload")
	require.NotEmpty(t, confirmation["confirmation"])
	require.Equal(t, "pending", confirmation["state"])
	status, body = call("POST", "/api/todos/1", `{"op":"drop"}`, memberCredential.Token)
	require.Equal(t, 202, status, body)
	require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"pending"}`, confirmation["confirmation"]), body)
	status, body = call("GET", "/api/confirmations", "", memberCredential.Token)
	require.Equal(t, 200, status, body)
	require.JSONEq(t, fmt.Sprintf(`[{"id":%q,"state":"pending"}]`, confirmation["confirmation"]), body)
	status, body = call("GET", "/api/confirmations", "", raw)
	require.Equal(t, 200, status, body)
	require.JSONEq(t, `[]`, body, "another member cannot read the requester's confirmation")
	status, body = call("POST", "/api/confirmations/"+confirmation["confirmation"]+"/approve", `{}`, memberCredential.Token)
	require.Equal(t, 403, status, body)
	var stateAfterDrop string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE id=$1`, item.ID).Scan(&stateAfterDrop))
	require.Equal(t, stateBeforeDrop, stateAfterDrop, "requesting or replaying Drop must not drop the TODO")
	var actor []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'actor' FROM product_job_requests WHERE operation='todo.retried' ORDER BY created_at DESC LIMIT 1`).Scan(&actor))
	require.Contains(t, string(actor), `"agent": "claude-code"`)
	require.Contains(t, string(actor), `"login": "owner"`)
	// Full-scope laptop delegation reaches the real Move and Answer services,
	// while terminal_s1 remains confined by the same command/branch gates.
	neighbor, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "queued", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=2,owner_id=$2,title='Neighbor',stack_position=2,attempt=1,revisions='[]' WHERE id=$1`, neighbor.ID, owner.ID)
	require.NoError(t, err)
	status, body = call("POST", "/api/todos/2", `{"op":"move","direction":"up"}`, raw)
	require.Equal(t, 202, status, body)
	var movedPlace int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT stack_position FROM mythical_items WHERE id=$1`, neighbor.ID).Scan(&movedPlace))
	require.EqualValues(t, 1, movedPlace)
	// Same credential/key/payload replays the move without swapping again.
	status, body = call("POST", "/api/todos/2", `{"op":"move","direction":"up"}`, raw)
	require.Equal(t, 202, status, body)
	require.NoError(t, pool.QueryRow(ctx, `SELECT stack_position FROM mythical_items WHERE id=$1`, neighbor.ID).Scan(&movedPlace))
	require.EqualValues(t, 1, movedPlace)
	waitChecks, err := json.Marshal(map[string]any{"todo": true, "waits": []services.TodoWait{{ID: "laptop-question", Kind: "question", Prompt: "Which helper?", Since: time.Now().UTC(), Signal: &services.TodoWaitSignal{Scope: jobs.Scope{TenantID: "repository:fixture", PrincipalID: "todo:fixture"}, Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "fixture"}, Flow: "todo", Run: "laptop-run", Name: "clarification"}}}})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running',checks=$2 WHERE id=$1`, neighbor.ID, waitChecks)
	require.NoError(t, err)
	status, body = call("POST", "/api/todos/2/answer", `{"wait":"laptop-question","answer":"Use the retry helper"}`, raw)
	require.Equal(t, 202, status, body)
	var answeredVia string
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'waits'->0->'by'->>'agent' FROM mythical_items WHERE id=$1`, neighbor.ID).Scan(&answeredVia))
	require.Equal(t, "claude-code", answeredVia)
	var admittedSignals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&admittedSignals))
	require.Equal(t, 1, admittedSignals)
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
	for _, binding := range []string{"CREDENTIAL:sync", "WORKSPACE:branch-1", "LANDING-WORKSPACE:branch-1"} {
		_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, row.TokenID, "repo,user,"+binding)
		require.NoError(t, err)
		status, body = call("GET", "/api/user", "", legacyRaw)
		require.Equal(t, 401, status, body)
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, row.TokenID, row.TokenScopes)
	require.NoError(t, err)
	turnID := liveAppTurnCredentialFixture(t, pool, owner.ID)
	turn, err := svc.MintForTurn(ctx, owner.ID, turnID, 1)
	require.NoError(t, err)
	require.Equal(t, "smithers", turn.Via)
	require.WithinDuration(t, time.Now().Add(time.Hour), *turn.ExpiresAt, 10*time.Second)
	status, body = call("GET", "/api/user", "", turn.Token)
	require.Equal(t, 200, status, body)

	t.Run("turn-credential-scope-separators", func(t *testing.T) {
		digest := sha256.Sum256([]byte(turn.Token))
		held := middleware.Credential{TokenHash: hex.EncodeToString(digest[:])}
		for _, separator := range []string{",", " ", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000"} {
			scopes := strings.Join(turn.Scopes, separator)
			_, err := pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, turn.ID, scopes)
			require.NoError(t, err)
			info, err := middleware.ReloadCredential(ctx, q, held, time.Now())
			require.NoError(t, err, "%q", separator)
			require.Equal(t, "smithers", info.ActingVia())
			// The same separators must not hide an unbound app-agent grant.
			_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, turn.ID, "repo"+separator+"via:smithers")
			require.NoError(t, err)
			_, err = middleware.ReloadCredential(ctx, q, held, time.Now())
			require.ErrorIs(t, err, middleware.ErrCredentialGone, "%q", separator)
		}
		_, err := pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, turn.ID, strings.Join(turn.Scopes, ","))
		require.NoError(t, err)
	})

	// The public API and background credential reload both fence every kind
	// of lost producer authority, without needing the old host's cleanup.
	for _, test := range []struct{ name, update string }{
		{"queued", "state='queued'"}, {"accepted", "state='accepted'"},
		{"completed", "state='completed'"}, {"failed", "state='failed'"},
		{"cancelled", "state='cancelled'"}, {"uncertain", "state='uncertain'"},
		{"retired", "state='retired'"}, {"terminal", "terminal=true"},
		{"cancellation-requested", "cancel_requested_at=NOW()"},
		{"lease-expired", "producer_lease_expires_at=NOW()-interval '1 second'"},
		{"lease-missing", "producer_lease_expires_at=NULL"},
		{"producer-missing", "producer_token_hash=NULL"},
		{"replacement", "producer_generation=2"}, {"foreign-author", "user_id=0"},
	} {
		t.Run("turn-credential-"+test.name, func(t *testing.T) {
			id := liveAppTurnCredentialFixture(t, pool, owner.ID)
			credential, err := svc.MintForTurn(ctx, owner.ID, id, 1)
			require.NoError(t, err)
			status, body := call("GET", "/api/user", "", credential.Token)
			require.Equal(t, 200, status, body)
			digest := sha256.Sum256([]byte(credential.Token))
			held := middleware.Credential{TokenHash: hex.EncodeToString(digest[:])}
			_, err = middleware.ReloadCredential(ctx, q, held, time.Now())
			require.NoError(t, err)
			_, err = pool.Exec(ctx, "UPDATE chat_turns SET "+test.update+" WHERE id=$1", id)
			require.NoError(t, err)
			status, body = call("GET", "/api/user", "", credential.Token)
			require.Equal(t, 401, status, body)
			_, err = middleware.ReloadCredential(ctx, q, held, time.Now())
			require.ErrorIs(t, err, middleware.ErrCredentialGone)
			var before, after int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&before))
			_, err = svc.MintForTurn(ctx, owner.ID, id, 1)
			require.Error(t, err)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&after))
			require.Equal(t, before, after, "refused issuance must not create a token")
			if test.name == "replacement" {
				replacement, err := svc.MintForTurn(ctx, owner.ID, id, 2)
				require.NoError(t, err)
				status, body = call("GET", "/api/user", "", replacement.Token)
				require.Equal(t, 200, status, body)
				status, body = call("GET", "/api/user", "", credential.Token)
				require.Equal(t, 401, status, body)
			}
		})
	}
	t.Run("turn-credential-unclaimed", func(t *testing.T) {
		var before, after int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&before))
		for _, generation := range []int64{-1, 0, 1} {
			_, err := svc.MintForTurn(ctx, owner.ID, "unclaimed", generation)
			require.Error(t, err)
		}
		_, err := svc.MintForTurn(ctx, owner.ID, "", 1)
		require.Error(t, err)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&after))
		require.Equal(t, before, after)
	})
	t.Run("turn-credential-binding-required", func(t *testing.T) {
		for _, scopes := range []string{"repo,user,via:smithers", " repo, user , VIA:SMITHERS ", "repo user via:smithers", "repo\tuser\nvia:smithers", "repo\u00a0user\u2003via:smithers", "repo,user,via:smithers,terminal-session:missing/1"} {
			_, err := pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, turn.ID, scopes)
			require.NoError(t, err)
			status, body := call("GET", "/api/user", "", turn.Token)
			require.Equal(t, 401, status, body)
		}
	})
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
	terminalDigest := sha256.Sum256([]byte(terminal.Token))
	heldTerminal := middleware.Credential{TokenHash: hex.EncodeToString(terminalDigest[:])}
	for _, state := range []string{"pending", "starting", "running", "failed", "stopped"} {
		t.Run("terminal-subject-"+state, func(t *testing.T) {
			_, err := q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: terminalSession.ID, Status: state})
			require.NoError(t, err)
			status, body := call("GET", "/api/user", "", terminal.Token)
			_, err = middleware.ReloadCredential(ctx, q, heldTerminal, time.Now())
			if state == "failed" || state == "stopped" {
				require.Equal(t, 401, status, body)
				require.ErrorIs(t, err, middleware.ErrCredentialGone)
			} else {
				require.Equal(t, 200, status, body)
				require.NoError(t, err)
			}
		})
	}
	_, err = q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: terminalSession.ID, Status: "running"})
	require.NoError(t, err)
	for _, separator := range []string{",", " ", "\t", "\n", "\u00a0", "\u2003"} {
		_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, terminal.ID, strings.Join(terminal.Scopes, separator))
		require.NoError(t, err)
		status, body = call("GET", "/api/user", "", terminal.Token)
		require.Equal(t, 200, status, body)
		_, err = middleware.ReloadCredential(ctx, q, heldTerminal, time.Now())
		require.NoError(t, err)
	}
	for _, binding := range []struct{ name, from, to string }{
		{"session", "terminal-session:" + terminalSession.ID, "terminal-session:missing"},
		{"branch", "branch:" + workspace.ID, "branch:missing"},
		{"repository", fmt.Sprintf("repo:%d", repo.ID), "repo:999999"},
	} {
		t.Run("terminal-wrong-"+binding.name, func(t *testing.T) {
			scopes := strings.Replace(strings.Join(terminal.Scopes, ","), binding.from, binding.to, 1)
			_, err := pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, terminal.ID, scopes)
			require.NoError(t, err)
			status, body := call("GET", "/api/user", "", terminal.Token)
			require.Equal(t, 401, status, body)
			_, err = middleware.ReloadCredential(ctx, q, heldTerminal, time.Now())
			require.ErrorIs(t, err, middleware.ErrCredentialGone)
		})
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, terminal.ID, strings.Join(terminal.Scopes, ","))
	require.NoError(t, err)
	for _, mutation := range []struct{ name, change, restore string }{
		{"member", fmt.Sprintf("user_id=%d", member.ID), fmt.Sprintf("user_id=%d", owner.ID)},
		{"kind", "kind='lsp',language='go'", "kind='terminal',language=''"},
	} {
		t.Run("terminal-foreign-"+mutation.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, "UPDATE workspace_sessions SET "+mutation.change+" WHERE id=$1", terminalSession.ID)
			require.NoError(t, err)
			status, body := call("GET", "/api/user", "", terminal.Token)
			require.Equal(t, 401, status, body)
			_, err = middleware.ReloadCredential(ctx, q, heldTerminal, time.Now())
			require.ErrorIs(t, err, middleware.ErrCredentialGone)
			_, err = pool.Exec(ctx, "UPDATE workspace_sessions SET "+mutation.restore+" WHERE id=$1", terminalSession.ID)
			require.NoError(t, err)
		})
	}
	_, err = q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{ID: terminalSession.ID, Status: "stopped"})
	require.NoError(t, err)
	_, err = svc.MintForTerminal(ctx, owner.ID, repo.ID, workspace.ID, terminalSession.ID)
	require.Error(t, err)
	// Closing the subject fences its bearer even if host cleanup did not run.
	status, body = call("GET", "/api/user", "", terminal.Token)
	require.Equal(t, 401, status, body)
	_, err = middleware.ReloadCredential(ctx, q, heldTerminal, time.Now())
	require.ErrorIs(t, err, middleware.ErrCredentialGone)
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
	_, err = svc.MintForTurn(ctx, owner.ID, "dead-turn", 1)
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
	cliCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
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
	plainHome := t.TempDir()
	plainCommand := exec.CommandContext(cliCtx, node, filepath.Join(root, "packages/smithers/bin/smithers.mjs"), "login", origin, "--format", "json")
	plainCommand.Dir = root
	for _, entry := range command.Env {
		if !strings.HasPrefix(entry, "CLAUDECODE=") && !strings.HasPrefix(entry, "CODEX_") {
			plainCommand.Env = append(plainCommand.Env, entry)
		}
	}
	plainCommand.Env = append(plainCommand.Env, "HOME="+plainHome, "XDG_CONFIG_HOME="+plainHome, "XDG_DATA_HOME="+plainHome, "SMITHERS_AUTH_FILE="+filepath.Join(plainHome, "auth.json"))
	plainOutput, err := plainCommand.CombinedOutput()
	require.NoError(t, err, string(plainOutput))
	plainSaved, err := os.ReadFile(filepath.Join(plainHome, "auth.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(plainSaved, &credential))
	require.Equal(t, "delegated", credential.Kind)
	require.Equal(t, "cli", credential.Via)
	require.NotContains(t, string(plainOutput), credential.Token)
	status, body = call("GET", "/api/user", "", credential.Token)
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"via":"cli"`)
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

// These policy fixtures need an authenticated app agent. The production
// authentication query requires a live database-backed producer subject even
// when the test is about a different API's permission decision.
func liveAppTurnCredentialFixture(t *testing.T, pool *pgxpool.Pool, userID int64) string {
	t.Helper()
	id := uuid.NewString()
	_, err := pool.Exec(t.Context(), `INSERT INTO chat_turns
 (id,user_id,run_id,leg_id,request_hash,access_hash,state,producer_generation,producer_token_hash,producer_lease_expires_at)
 VALUES($1,$2,$1,'fixture','fixture','fixture','running',1,'fixture',NOW()+interval '1 hour')`, id, userID)
	require.NoError(t, err)
	return id
}
