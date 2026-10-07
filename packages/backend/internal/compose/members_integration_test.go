package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type rosterAppCredentials struct{}

func (rosterAppCredentials) AppJWT(context.Context) (string, error) { return "fixture-jwt", nil }
func (rosterAppCredentials) InstallURL(context.Context) (string, error) {
	return "https://github.com/apps/fixture/installations/new", nil
}
func (rosterAppCredentials) Load(context.Context) (services.GitHubAppCredentials, error) {
	return services.GitHubAppCredentials{}, nil
}

type rosterGitHub struct {
	mu                 sync.Mutex
	roles              map[string]string
	login              string
	installationStatus int
	permissionStatus   int
	permissionBody     string
	repositoryStatus   int
	keys               map[string][]string
	keyETag            string
	keyReads           int
	keyNotModified     int
	keyPages           map[string][]string
	keyStatus          int
	renamed            bool
	missingID          bool
}

func (g *rosterGitHub) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/repos/acme/app/installation" || r.URL.Path == "/repos/owner/app/installation":
		if g.installationStatus != 0 {
			w.WriteHeader(g.installationStatus)
			return
		}
		fmt.Fprint(w, `{"id":91}`)
	case r.URL.Path == "/app/installations/91/access_tokens":
		w.WriteHeader(201)
		fmt.Fprint(w, `{"token":"installation-token","expires_at":"2099-01-01T00:00:00Z"}`)
	case strings.HasPrefix(r.URL.Path, "/user/") && r.URL.Path != "/user/emails":
		requireToken := r.Header.Get("Authorization") == "Bearer installation-token"
		if !requireToken {
			w.WriteHeader(500)
			return
		}
		if r.URL.Path == "/user/102" && g.missingID {
			w.WriteHeader(404)
			return
		}
		login := ""
		for _, name := range []string{"writer", "maintainer", "admin", "reader"} {
			if r.URL.Path == fmt.Sprintf("/user/%d", rosterGitHubID(name)) {
				login = name
			}
		}
		if login == "writer" && g.renamed {
			login = "renamed"
		}
		if login == "" {
			w.WriteHeader(404)
			return
		}
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/user/"), 10, 64)
		json.NewEncoder(w).Encode(map[string]any{"id": id, "login": login})
	case r.URL.Path == "/repos/acme/app" || r.URL.Path == "/repos/owner/app":
		fmt.Fprintf(w, `{"id":500,"full_name":%q}`, strings.TrimPrefix(r.URL.Path, "/repos/"))
	case r.URL.Path == "/installation/repositories":
		if g.repositoryStatus != 0 {
			w.WriteHeader(g.repositoryStatus)
			return
		}
		fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":500}]}`)
	case strings.HasPrefix(r.URL.Path, "/repos/acme/app/collaborators/") || strings.HasPrefix(r.URL.Path, "/repos/owner/app/collaborators/"):
		if g.permissionStatus != 0 {
			w.WriteHeader(g.permissionStatus)
			fmt.Fprint(w, g.permissionBody)
			return
		}
		login := strings.Split(r.URL.Path, "/")[5]
		role, ok := g.roles[login]
		if !ok {
			w.WriteHeader(404)
			return
		}
		permission := role
		if role == "maintain" {
			permission = "write"
		}
		id := rosterGitHubID(login)
		if login == "renamed" {
			id = 102
		}
		json.NewEncoder(w).Encode(map[string]any{"permission": permission, "role_name": role, "user": map[string]any{"id": id}})
	case strings.HasPrefix(r.URL.Path, "/users/") && strings.HasSuffix(r.URL.Path, "/keys"):
		g.keyReads++
		if g.keyStatus != 0 {
			w.WriteHeader(g.keyStatus)
			return
		}
		w.Header().Set("ETag", g.keyETag)
		if g.keyETag != "" && r.Header.Get("If-None-Match") == g.keyETag {
			g.keyNotModified++
			w.WriteHeader(304)
			return
		}
		login := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/users/"), "/keys")
		keys := []map[string]any{}
		pageKeys := g.keys[login]
		if r.URL.Query().Get("page") == "2" {
			pageKeys = g.keyPages[login]
		} else if len(g.keyPages[login]) > 0 {
			w.Header().Set("Link", `<https://api.github.com/users/`+login+`/keys?per_page=100&page=2>; rel="next"`)
		}
		for i, key := range pageKeys {
			keys = append(keys, map[string]any{"id": i + 1, "key": key})
		}
		json.NewEncoder(w).Encode(keys)
	case strings.HasPrefix(r.URL.Path, "/users/"):
		if r.URL.Path == "/users/renamed" {
			json.NewEncoder(w).Encode(map[string]any{"id": 102, "login": "renamed"})
			return
		}
		login := strings.TrimPrefix(r.URL.Path, "/users/")
		if _, ok := g.roles[login]; !ok {
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": rosterGitHubID(login), "login": login})
	case r.URL.Path == "/login/oauth/access_token":
		fmt.Fprint(w, `{"access_token":"user-token","token_type":"bearer"}`)
	case r.URL.Path == "/user":
		json.NewEncoder(w).Encode(map[string]any{"id": rosterGitHubID(g.login), "login": g.login, "name": g.login})
	case r.URL.Path == "/user/emails":
		json.NewEncoder(w).Encode([]any{map[string]any{"email": g.login + "@example.test", "primary": true, "verified": true}})
	default:
		w.WriteHeader(404)
	}
}
func rosterGitHubID(login string) int64 {
	switch login {
	case "owner":
		return 101
	case "writer":
		return 102
	case "maintainer":
		return 103
	case "admin":
		return 104
	case "reader":
		return 105
	case "root":
		return 106
	case strings.Repeat("b", 39):
		return 107
	case strings.Repeat("b", 38) + "c":
		return 108
	default:
		return 199
	}
}

