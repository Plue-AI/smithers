package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInstallMemberAccountReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewUserService(f.q)
	router := buildRouterCompat(cfg, f.q, f.pool, &routes.RepoHandler{RepoConnectionService: services.NewRepoConnectionService(f.pool)}, &routes.AuthHandler{}, &routes.UserHandler{ProfileService: service, EmailService: services.NewEmailService(f.q, nil, services.EmailServiceConfig{}), SignupProfiles: services.NewSignupProfileService(f.q)}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, &routes.RepositoryJobHandler{RepositoryJobs: services.NewRepositoryJobService(f.q, nil, f.pool)})

	_, sourceErr := f.pool.Exec(f.ctx, `INSERT INTO github_synced_repos(owner_login,owner_login_lower,repo_name,repo_name_lower,mirror_owner,mirror_repo,sync_state) VALUES('source-owner','source-owner','source-repo','source-repo','gate-owner','app','ready')`)
	require.NoError(t, sourceErr)

	for _, item := range []struct {
		user int64
		name string
	}{{f.owner.ID, "private-owner"}, {f.other.ID, "private-member"}} {
		_, err := f.q.UpsertEmailAddress(f.ctx, db.UpsertEmailAddressParams{UserID: item.user, Email: item.name + "@example.test", LowerEmail: item.name + "@example.test", IsPrimary: true, IsActivated: true})
		require.NoError(t, err)
		_, err = f.q.CreateOAuthAccount(f.ctx, db.CreateOAuthAccountParams{UserID: item.user, Provider: "github", ProviderUserID: item.name, AccessTokenEncrypted: []byte("never-disclose-credential"), RefreshTokenEncrypted: []byte("never-disclose-refresh"), ProfileData: json.RawMessage(`{}`)})
		require.NoError(t, err)
		_, err = f.q.UpsertOnboardingAnswers(f.ctx, db.UpsertOnboardingAnswersParams{UserID: item.user, Answers: json.RawMessage(`{"name":"` + item.name + `","account":"` + item.name + `","stage":"done","answers":{}}`)})
		require.NoError(t, err)
	}
	_, err := f.q.UpdateUserNotificationPreferences(f.ctx, db.UpdateUserNotificationPreferencesParams{UserID: f.other.ID, EmailNotificationsEnabled: false})
	require.NoError(t, err)

	cookie := "workspace-list-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	external := f.token(f.other, "workspace-list-external", "read:user,read:repository,via:codex", true)
	app := f.token(f.other, "workspace-list-app", "read:user,read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	run := f.token(f.other, "workspace-list-run", "read:user", true)
	machine := f.token(f.other, "workspace-list-machine", "read:user,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	for _, actor := range []struct {
		name, bearer, cookie string
		status               int
	}{{"person", "", cookie, 200}, {"external", external, "", 200}, {"app", app, "", 200}, {"run", run, "", 403}, {"machine", machine, "", 403}, {"scope", f.token(f.other, "list-scope", "write:workspace,via:codex", true), "", 403}, {"anonymous", "", "", 401}} {
		for _, path := range []string{"/api/user/emails", "/api/user/connections", "/api/user/settings/notifications", "/api/user/settings/signup", "/api/integrations/mcp", "/api/integrations/skills", "/api/repos/gate-owner/app/repository-source", "/api/repos/gate-owner/app/github-app-status"} {
			t.Run(actor.name+path, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
				if actor.bearer != "" {
					req.Header.Set("Authorization", "Bearer "+actor.bearer)
				}
				if actor.cookie != "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: actor.cookie})
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				status := actor.status
				if actor.name == "anonymous" && path == "/api/repos/gate-owner/app/repository-source" {
					status = 404 // The private repository remains undisclosed.
				}
				require.Equal(t, status, out.Code, out.Body.String())
				if actor.status == 401 {
					require.Empty(t, commands)
				} else {
					command := "self.read"
					if strings.HasPrefix(path, "/api/repos/") {
						command = "repo.read"
					}
					require.Equal(t, []string{command}, commands)
				}

				require.NotContains(t, out.Body.String(), "private-owner")
				require.NotContains(t, out.Body.String(), "never-disclose")
				if actor.status == 200 {
					if path == "/api/repos/gate-owner/app/repository-source" {
						require.JSONEq(t, `{"source":"github","full_name":"source-owner/source-repo"}`, out.Body.String())
					} else if path == "/api/repos/gate-owner/app/github-app-status" {
						require.Contains(t, out.Body.String(), `"github_app_configured":false`)
						require.Contains(t, out.Body.String(), `"github_app_installed":false`)
						require.NotContains(t, out.Body.String(), "installation_id")
					} else if path == "/api/integrations/mcp" || path == "/api/integrations/skills" {
						require.JSONEq(t, `[]`, out.Body.String(), "no provider or skills catalog is configured in this composition")
					} else if path == "/api/user/settings/notifications" {
						require.Contains(t, out.Body.String(), `"email_notifications_enabled":false`)
					} else {
						require.Contains(t, out.Body.String(), "private-member")
					}
				} else {
					require.NotContains(t, out.Body.String(), "private-member")
				}

			})
		}
	}
}
