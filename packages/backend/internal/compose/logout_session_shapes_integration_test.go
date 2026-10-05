package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// Anything auth accepts, logout revokes (#3559). AuthLoader accepts any
// session cookie whose SHA-256 digest names a row, and any cookie but a
// 64-hex string as a legacy raw key. Through the composed install router and
// real PostgreSQL, POST /api/auth/logout leaves no row for each accepted
// shape, and the next request with that cookie gets 401 unauthenticated
// "Sign in again" from both the RequireAuth gate and the Authorize path. A
// 64-hex cookie is never a raw key, so presenting another session's stored
// digest neither authenticates nor revokes it.
func TestLogoutRevokesEveryAcceptedSessionShapeComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos','101','{}')`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-04T22:00:00Z"}`)}))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'admin',$3,'owner')`,
		repo.ID, owner.ID, rosterGitHubID("owner"))
	require.NoError(t, err)
	github := &rosterGitHub{roles: map[string]string{"owner": "admin"}}
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
	authHandler := &routes.AuthHandler{Service: svc, AuthConfig: cfg.Auth, InstallSetup: svc.InstallSetup}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, authHandler, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, &routes.SecretHandler{Service: services.NewSecretService(q, nil)}, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}})
	server.Start()
	defer server.Close()

	digest := func(key string) string { d := sha256.Sum256([]byte(key)); return hex.EncodeToString(d[:]) }
	seed := func(stored string) {
		t.Helper()
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: stored, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	rows := func(stored string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE session_key=$1`, stored).Scan(&n))
		return n
	}
	request := func(cookie, method, path string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, origin+path, nil)
		require.NoError(t, err)
		req.Header.Set("Origin", origin)
		if cookie != "" {
			req.Header.Set("X-CSRF-Token", "csrf-fixture")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		return res.StatusCode, string(body) + strings.Join(res.Header.Values("Set-Cookie"), "; ")
	}
	const signInAgain = `"message":"Sign in again"`

	hex64 := digest("b8-harness-seed")
	cases := []struct{ shape, row, cookie, stored string }{
		{"uuid", "digest-keyed", "550e8400-e29b-41d4-a716-446655440001", digest("550e8400-e29b-41d4-a716-446655440001")},
		{"uuid", "legacy raw-keyed", "550e8400-e29b-41d4-a716-446655440002", "550e8400-e29b-41d4-a716-446655440002"},
		{"64-hex", "digest-keyed", hex64, digest(hex64)},
		{"opaque", "digest-keyed", "b8-opaque-session-1", digest("b8-opaque-session-1")},
		{"opaque", "legacy raw-keyed", "b8-opaque-session-2", "b8-opaque-session-2"},
	}
	for _, tc := range cases {
		t.Run(tc.shape+"/"+tc.row, func(t *testing.T) {
			seed(tc.stored)
			status, body := request(tc.cookie, "GET", "/api/members")
			require.Equal(t, 200, status, "auth accepts the cookie before logout: %s", body)

			status, body = request(tc.cookie, "POST", "/api/auth/logout")
			require.Less(t, status, 400, body)
			require.Contains(t, body, "session=;", "logout clears the cookie")
			after := rows(tc.stored)
			require.Equal(t, 0, after, "logout leaves no auth_sessions row")

			guarded, guardedBody := request(tc.cookie, "GET", "/api/user/orgs")
			authorized, authorizedBody := request(tc.cookie, "GET", "/api/members")
			for _, got := range []struct {
				status int
				body   string
			}{{guarded, guardedBody}, {authorized, authorizedBody}} {
				require.Equal(t, 401, got.status, got.body)
				require.Contains(t, got.body, `"code":"unauthenticated"`)
				require.Contains(t, got.body, signInAgain)
			}
			t.Logf("cookie=%-36s row=%-16s logout=%d rows_after=%d RequireAuth=%d Authorize=%d %s",
				tc.shape, tc.row, status, after, guarded, authorized, strings.TrimSpace(authorizedBody))
		})
	}

	// A 64-hex cookie is never a legacy raw key: a stored digest presented as
	// a cookie (a database dump) neither authenticates nor revokes its row.
	t.Run("64-hex/stored digest of another session", func(t *testing.T) {
		victim := digest("victim-session")
		seed(victim)
		status, body := request(victim, "GET", "/api/members")
		require.Equal(t, 401, status, body)
		require.Contains(t, body, signInAgain)
		status, body = request(victim, "POST", "/api/auth/logout")
		require.Less(t, status, 400, body)
		require.Equal(t, 1, rows(victim), "the victim's session survives")
		status, body = request("victim-session", "GET", "/api/members")
		require.Equal(t, 200, status, body)
	})

	// No credential keeps "Sign in"; only a presented dead one says again.
	status, body := request("", "GET", "/api/members")
	require.Equal(t, 401, status, body)
	require.Contains(t, body, `"code":"unauthenticated"`)
	require.Contains(t, body, `"message":"Sign in"}`)
}
