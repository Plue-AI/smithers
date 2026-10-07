package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Admin routes take a person's credential (#3740; spec §5.2.1, §5.3.0).
// Through the composed multitenant router and real PostgreSQL, an admin
// user's browser session and personal access token reach /api/admin. The
// same admin user's delegated, run, machine and sync tokens, each carrying
// read:admin and write:admin, are refused: the delegated one with 403 never
// ("Only a person can do this"), the others with 403 permission. No
// production path mints those tokens with admin scopes, so the fixture
// writes them directly. A refused mutation changes nothing.
func TestAdminRoutesRequirePersonCredentialComposedMultitenantPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
		require.NoError(t, err)
		return created
	}
	admin, target := user("admin"), user("target")
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: admin.ID, IsAdmin: true}))

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeMultitenant
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	adminUsers := &routes.AdminUserHandler{Service: services.NewAdminUserService(q)}
	adminRepos := &routes.AdminRepoHandler{Service: services.NewAdminRepoService(q)}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, adminUsers, nil, adminRepos, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{})
	server.Start()
	defer server.Close()

	later := time.Now().Add(time.Hour)
	digest := sha256.Sum256([]byte("admin-cookie"))
	_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: admin.ID, Username: admin.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: later})
	require.NoError(t, err)
	// token mints an admin-scoped token directly and checks the router will
	// classify it as kind, so no row tests a different kind than its name.
	token := func(name string, kind middleware.CredentialKind, systemIssued bool, extra ...string) string {
		seed := sha256.Sum256([]byte("admin-" + name))
		raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
		hash := sha256.Sum256([]byte(raw))
		scopes := strings.Join(append([]string{"read:admin", "write:admin"}, extra...), ",")
		require.Equal(t, kind, middleware.TokenCredentialKind(systemIssued, scopes, admin.UserType), name)
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: admin.ID, Name: name, TokenHash: hex.EncodeToString(hash[:]),
			TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: later, Valid: true}, SystemIssued: systemIssued})
		require.NoError(t, err)
		return raw
	}
	type credential struct{ name, cookie, bearer, class string }
	credentials := []credential{
		{name: "session", cookie: "admin-cookie"},
		{name: "pat", bearer: token("pat", middleware.CredentialPerson, false)},
		{name: "delegated", bearer: token("delegated", middleware.CredentialDelegated, true, "via:cli"), class: "never"},
		{name: "run", bearer: token("run", middleware.CredentialAgentRun, true), class: "permission"},
		{name: "machine", bearer: token("machine", middleware.CredentialMachine, true, middleware.WorkspaceRestrictionScope("00000000-0000-0000-0000-000000000001")), class: "permission"},
		{name: "sync", bearer: token("sync", middleware.CredentialSync, true, middleware.SyncCredentialScope()), class: "permission"},
	}

	request := func(c credential, method, path, body string) (int, map[string]any) {
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
		var decoded map[string]any
		_ = json.Unmarshal(raw, &decoded)
		return res.StatusCode, decoded
	}
	targetIsAdmin := func() bool {
		t.Helper()
		got, err := q.GetUserByID(ctx, target.ID)
		require.NoError(t, err)
		return got.IsAdmin
	}

	for _, route := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/admin/users", ""},
		{http.MethodGet, "/api/admin/repos", ""},
		{http.MethodPatch, "/api/admin/users/target/admin", `{"is_admin":true}`},
	} {
		for _, c := range credentials {
			t.Run(c.name+" "+route.method+" "+route.path, func(t *testing.T) {
				require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: target.ID, IsAdmin: false}))
				status, body := request(c, route.method, route.path, route.body)
				if c.class == "" {
					require.Equal(t, http.StatusOK, status, body)
					require.Equal(t, route.method == http.MethodPatch, targetIsAdmin())
					return
				}
				require.Equal(t, http.StatusForbidden, status, body)
				require.Equal(t, c.class, body["class"], body)
				if c.class == "never" {
					require.Equal(t, "Only a person can do this", body["message"], body)
				}
				require.False(t, targetIsAdmin(), "a refused credential changed the target")
			})
		}
	}
}
