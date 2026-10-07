package compose

import (
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Repository secrets writes through the composed install router, real
// PostgreSQL and the roster's GitHub fake (spec §5.2 row "Members, roles,
// secrets write"; §5.2.1): the owner's and a maintainer's browser sessions
// add, replace and delete secrets; a member's session is refused with
// permission; an otherwise-eligible delegated credential is refused with
// never; a run credential, a delegated member and an outsider keep their
// refusals; a removed or suspended member's session is dead (401). No
// refusal writes a row.
func TestSecretsWriteComposedInstallPostgres(t *testing.T) { testSecretsComposed(t, false) }
func TestSecretsInstallAPIAndLivePostgres(t *testing.T)    { testSecretsComposed(t, true) }
func testSecretsComposed(t *testing.T, install bool) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
		require.NoError(t, err)
		return created
	}
	owner, maintainer, writer, outsider := user("owner"), user("maintainer"), user("writer"), user("outsider")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-04T22:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
		githubID   int64
	}{{owner, "admin", 101}, {writer, "write", 102}, {maintainer, "admin", 103}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,$3,$4,$5)`,
			repo.ID, row.user.ID, row.permission, row.githubID, row.user.Username)
		require.NoError(t, err)
	}
	github := &rosterGitHub{roles: map[string]string{"owner": "admin", "writer": "write", "maintainer": "maintain"}}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = strings.Replace(r.URL.Path, "/repos/owner/app/", "/repos/acme/app/", 1)
		github.serve(w, r)
	}))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	secretService := services.NewSecretService(q, nil, services.WithSecretInstallAuthorization(true, pool))
	secrets := &routes.SecretHandler{Service: secretService, AgentEnvironment: services.NewAgentEnvironmentService(q, nil)}
	topics := &liveTopics{queries: q, secrets: secretService}
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, secrets, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}, Live: liveHandler})

	server.Start()
	defer server.Close()

	// Direct service calls must obtain the same decision before writes,
	// even when router middleware is absent.
	service := services.NewSecretService(q, nil, services.WithSecretInstallAuthorization(true, pool))
	for _, who := range []db.User{owner, maintainer, writer} {
		directHash := sha256.Sum256([]byte("direct-" + who.Username))
		directKey := hex.EncodeToString(directHash[:])
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: who.ID, Username: who.Username, SessionKey: directKey, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		directCtx := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &who, SessionHash: directKey})
		_, directErr := service.SetSecret(directCtx, &who, "owner", "app", "DIRECT_KEY", "value", nil, nil)
		if who.ID == writer.ID {
			var access *services.AccessError
			require.ErrorAs(t, directErr, &access)
			require.Equal(t, "permission", access.Code)
		} else {
			require.NoError(t, directErr)
			require.NoError(t, service.DeleteSecret(directCtx, &who, "owner", "app", "DIRECT_KEY"))
		}
	}
	delegatedCtx := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository,via:cli", Scopes: middleware.ScopeSet{middleware.ScopeWriteRepository: {}}})
	_, directErr := service.SetSecret(delegatedCtx, &owner, "owner", "app", "DENIED_KEY", "value", nil, nil)
	var access *services.AccessError
	require.ErrorAs(t, directErr, &access)
	require.Equal(t, "never", access.Code)
	// An allowed command is still confined to the persisted install repo.
	otherRepo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
	require.NoError(t, err)
	ownerHash := sha256.Sum256([]byte("direct-" + owner.Username))
	ownerCtx := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: hex.EncodeToString(ownerHash[:])})
	_, directErr = service.SetSecret(ownerCtx, &owner, "owner", "other", "CROSS_KEY", "value", nil, nil)
	require.ErrorAs(t, directErr, &access)
	require.Equal(t, "permission", access.Code)
	var otherSecrets int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_secrets WHERE repository_id=$1`, otherRepo.ID).Scan(&otherSecrets))
	require.Zero(t, otherSecrets)
	// A downgrade preserves the bound command decision, but logout does not.
	maintHash := sha256.Sum256([]byte("direct-" + maintainer.Username))
	maintKey := hex.EncodeToString(maintHash[:])
	maintCtx := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &maintainer, SessionHash: maintKey})
	boundDecision, err := services.Authorize(maintCtx, q, "secrets.write")
	require.NoError(t, err)
	boundCtx := services.WithInstallAuthorization(maintCtx, "secrets.write", boundDecision)
	require.NoError(t, members.ChangeRole(ownerCtx, maintainer.Username, "member"))
	_, err = service.SetSecret(boundCtx, &maintainer, "owner", "app", "BOUND_DOWNGRADE", "value", nil, nil)
	require.NoError(t, err)
	require.NoError(t, service.DeleteSecret(boundCtx, &maintainer, "owner", "app", "BOUND_DOWNGRADE"))
	_, err = service.SetSecret(maintCtx, &maintainer, "owner", "app", "FRESH_DENIED", "value", nil, nil)
	require.ErrorAs(t, err, &access)
	require.Equal(t, "permission", access.Code)
	require.NoError(t, members.ChangeRole(ownerCtx, maintainer.Username, "maintainer"))
	boundDecision, err = services.Authorize(maintCtx, q, "secrets.write")
	require.NoError(t, err)
	boundCtx = services.WithInstallAuthorization(maintCtx, "secrets.write", boundDecision)
	_, err = pool.Exec(ctx, `DELETE FROM auth_sessions WHERE session_key=$1`, maintKey)
	require.NoError(t, err)
	_, err = service.SetSecret(boundCtx, &maintainer, "owner", "app", "LOGOUT_SECRET", "value", nil, nil)
	require.ErrorAs(t, err, &access)
	require.Equal(t, 401, access.Status)
	require.Equal(t, "unauthenticated", access.Code)
	session := func(u db.User) string {
		key := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	minted := map[string]string{}
	token := func(u db.User, name, scopes string, systemIssued bool) string {
		key := u.Username + "-" + name
		if raw, ok := minted[key]; ok {
			return raw
		}
		seed := sha256.Sum256([]byte(u.Username + "-" + name))
		raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
		hash := sha256.Sum256([]byte(raw))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: name, TokenHash: hex.EncodeToString(hash[:]),
			TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, SystemIssued: systemIssued})
		require.NoError(t, err)
		minted[key] = raw
		return raw
	}
	type credential struct{ cookie, bearer string }
	ownerSession, maintainerSession, writerSession, outsiderSession := credential{cookie: session(owner)}, credential{cookie: session(maintainer)}, credential{cookie: session(writer)}, credential{cookie: session(outsider)}
	delegated := func(u db.User) credential {
		return credential{bearer: token(u, fmt.Sprintf("cli-%d", time.Now().UnixNano()), "write:repository,via:cli", true)}
	}
	run := credential{bearer: token(maintainer, "run", "write:repository", true)}
	ownerPAT := credential{bearer: token(owner, "pat", "all", false)}

	call := func(c credential, method, path, body string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		if c.cookie != "" {
			req.Header.Set("X-CSRF-Token", "csrf-fixture")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
			req.AddCookie(&http.Cookie{Name: "session", Value: c.cookie})
		}
		if c.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+c.bearer)
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.NotContains(t, string(raw), "machine-env-canary-value")
		require.NotContains(t, string(raw), "main-only-canary-value")
		envelope := map[string]any{}
		if len(raw) > 0 {
			if strings.HasPrefix(strings.TrimSpace(string(raw)), "[") {
				var entries []map[string]any
				require.NoError(t, json.Unmarshal(raw, &entries), string(raw))
				envelope["entries"] = entries
			} else {
				require.NoError(t, json.Unmarshal(raw, &envelope), string(raw))
			}
		}
		return res.StatusCode, envelope
	}
	request := func(c credential, method, path, body string) (int, map[string]any) {
		t.Helper()
		if install && strings.HasPrefix(path, "/secrets") {
			if method == "POST" {
				method = "PUT"
			}
			if method == "DELETE" {
				body = fmt.Sprintf(`{"name":%q}`, strings.TrimPrefix(path, "/secrets/"))
				path = "/secrets"
			}
			return call(c, method, "/api"+path, body)
		}
		return call(c, method, "/api/repos/owner/app"+path, body)
	}
	stored := func() []string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT name FROM repository_secrets WHERE repository_id=$1 ORDER BY name`, repo.ID)
		require.NoError(t, err)
		names, err := pgx.CollectRows(rows, pgx.RowTo[string])
		require.NoError(t, err)
		return names
	}

	// HTTP writes feed the same branch delivery snapshot used by provisioning.
	// Rotation, main-only scope and deletion must remove stale values and names.
	const canary = "http-canary-0123456789abcdef0123456789"
	const replacement = "http-replacement-0123456789abcdef0123"
	injector := services.NewSecretInjector(q, nil)
	assertSnapshot := func(want map[string]string) {
		t.Helper()
		snapshot, err := injector.RepositorySecrets(ctx, repo.ID, false)
		require.NoError(t, err)
		require.Equal(t, want, snapshot.Secrets)
		require.Equal(t, want, snapshot.Env)
		require.Empty(t, snapshot.Bound)
	}
	for _, value := range []string{canary, replacement} {
		status, body := request(ownerSession, "POST", "/secrets", fmt.Sprintf(`{"name":"CANARY_TOKEN","value":%q}`, value))
		require.Equal(t, 201, status, body)
		encoded, err := json.Marshal(body)
		require.NoError(t, err)
		require.NotContains(t, string(encoded), value)
		assertSnapshot(map[string]string{"CANARY_TOKEN": value})
	}
	statusScope, scopeBody := request(ownerSession, "PATCH", "/secrets/CANARY_TOKEN", `{"main_only":true}`)
	require.Equal(t, 200, statusScope, scopeBody)
	assertSnapshot(map[string]string{})
	statusDelete, deleteBody := request(ownerSession, "DELETE", "/secrets/CANARY_TOKEN", "")
	require.Equal(t, 204, statusDelete, deleteBody)
	assertSnapshot(map[string]string{})

	// The owner's and a maintainer's sessions add, replace and delete.
	for _, tc := range []struct {
		who  credential
		name string
	}{{ownerSession, "OWNER_KEY"}, {maintainerSession, "MAINTAINER_KEY"}} {
		before := len(stored())
		status, body := request(tc.who, "POST", "/secrets", `{"name":"`+tc.name+`","value":"v1"}`)
		require.Equal(t, 201, status, body)
		require.Equal(t, tc.name, body["name"])
		require.Len(t, stored(), before+1, "one row")
		status, body = request(tc.who, "POST", "/secrets", `{"name":"`+tc.name+`","value":"v2"}`)
		require.Equal(t, 201, status, body)
		require.Len(t, stored(), before+1, "a replace writes no second row")
		status, body = request(tc.who, "PATCH", "/secrets/"+tc.name, `{"main_only":true}`)
		require.Equal(t, 200, status, body)
		require.Equal(t, true, body["main_only"], body)
	}
	if install {
		for _, who := range []credential{ownerSession, maintainerSession, writerSession} {
			req, err := http.NewRequest("GET", origin+"/api/secrets", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "session", Value: who.cookie})
			res, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			raw, err := io.ReadAll(res.Body)
			res.Body.Close()
			require.NoError(t, err)
			require.Equal(t, 200, res.StatusCode, string(raw))
			require.Contains(t, string(raw), "OWNER_KEY")
			require.NotContains(t, string(raw), "v2")
			require.NotContains(t, string(raw), `"value"`)
		}
		for _, who := range []credential{delegated(owner), run, ownerPAT} {
			status, _ := call(who, "GET", "/api/secrets", "")
			require.Equal(t, 403, status)
		}
		header := http.Header{}
		header.Set("Origin", origin)
		header.Set("Cookie", "session="+writerSession.cookie)
		socket, _, err := websocket.Dial(ctx, strings.Replace(origin, "http:", "ws:", 1)+"/api/live", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{"smithers.live.v1"}})
		require.NoError(t, err)
		defer socket.CloseNow()
		require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"secrets"}`)))
		_, raw, err := socket.Read(ctx)
		require.NoError(t, err)
		require.Contains(t, string(raw), `"scope":"main_only"`)
		require.Contains(t, string(raw), "OWNER_KEY")
		require.NotContains(t, string(raw), `"value"`)
	}
	require.Equal(t, []string{"MAINTAINER_KEY", "OWNER_KEY"}, stored())
	status, body := request(maintainerSession, "DELETE", "/secrets/MAINTAINER_KEY", "")
	require.Equal(t, 204, status, body)
	require.Equal(t, []string{"OWNER_KEY"}, stored())
	status, body = request(ownerSession, "POST", "/secrets", `{"name":"SPARE","value":"v"}`)
	require.Equal(t, 201, status, body)
	status, body = request(ownerSession, "DELETE", "/secrets/SPARE", "")
	require.Equal(t, 204, status, body)
	require.Equal(t, []string{"OWNER_KEY"}, stored())

	// All active member sessions read metadata, including main-only names.
	status, body = request(ownerSession, "POST", "/secrets", `{"name":"CANARY_TOKEN","value":"machine-env-canary-value"}`)
	require.Equal(t, 201, status, body)
	status, body = request(ownerSession, "POST", "/secrets", `{"name":"DEPLOY_KEY","value":"main-only-canary-value","main_only":true}`)
	require.Equal(t, 201, status, body)
	for _, who := range []credential{ownerSession, maintainerSession, writerSession} {
		status, body = request(who, "GET", "/secrets", "")
		require.Equal(t, 200, status, body)
		entries := body["entries"].([]map[string]any)
		require.Len(t, entries, 3)
		names := map[string]bool{}
		for _, entry := range entries {
			require.NotContains(t, entry, "value")
			names[entry["name"].(string)] = entry["main_only"].(bool)
		}
		require.Equal(t, map[string]bool{"CANARY_TOKEN": false, "DEPLOY_KEY": true, "OWNER_KEY": true}, names)
		status, body = request(who, "GET", "/agent-environment", "")
		require.Equal(t, 200, status, body)
	}
	for _, who := range []credential{ownerSession, maintainerSession} {
		status, body = request(who, "PUT", "/agent-environment", `{ "setup_script":"echo fixture", "env":[] }`)
		require.Equal(t, 200, status, body)
		status, body = request(who, "PUT", "/agent-environment/secrets/SETUP_TOKEN", `{"value":"machine-env-canary-value"}`)
		require.Equal(t, 201, status, body)
		require.NotContains(t, body, "value")
		for _, reader := range []credential{ownerSession, maintainerSession, writerSession} {
			status, body = request(reader, "GET", "/agent-environment", "")
			require.Equal(t, 200, status, body)
			require.Contains(t, body, "secrets")
		}
		status, body = request(who, "DELETE", "/agent-environment/secrets/SETUP_TOKEN", "")
		require.Equal(t, 204, status, body)
	}
	for _, who := range []credential{delegated(owner), delegated(maintainer), delegated(writer), run, ownerPAT} {
		for _, path := range []string{"/secrets", "/agent-environment"} {
			status, body = request(who, "GET", path, "")
			require.Equal(t, 403, status, body)
		}
	}
	for _, name := range []string{"CANARY_TOKEN", "DEPLOY_KEY"} {
		status, body = request(ownerSession, "DELETE", "/secrets/"+name, "")
		require.Equal(t, 204, status, body)
	}

	permission := map[string]any{"class": "permission", "code": "permission", "message": "Only a maintainer can do this"}
	never := map[string]any{"class": "never", "code": "never", "message": "Only a person can do this"}
	for _, tc := range []struct {
		name     string
		who      credential
		status   int
		envelope map[string]any
		code     string
	}{
		{"a member's session", writerSession, 403, permission, ""},
		{"the owner's delegated credential", delegated(owner), 403, never, ""},
		{"a maintainer's delegated credential", delegated(maintainer), 403, never, ""},
		{"the owner's personal access token", ownerPAT, 403, never, ""},
		{"a read-only owner delegation", credential{bearer: token(owner, "readonly-cli", "read:repository,via:cli", true)}, 403, map[string]any{"class": "permission", "code": "permission", "message": "Insufficient credential scope"}, ""},
		{"a member's delegated credential", delegated(writer), 403, permission, ""},
		{"a maintainer's run credential", run, 403, nil, "permission"},
		{"an outsider's session", outsiderSession, 403, nil, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, call := range []struct{ method, path, body string }{
				{"POST", "/secrets", `{"name":"REFUSED","value":"v"}`},
				{"POST", "/secrets", `{"name":"OWNER_KEY","value":"overwritten"}`},
				{"PATCH", "/secrets/OWNER_KEY", `{"main_only":false}`},
				{"DELETE", "/secrets/OWNER_KEY", ""},
				{"PUT", "/agent-environment", `{"setup_script":"echo refused", "env":[]}`},
				{"PUT", "/agent-environment/secrets/REFUSED", `{"value":"machine-env-canary-value"}`},
				{"DELETE", "/agent-environment/secrets/REFUSED", ""},
			} {
				status, body := request(tc.who, call.method, call.path, call.body)
				require.Equal(t, tc.status, status, "%s %s: %v", call.method, call.path, body)
				if tc.envelope != nil {
					require.Equal(t, tc.envelope, body, "%s %s", call.method, call.path)
				} else {
					require.Equal(t, tc.code, body["code"], "%s %s: %v", call.method, call.path, body)
				}
				require.Equal(t, []string{"OWNER_KEY"}, stored(), "a refusal writes nothing")
				var setupCount int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_agent_environment_secrets WHERE repository_id=$1`, repo.ID).Scan(&setupCount))
				require.Zero(t, setupCount)
				setup, err := q.GetRepositoryAgentEnvironment(ctx, repo.ID)
				require.NoError(t, err)
				require.Equal(t, "echo fixture", setup.SetupScript)
			}
		})
	}
	// A workspace-scoped system credential never takes person authority,
	// including when it belongs to the install owner.
	machine := credential{bearer: token(owner, "machine", "write:repository,workspace:box-1", true)}
	for _, call := range []struct{ method, path, body string }{
		{"POST", "/secrets", `{"name":"MACHINE_KEY","value":"v"}`},
		{"PATCH", "/secrets/OWNER_KEY", `{"main_only":false}`},
		{"DELETE", "/secrets/OWNER_KEY", ""},
	} {
		status, body := request(machine, call.method, call.path, call.body)
		require.Equal(t, http.StatusForbidden, status, body)
		require.Equal(t, "permission", body["class"], body)
		require.Equal(t, []string{"OWNER_KEY"}, stored())
	}
	var value []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value_encrypted FROM repository_secrets WHERE repository_id=$1 AND name='OWNER_KEY'`, repo.ID).Scan(&value))
	require.Equal(t, "v2", string(value), "no refusal replaced the value")

	// Org secrets are not an install route: a maintainer's session still
	// finds none there.
	req, err := http.NewRequest("POST", origin+"/api/orgs/acme/secrets", strings.NewReader(`{"name":"ORG","value":"v"}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", "csrf-fixture")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
	req.AddCookie(&http.Cookie{Name: "session", Value: maintainerSession.cookie})
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	require.Equal(t, 404, res.StatusCode, string(raw))
	var orgRows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM organization_secrets`).Scan(&orgRows))
	require.Zero(t, orgRows)

	// A removed maintainer and a suspended member hold dead sessions: a
	// secrets write carrying one is refused as unauthenticated (spec §5.2.1),
	// decided from the credential before the repository is resolved.
	// Nothing is written.
	status, body = call(ownerSession, "DELETE", "/api/members/maintainer", "")
	require.Equal(t, 204, status, body)
	github.mu.Lock()
	github.roles["writer"] = "read"
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	for _, who := range []credential{maintainerSession, writerSession} {
		status, body = call(who, "GET", "/api/members", "")
		require.Equal(t, 401, status, body)
		for _, write := range []struct{ method, path, body string }{
			{"POST", "/secrets", `{"name":"DEAD","value":"v"}`},
			{"PATCH", "/secrets/OWNER_KEY", `{"main_only":false}`},
			{"DELETE", "/secrets/OWNER_KEY", ""},
			{"PUT", "/agent-environment", `{"setup_script":"echo refused", "env":[]}`},
			{"PUT", "/agent-environment/secrets/REFUSED", `{"value":"machine-env-canary-value"}`},
			{"DELETE", "/agent-environment/secrets/REFUSED", ""},
		} {
			status, body = request(who, write.method, write.path, write.body)
			require.Equal(t, 401, status, "%s %s: %v", write.method, write.path, body)
			require.Equal(t, "unauthenticated", body["code"], body)
		}
	}
	require.Equal(t, []string{"OWNER_KEY"}, stored())
}
