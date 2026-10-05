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
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
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
}

func (g *rosterGitHub) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/repos/acme/app/installation":
		if g.installationStatus != 0 {
			w.WriteHeader(g.installationStatus)
			return
		}
		fmt.Fprint(w, `{"id":91}`)
	case r.URL.Path == "/app/installations/91/access_tokens":
		w.WriteHeader(201)
		fmt.Fprint(w, `{"token":"installation-token"}`)
	case strings.HasPrefix(r.URL.Path, "/repos/acme/app/collaborators/"):
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
		json.NewEncoder(w).Encode(map[string]string{"permission": permission, "role_name": role})
	case strings.HasPrefix(r.URL.Path, "/users/"):
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
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
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
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}}
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
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, handler, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}})
	server.Start()
	defer server.Close()
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
	require.NoError(t, pool.QueryRow(ctx, `SELECT user_id IS NULL,unix_uid FROM collaborators WHERE github_id=102`).Scan(&pending, &uid))
	require.True(t, pending)
	require.GreaterOrEqual(t, uid, 20000)
	// OAuth start/callback uses the composed router and production HTTP client.
	login := func(name string, want int) {
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
	}
	login("reader", 403)
	login("writer", 302)
	login("writer", 302)
	writer, err := q.GetUserByLowerUsername(ctx, "writer")
	require.NoError(t, err)
	createSession(writer, "writer-cookie")
	require.NoError(t, pool.QueryRow(ctx, `SELECT user_id IS NULL,unix_uid FROM collaborators WHERE github_id=102`).Scan(&pending, &uid))
	require.False(t, pending)
	status, body := request("GET", "/api/members", "", "writer-cookie")
	require.Equal(t, 200, status, body)
	require.Contains(t, body, `"role":"maintainer"`)
	status, body = request("PATCH", "/api/members/owner", `{"role":"member"}`, "writer-cookie")
	require.Equal(t, 403, status, body)
	require.Contains(t, body, `"code":"permission"`)
	status, body = request("PATCH", "/api/members/writer", `{"role":"maintainer"}`, "owner-cookie")
	require.Equal(t, 204, status, body)
	status, body = request("DELETE", "/api/members/writer", "", "owner-cookie")
	require.Equal(t, 204, status, body)
	status, _ = request("GET", "/api/members", "", "writer-cookie")
	require.Equal(t, 401, status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, writer.ID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1 AND kind='collaborator_removed'`, writer.ID).Scan(&count))
	require.Equal(t, 1, count)
	status, body = request("DELETE", "/api/members/writer", "", "owner-cookie")
	require.Equal(t, 204, status, body)

	// Added again, the writer signs in again; the hourly recheck suspends
	// them once GitHub confirms read, and restores them once it says write.
	status, body = request("POST", "/api/members", `{"login":"writer"}`, "owner-cookie")
	require.Equal(t, 204, status, body)
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
}
