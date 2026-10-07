package compose

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

func TestInstallGitHubAccountReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	app := services.GitHubAppCredentials{ID: 3492, Slug: "access-fixture", OwnerLogin: "acme", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{AppID: app.ID, Slug: app.Slug, OwnerLogin: app.OwnerLogin, OwnerKind: app.OwnerKind, ClientID: app.ClientID, ClientSecret: app.ClientSecret, WebhookSecret: app.WebhookSecret, PrivateKeyPEM: app.PEM, ConversionCode: "manifest", OAuthCode: "owner", Installations: []githubfake.Installation{{ID: 349203, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app", Private: true}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
	for _, call := range []struct{ path, body string }{
		{"/app-manifests/manifest/conversions", ""},
		{"/login/oauth/access_token", url.Values{"code": {"owner"}, "client_id": {"client"}, "client_secret": {"secret"}, "redirect_uri": {"http://example.com/callback"}}.Encode()},
	} {
		response, err := fake.Client().Post(fake.URL+call.path, "application/x-www-form-urlencoded", strings.NewReader(call.body))
		require.NoError(t, err)
		require.Less(t, response.StatusCode, 300)
		require.NoError(t, response.Body.Close())
	}
	codec, err := webhook.NewSecretCodec("access-github-fixture")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(f.pool, codec)
	require.NoError(t, credentials.Save(f.ctx, app))
	connections := services.NewRepoConnectionService(f.pool, credentials)
	users := services.NewGitHubUserReposService(f.q, ownerTokenDecrypter{}, services.WithGitHubUserReposCredentialStore(credentials))
	_, err = f.q.CreateOAuthAccount(f.ctx, db.CreateOAuthAccountParams{UserID: f.owner.ID, Provider: "github", ProviderUserID: "7", AccessTokenEncrypted: []byte("fixture-sealed-token"), ProfileData: json.RawMessage(`{"login":"acme"}`)})
	require.NoError(t, err)
	for _, seed := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO github_app_installations(installation_id) VALUES(349203)`, nil},
		{`INSERT INTO github_app_installation_repositories(installation_id,github_repository_id) VALUES(349203,100)`, nil},
		{`INSERT INTO repo_connections(user_id,repo_owner,repo_name,repo_owner_lower,repo_name_lower,license_spdx_id,github_repository_id) VALUES($1,'acme','app','acme','app','MIT',100)`, []any{f.owner.ID}},
	} {
		_, err = f.pool.Exec(f.ctx, seed.sql, seed.args...)
		require.NoError(t, err)
	}
	issue := fake.OpenIssue("acme/app", "acme", "Private issue", "Private issue body")
	require.EqualValues(t, 1, issue)
	fake.CommentIssue("acme/app", issue, "acme", "Private comment")
	token, err := connections.CreateGitHubInstallationToken(f.ctx, 349203, services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	request, err := http.NewRequest("POST", fake.URL+"/repos/acme/app/pulls", strings.NewReader(`{"title":"Private pull","head":"scratch","base":"main"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := fake.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, 201, response.StatusCode)
	require.NoError(t, response.Body.Close())
	baselineWrites := len(fake.Writes())
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName, cfg.Auth.SessionRefreshWindow = "selfhost", "session", "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		&routes.GitHubUserReposHandler{Service: users}, &routes.GitHubRepoListHandler{Service: services.NewGitHubRepoListService(f.pool, connections)})
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "github-owner")
	session(f.other, "github-member")
	external := f.token(f.owner, "github-external", "read:repository,via:codex", true)
	appToken := f.token(f.owner, "github-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "github-run", "read:repository", true)
	machine := f.token(f.owner, "github-machine", "read:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	paths := []struct{ path, content string }{
		{"/api/user/github/repos", "acme/app"},
		{"/api/user/github-repos", "acme/app"},
		{"/api/user/github-repos/acme/app", "acme/app"},
		{"/api/user/github-repos/acme/app/issues", "Private issue"},
		{"/api/user/github-repos/acme/app/pulls", "Private pull"},
		{"/api/user/github-repos/acme/app/pulls/2", "Private pull"},
		// The upstream fixture returns its pull representation for the diff Accept
		// header; this checks authorization and transport, not diff rendering.
		{"/api/user/github-repos/acme/app/pulls/2/diff", "Private pull"},
		{"/api/user/github-repos/acme/app/issues/1/comments", "Private comment"},
		{"/api/user/github-access/acme/app", `"verdict":"ok"`},
		{"/api/user/github-app/installations", "acme/app"},
		{"/api/user/github-app/installations/349203", "acme/app"},
	}
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
		code                 string
	}{
		{"owner", "github-owner", "", 200, ""},
		{"member", "github-member", "", 403, "permission"},
		{"external", "", external, 403, "never"},
		{"app", "", appToken, 403, "never"},
		{"run", "", run, 403, "permission"},
		{"machine", "", machine, 403, "permission"},
		{"scope", "", f.token(f.owner, "github-scope", "read:user,via:codex", true), 403, "permission"},
		{"anonymous", "", "", 401, "unauthenticated"},
	} {
		for _, path := range paths {
			t.Run(actor.name+path.path, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+path.path, nil)
				if actor.cookie != "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: actor.cookie})
				}
				if actor.bearer != "" {
					req.Header.Set("Authorization", "Bearer "+actor.bearer)
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				before := len(fake.Reads())
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"github.account-read"}, commands)
				if actor.status == 200 {
					require.Contains(t, out.Body.String(), path.content)
				} else {
					require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
					require.NotContains(t, out.Body.String(), "acme/app")
					require.NotContains(t, out.Body.String(), "Private")
					require.Equal(t, before, len(fake.Reads()), "refused calls must not reach GitHub")
				}
				require.NotContains(t, out.Body.String(), "ghu_githubfake_owner")
			})
		}
	}
	_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
	require.NoError(t, err)
	for _, path := range paths {
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+path.path, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: "github-owner"})
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 401, out.Code, out.Body.String())
	}
	for _, write := range fake.Writes()[baselineWrites:] {
		require.Equal(t, "/app/installations/349203/access_tokens", write.Path, "reads may mint scoped installation tokens but never write repository state")
	}
}