func TestMembersComposedInstallPostgres(t *testing.T) {
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
	github := &rosterGitHub{roles: map[string]string{"owner": "admin", "writer": "write", "maintainer": "maintain", "admin": "admin", "reader": "read"}, login: "writer"}
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
	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(ctx))
	defer broker.Stop()
	agentService := services.NewAgentServiceWithPool(q, pool)
	streamHandler := &routes.AgentSessionStreamHandler{Service: agentService, Broker: broker}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, handler, &routes.UserHandler{}, &routes.SSHKeyHandler{Service: services.NewSSHKeyService(q)}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, streamHandler, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}, Live: liveHandler})
	server.Start()
	defer server.Close()
	// Even the owner's token must pass command authorization before the
	// composed TODO handler can run. Owner admission alone is insufficient.
	rawOwnerToken := fmt.Sprintf("smithers_%040x", owner.ID)
	tokenSum := sha256.Sum256([]byte(rawOwnerToken))
	tokenHash := hex.EncodeToString(tokenSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "owner-cli", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:user", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	tokenRequest, err := http.NewRequest(http.MethodGet, origin+"/api/todos", nil)
	require.NoError(t, err)
	tokenRequest.Header.Set("Authorization", "Bearer "+rawOwnerToken)
	tokenResponse, err := http.DefaultClient.Do(tokenRequest)
	require.NoError(t, err)
	tokenBody, err := io.ReadAll(tokenResponse.Body)
	tokenResponse.Body.Close()
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, tokenResponse.StatusCode, string(tokenBody))
	require.JSONEq(t, `{"class":"permission","code":"permission","message":"Insufficient credential scope"}`, string(tokenBody))
	createSession := func(user db.User, key string) {
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	createSession(owner, "owner-cookie")
	request := func(method, path, body, key string) (int, string) {
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		if key != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: key})
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		return res.StatusCode, string(data)
	}
	delegatedToken := "smithers_" + strings.Repeat("d", 40)
	delegatedSum := sha256.Sum256([]byte(delegatedToken))
	delegatedHash := hex.EncodeToString(delegatedSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "owner-delegated", TokenHash: delegatedHash, TokenLastEight: delegatedHash[len(delegatedHash)-8:], Scopes: "all", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	// Eligible delegated callers are refused before reads or membership effects.
	for _, door := range []struct{ method, path, body string }{
		{"GET", "/api/members", ""}, {"POST", "/api/members", `{"login":"writer"}`},
		{"PATCH", "/api/members/owner", `{"role":"member"}`}, {"DELETE", "/api/members/owner", ""},
	} {
		req, err := http.NewRequest(door.method, origin+door.path, strings.NewReader(door.body))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+delegatedToken)
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 403, response.StatusCode, string(body))
		require.JSONEq(t, `{"class":"never","code":"never","message":"Only a person can do this"}`, string(body))
	}
	// Missing composition providers refuse all doors without changing the roster.
	for _, missing := range []string{"pool", "credentials", "minter"} {
		original := *members
		switch missing {
		case "pool":
			members.Pool = nil
		case "credentials":
			members.Credentials = nil
		case "minter":
			members.Minter = nil
		}
		for _, door := range []struct{ method, path, body string }{
			{"GET", "/api/members", ""}, {"POST", "/api/members", `{"login":"writer"}`},
			{"PATCH", "/api/members/owner", `{"role":"member"}`}, {"DELETE", "/api/members/owner", ""},
		} {
			status, body := request(door.method, door.path, door.body, "owner-cookie")
			require.Equal(t, 503, status, missing+body)
			require.JSONEq(t, `{"class":"infra","code":"unavailable","message":"Members unavailable"}`, body)
		}
		*members = original
		var rows int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE repository_id=$1`, repo.ID).Scan(&rows))
		require.Equal(t, 1, rows)
	}
	for _, fixture := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/api/members", "", 200, `"role":"owner"`},
		{"POST", "/api/members", `{"login":"bad/name"}`, 400, "invalid_login"},
		{"POST", "/api/members", `{"login":"unknown"}`, 404, "unknown_github_user"},
		{"POST", "/api/members", `{"login":"reader"}`, 403, "needs_github_access"},
		{"POST", "/api/members", `{"login":"writer"}`, 204, ""},
		{"POST", "/api/members", `{"login":"writer"}`, 204, ""},
		{"POST", "/api/members", `{"login":"maintainer"}`, 204, ""},
		{"POST", "/api/members", `{"login":"admin"}`, 204, ""},
		{"PATCH", "/api/members/owner", `{"role":"member"}`, 403, "owner_immutable"},
		{"DELETE", "/api/members/owner", "", 403, "owner_immutable"},
		{"PATCH", "/api/members/writer", `{"role":"owner"}`, 403, "owner_immutable"},
	} {
		status, body := request(fixture.method, fixture.path, fixture.body, "owner-cookie")
		require.Equal(t, fixture.status, status, body)
		require.Contains(t, body, fixture.code)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE repository_id=$1`, repo.ID).Scan(&count))
	require.Equal(t, 4, count)
	var pending bool
	var uid int
	var unixLogin string
	require.NoError(t, pool.QueryRow(ctx, `SELECT user_id IS NULL,unix_uid,unix_login FROM collaborators WHERE github_id=102`).Scan(&pending, &uid, &unixLogin))
	require.True(t, pending)
	require.Equal(t, "writer", unixLogin)
	firstUID := uid
	require.GreaterOrEqual(t, uid, 20000)
	// OAuth start/callback uses the composed router and production HTTP client.
	login := func(name string, want int) string {
		// Each admission case starts with a fresh rate-limit window.
		require.NoError(t, q.DeleteAllRateLimits(ctx))
		github.mu.Lock()
		github.login = name
		github.mu.Unlock()
		req, _ := http.NewRequest("GET", origin+"/api/auth/github", nil)
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		start, err := client.Do(req)
		require.NoError(t, err)
		start.Body.Close()
		require.Equal(t, 302, start.StatusCode)
		location := start.Header.Get("Location")
		state := strings.Split(strings.Split(location, "state=")[1], "&")[0]
		callback, _ := http.NewRequest("GET", origin+"/api/auth/github/callback?code=fixture-code&state="+state, nil)
		for _, cookie := range start.Cookies() {
			callback.AddCookie(cookie)
		}
		res, err := client.Do(callback)
		require.NoError(t, err)
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		require.Equal(t, want, res.StatusCode, string(body))
		if want != 302 {
			for _, cookie := range res.Cookies() {
				require.NotEqual(t, "session", cookie.Name)
			}
		}
		return string(body)
	}
	keyFixture := func() string {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, err)
		key, err := ssh.NewPublicKey(pub)
		require.NoError(t, err)
		return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	}
	imported, manual, other := keyFixture(), keyFixture(), keyFixture()
	github.mu.Lock()
	github.keys = map[string][]string{"writer": {imported}}
	github.keyETag = `"keys-v1"`
	github.mu.Unlock()
	login("reader", 403)
	login("writer", 302)
	login("writer", 302)
	// A listed GitHub writer who loses push access is refused at the actual
	// OAuth callback, with the repository access page and no person cookie.
	github.mu.Lock()
	github.roles["writer"] = "read"
	github.mu.Unlock()
	refusedAccess := login("writer", 403)
	require.JSONEq(t, `{"class":"permission","code":"needs_github_access","message":"Needs access on GitHub ↗"}`, refusedAccess)
	github.mu.Lock()
	github.roles["writer"] = "write"
	github.mu.Unlock()

	writer, err := q.GetUserByLowerUsername(ctx, "writer")
	require.NoError(t, err)
	createSession(writer, "writer-cookie")
	statusKeys, bodyKeys := request("GET", "/api/user/keys", "", "writer-cookie")
	require.Equal(t, 200, statusKeys, bodyKeys)
	require.Contains(t, bodyKeys, `"source":"github"`)
	github.mu.Lock()
	require.Equal(t, 1, github.keyNotModified)
	github.mu.Unlock()
	manualKey, err := services.NewSSHKeyService(q).CreateKey(ctx, writer.ID, services.CreateSSHKeyRequest{Title: "manual", Key: manual})
	require.NoError(t, err)
	otherKey, err := services.NewSSHKeyService(q).CreateKey(ctx, owner.ID, services.CreateSSHKeyRequest{Title: "other", Key: other})
	require.NoError(t, err)
	github.mu.Lock()
	github.keys["writer"] = []string{manual, other}
	github.keyETag = `"keys-v2"`
	github.mu.Unlock()
	require.Error(t, members.SyncGitHubKeys(ctx, writer.ID, "writer"), "another person's key rolls back the diff")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM ssh_keys WHERE user_id=$1 AND source='github'`, writer.ID).Scan(&count))
	require.Equal(t, 1, count)
	_, err = q.GetSSHKeyByID(ctx, otherKey.ID)
	require.NoError(t, err)
	github.mu.Lock()
	github.keys["writer"] = []string{manual}
	github.mu.Unlock()

	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_key_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ssh_key_revoked' THEN RAISE EXCEPTION 'key event failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_key_event BEFORE INSERT ON revocation_events FOR EACH ROW EXECUTE FUNCTION reject_key_event()`)
	require.NoError(t, err)
	require.NoError(t, members.Recheck(ctx), "key failure cannot fail permission rechecks")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM ssh_keys WHERE user_id=$1 AND source='github'`, writer.ID).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1 AND kind='ssh_key_revoked'`, writer.ID).Scan(&count))
	require.Zero(t, count)
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_key_event ON revocation_events`)
	require.NoError(t, err)
	require.NoError(t, members.Recheck(ctx))
	statusKeys, bodyKeys = request("GET", "/api/user/keys", "", "writer-cookie")
	require.Equal(t, 200, statusKeys, bodyKeys)
	require.Contains(t, bodyKeys, manualKey.Fingerprint)
	require.Contains(t, bodyKeys, `"source":"manual"`)
	require.NotContains(t, bodyKeys, `"source":"github"`)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1 AND kind='ssh_key_revoked'`, writer.ID).Scan(&count))
	require.Equal(t, 1, count)
	secondImported := keyFixture()
	github.mu.Lock()
	github.keys["writer"] = []string{imported}
	github.keyPages = map[string][]string{"writer": {secondImported}}
	github.keyETag = `"keys-paged"`
	github.mu.Unlock()
	require.NoError(t, members.SyncGitHubKeys(ctx, writer.ID, "writer"))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM ssh_keys WHERE user_id=$1 AND source='github'`, writer.ID).Scan(&count))
	require.Equal(t, 2, count)
	github.mu.Lock()
	github.keys["writer"] = []string{"malformed"}
	github.keyPages = nil
	github.keyETag = `"keys-malformed"`
	github.mu.Unlock()
	require.Error(t, members.SyncGitHubKeys(ctx, writer.ID, "writer"))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM ssh_keys WHERE user_id=$1 AND source='github'`, writer.ID).Scan(&count))
	require.Equal(t, 2, count)
	github.mu.Lock()
	github.keyStatus = 502
	github.mu.Unlock()
	login("writer", 502)
	github.mu.Lock()
	github.keyStatus = 0
	github.keys["writer"] = []string{}
	github.keyETag = `"keys-empty"`
	github.mu.Unlock()
	require.NoError(t, members.SyncGitHubKeys(ctx, writer.ID, "writer"))

	require.NoError(t, pool.QueryRow(ctx, `SELECT user_id IS NULL,unix_uid,unix_login FROM collaborators WHERE github_id=102`).Scan(&pending, &uid, &unixLogin))
	require.False(t, pending)
	require.Equal(t, "writer", unixLogin)
	require.Equal(t, firstUID, uid)
	status, body := request("GET", "/api/members", "", "writer-cookie")
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"role":"maintainer"`)
	status, body = request("PATCH", "/api/members/owner", `{"role":"member"}`, "writer-cookie")
	require.Equal(t, 403, status, body)
	require.Contains(t, body, `"code":"permission"`)
	busCtx, stopBus := context.WithCancel(ctx)
	defer stopBus()
	bus := revocation.NewBus(nil, q) // No LISTEN: durable catch-up must recover every lost NOTIFY.
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	// A second viewer receives committed roster changes through the composed live route.
	liveCtx, cancelLive := context.WithTimeout(ctx, 10*time.Second)
	defer cancelLive()
	socket, _, err := websocket.Dial(liveCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{
		Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=writer-cookie"}},
	})
	require.NoError(t, err)
	defer socket.CloseNow()
	require.NoError(t, socket.Write(liveCtx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"members"}`)))
	readRole := func(want string) {
		for {
			_, raw, err := socket.Read(liveCtx)
			require.NoError(t, err)
			var frame struct {
				T    string                     `json:"t"`
				Data services.MembersProjection `json:"data"`
			}
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.Equal(t, "snap", frame.T, string(raw))
			for _, member := range frame.Data.Members {
				require.Empty(t, member.Actions, "shared topic must not expose viewer controls")
				if member.Login == "writer" && member.Role == want {
					return
				}
			}
		}
	}
	readRole("member")
	status, body = request("PATCH", "/api/members/writer", `{"role":"maintainer"}`, "owner-cookie")
	require.Equal(t, 204, status, body)
	readRole("maintainer")
	status, body = request("DELETE", "/api/members/writer", "", "owner-cookie")
	require.Equal(t, 204, status, body)
	closedCtx, cancelClosed := context.WithTimeout(ctx, 5*time.Second)
	defer cancelClosed()
	for {
		_, _, closed := socket.Read(closedCtx)
		if closed != nil {
			require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(closed), "removal must close the live session within five seconds")
			break
		}
	}
	status, _ = request("GET", "/api/members", "", "writer-cookie")
	require.Equal(t, 401, status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, writer.ID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1 AND kind='collaborator_removed'`, writer.ID).Scan(&count))
	require.Equal(t, 1, count)
	status, body = request("DELETE", "/api/members/writer", "", "owner-cookie")
	require.Equal(t, 204, status, body)

	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE unix_login='writer' AND user_id IS NULL AND github_id IS NULL AND suspended_at IS NOT NULL`).Scan(&count))
	require.Zero(t, count, "main removes the roster row")
	status, body = request("GET", "/api/members", "", "owner-cookie")
	require.Equal(t, 200, status, body)
	require.NotContains(t, body, `"login":"writer"`)

	// Added again, the writer signs in again; the hourly recheck suspends
	// them once GitHub confirms read, and restores them once it says write.
	status, body = request("POST", "/api/members", `{"login":"writer"}`, "owner-cookie")
	require.Equal(t, 204, status, body)
	require.NoError(t, pool.QueryRow(ctx, `SELECT unix_uid,unix_login FROM collaborators WHERE github_id=102`).Scan(&uid, &unixLogin))
	require.NotEqual(t, firstUID, uid, "main re-admission creates a fresh roster allocation")
	require.Equal(t, "writer", unixLogin, "the fresh roster row receives the available login")
	login("writer", 302)
	createSession(writer, "writer-cookie-2")
	status, body = request("GET", "/api/members", "", "writer-cookie-2")
	require.Equal(t, 200, status, body)
	github.mu.Lock()
	github.installationStatus = 500
	github.mu.Unlock()
	require.Error(t, members.Recheck(ctx), "an installation failure is reported")
	status, _ = request("GET", "/api/members", "", "writer-cookie-2")
	require.Equal(t, 200, status, "an installation failure suspends nobody")
	github.mu.Lock()
	github.installationStatus = 0
	github.mu.Unlock()
	for _, failure := range []struct {
		status     int
		body       string
		repoStatus int
	}{
		{404, `{}`, 404}, {404, `{}`, 403}, {200, `{}`, 0}, {200, `{"permission":"future"}`, 0},
	} {
		github.mu.Lock()
		github.permissionStatus, github.permissionBody, github.repositoryStatus = failure.status, failure.body, failure.repoStatus
		github.mu.Unlock()
		require.Error(t, members.Recheck(ctx))
		status, body = request("GET", "/api/members", "", "writer-cookie-2")
		require.Equal(t, 200, status, body)
		var suspended bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE github_id=102`).Scan(&suspended))
		require.False(t, suspended, "ambiguous GitHub failures preserve membership")
		login("writer", 503)
	}
	github.mu.Lock()
	github.permissionStatus, github.permissionBody, github.repositoryStatus = 0, "", 0
	github.roles["writer"] = "read"
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	var suspended bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE github_id=102`).Scan(&suspended))
	require.True(t, suspended)
	status, _ = request("GET", "/api/members", "", "writer-cookie-2")
	require.Equal(t, 401, status, "suspension ends the session")
	login("writer", 403)
	status, body = request("GET", "/api/members", "", "owner-cookie")
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"suspended":true`)
	github.mu.Lock()
	github.roles["writer"] = "write"
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE github_id=102`).Scan(&suspended))
	require.False(t, suspended)
	status, _ = request("GET", "/api/members", "", "writer-cookie-2")
	require.Equal(t, 401, status, "restoring never revives a revoked session")
	login("writer", 302)
	exerciseMemberRevocation(t, pool, origin, writer, bus, request, createSession)
	t.Run("imported_ssh_keys", func(t *testing.T) {
		exerciseImportedSSHKeys(t, pool, members, github, writer, bus, request, createSession)
	})
	// The old login can now belong to a writer with a different ID. The
	// original account resolves to its renamed login and has lost permission.
	createSession(writer, "writer-cookie-3")
	github.mu.Lock()
	github.renamed = true
	github.roles["writer"] = "write"
	github.permissionStatus = 0
	github.permissionBody = ""
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	status, _ = request("GET", "/api/members", "", "writer-cookie-3")
	require.Equal(t, 401, status, "confirmed permission 404 rejects the old session")
	var currentLogin string
	require.NoError(t, pool.QueryRow(ctx, `SELECT github_login,suspended_at IS NOT NULL FROM collaborators WHERE github_id=102`).Scan(&currentLogin, &suspended))
	require.Equal(t, "renamed", currentLogin)
	require.True(t, suspended)
	github.mu.Lock()
	github.permissionStatus = 0
	github.roles["renamed"] = "write"
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	status, _ = request("GET", "/api/members", "", "writer-cookie-3")
	require.Equal(t, 401, status, "recovery never revives a confirmed-404 session")

}
