package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallReadAliasesPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{Service: services.NewRepoService(f.q, nil, "")}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{Service: services.NewLabelService(f.q)},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{Service: services.NewIssueService(f.q)},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	_, err := f.q.CreateIssue(f.ctx, db.CreateIssueParams{RepositoryID: f.repoID, Title: "Shared issue", Body: "Team text", AuthorID: f.owner.ID, Kind: "issue"})
	require.NoError(t, err)
	_, err = f.q.CreateLabel(f.ctx, db.CreateLabelParams{RepositoryID: f.repoID, Name: "todo", Color: "ffffff"})
	require.NoError(t, err)
	session := "read-alias-member"
	sum := sha256.Sum256([]byte(session))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	delegated := f.token(f.other, "alias-external", "read:repository,via:codex", true)
	run := f.token(f.owner, "alias-run", "read:repository", true)
	for _, path := range []string{"/issues", "/issues/1", "/issues/1/comments", "/issues/1/labels", "/labels"} {
		for _, actor := range []struct {
			name, token string
			status      int
		}{{"member", "", 200}, {"delegated", delegated, 200}, {"run", run, 403}} {
			t.Run(path+"/"+actor.name, func(t *testing.T) {
				req := httptest.NewRequest("GET", "http://example.com/api/repos/gate-owner/app"+path, nil)
				if actor.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: session})
				} else {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				decisions := []string{}
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"issue.read"}, decisions)
				if actor.status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
					require.NotContains(t, out.Body.String(), "Shared issue")
				}
				if actor.status == 200 && path == "/issues/1" {
					require.Contains(t, out.Body.String(), "Shared issue")
				}
			})
		}
	}
	for _, credential := range []string{"", "expired-cookie"} {
		req := httptest.NewRequest("GET", "http://example.com/api/health", nil)
		if credential != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: credential})
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())
	}
}

func TestInstallOwnAccountReadCommandsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	auth := services.NewAuthService(f.q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: f.pool}
	delegated, err := auth.CreateToken(f.ctx, f.other.ID, services.CreateTokenRequest{Name: "own-account-member", Via: "codex", Scopes: []string{"user"}})
	require.NoError(t, err)
	f.token(f.owner, "private-owner-token", "read:user", true)
	run := f.token(f.owner, "own-account-run", "read:user,read:repository", true)
	session := "own-account-member-session"
	sum := sha256.Sum256([]byte(session))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	router := buildRouterCompat(cfg, f.q, f.pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{TokenService: auth, SessionService: auth}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	for _, path := range []string{"/api/user/tokens", "/api/user/sessions"} {
		for _, actor := range []struct {
			name, token string
			status      int
		}{{"member", "", 200}, {"delegated", delegated.Token, 200}, {"run", run, 403}} {
			t.Run(path+"/"+actor.name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, cfg.Server.PublicURL+path, nil)
				if actor.token == "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: session})
				} else {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"self.read"}, decisions)
				require.NotContains(t, out.Body.String(), "private-owner-token")
				require.NotContains(t, out.Body.String(), delegated.Token)
				if actor.status == 403 {
					require.Contains(t, out.Body.String(), `"code":"permission"`)
				}
				if actor.status == 200 && path == "/api/user/tokens" {
					require.Contains(t, out.Body.String(), "own-account-member")
				}
			})
		}
	}
}
