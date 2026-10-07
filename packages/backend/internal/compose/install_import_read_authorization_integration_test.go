package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type importReadAdmissionProbe struct {
	routes.GitHubImportRouteService
	before  func()
	replace string
}

func (p *importReadAdmissionProbe) GetImportJob(ctx context.Context, userID int64, id string) (services.ImportJob, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace != "" {
		id = p.replace
	}
	return p.GitHubImportRouteService.GetImportJob(ctx, userID, id)
}

func TestInstallImportReadAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewGitHubImportService(pool, q, q, nil, nil, cfg.Server.PublicURL, services.WithGitHubImportInstallAuthorization(pool))
	handler := &routes.GitHubImportHandler{Service: service}
	router := githubAppSetupComposeRouter(cfg, pool, nil, handler)
	seed := func(user db.User, name string) string {
		var id string
		require.NoError(t, pool.QueryRow(f.ctx, `INSERT INTO import_jobs(user_id,github_owner,github_repo,repo_owner,repo_name,status,error) VALUES($1,'private-source',$2,'gate-owner',$2,'failed',$3) RETURNING id::text`, user.ID, name, name+"-private-error").Scan(&id))
		return id
	}
	own, other := seed(f.owner, "owner-import"), seed(f.other, "member-import")
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "import-owner")
	session(f.other, "import-member")
	call := func(cookie, bearer, id, accept string) (*httptest.ResponseRecorder, []string) {
		t.Helper()
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/github/import/"+id, nil)
		req.Header.Set("Accept", accept)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	app := f.token(f.owner, "import-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	external := f.token(f.owner, "import-external", "read:repository,via:codex", true)
	run := f.token(f.owner, "import-run", "read:repository,"+middleware.LandingWorkspaceScope("11111111-1111-4111-8111-111111111111")+","+middleware.AgentSessionRestrictionScope("import-run"), true)
	machine := f.token(f.owner, "import-machine", "read:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
	}{{"owner", "import-owner", "", 200}, {"member", "import-member", "", 403}, {"app", "", app, 403}, {"external", "", external, 403}, {"run", "", run, 403}, {"machine", "", machine, 403}, {"scope", "", f.token(f.owner, "import-scope", "read:user,via:codex", true), 403}, {"anonymous", "", "", 401}} {
		for _, accept := range []string{"application/json", "text/event-stream"} {
			t.Run(actor.name+accept, func(t *testing.T) {
				out, commands := call(actor.cookie, actor.bearer, own, accept)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{"github.import-read"}, commands)
				if actor.status == 200 {
					require.Contains(t, out.Body.String(), "owner-import-private-error")
					if accept == "text/event-stream" {
						require.Contains(t, out.Body.String(), "event: import_job")
					}
				} else {
					require.NotContains(t, out.Body.String(), "owner-import-private-error")
				}
				require.NotContains(t, out.Body.String(), "member-import-private-error")
			})
		}
	}
	t.Run("another persons receipt stays private", func(t *testing.T) {
		out, commands := call("import-owner", "", other, "application/json")
		require.Equal(t, 404, out.Code, out.Body.String())
		require.Equal(t, []string{"github.import-read"}, commands)
		require.NotContains(t, out.Body.String(), "member-import")
	})
	t.Run("dispatch cannot substitute the receipt", func(t *testing.T) {
		handler.Service = &importReadAdmissionProbe{GitHubImportRouteService: service, replace: other}
		defer func() { handler.Service = service }()
		out, commands := call("import-owner", "", own, "application/json")
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"github.import-read"}, commands)
	})
	t.Run("direct reads bind credential actor and receipt", func(t *testing.T) {
		_, err := service.GetImportJob(f.ctx, f.owner.ID, own)
		var denied *services.AccessError
		require.ErrorAs(t, err, &denied)
		require.Equal(t, 401, denied.Status)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		job, err := service.GetImportJob(ctx, f.owner.ID, own)
		require.NoError(t, err)
		require.Equal(t, own, job.ImportJobID)
		require.Equal(t, []string{"github.import-read"}, commands)
		subject, err := services.InstallGitHubImportReadSubject(own)
		require.NoError(t, err)
		decision, err := services.Authorize(ctx, q, "github.import-read", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "github.import-read", decision, subject)
		_, err = service.GetImportJob(ctx, f.other.ID, own)
		require.ErrorAs(t, err, &denied)
		require.Equal(t, 403, denied.Status)
		_, err = service.GetImportJob(ctx, f.owner.ID, other)
		require.ErrorAs(t, err, &denied)
		require.Equal(t, 403, denied.Status)
	})
	t.Run("missing verified repository selection remains refused", func(t *testing.T) {
		setting, err := q.GetInstallSetting(f.ctx, "github.repository")
		require.NoError(t, err)
		_, err = pool.Exec(f.ctx, `DELETE FROM install_settings WHERE key='github.repository'`)
		require.NoError(t, err)
		defer func() {
			_, err := pool.Exec(f.ctx, `INSERT INTO install_settings(key,value) VALUES('github.repository',$1)`, setting.Value)
			require.NoError(t, err)
		}()
		out, commands := call("import-owner", "", own, "application/json")
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Empty(t, commands)
		require.Contains(t, out.Body.String(), "owner_unverified")
	})

	t.Run("verified source reads progress before the local mirror exists", func(t *testing.T) {
		repository, err := q.GetInstallSetting(f.ctx, "github.repository")
		require.NoError(t, err)
		access, err := q.GetInstallSetting(f.ctx, "owner.access")
		require.NoError(t, err)
		_, err = pool.Exec(f.ctx, `UPDATE install_settings SET value=jsonb_set(jsonb_set(jsonb_set(value,'{owner_login}','"unpublished-owner"'),'{repository_name}','"unpublished-repo"'),'{repository_id}','99999999') WHERE key IN ('github.repository','owner.access')`)
		require.NoError(t, err)
		defer func() {
			require.NoError(t, q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: repository.Key, Value: repository.Value}))
			require.NoError(t, q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: access.Key, Value: access.Value}))
		}()
		_, err = q.InstallRepositoryID(f.ctx)
		require.Error(t, err)
		out, commands := call("import-owner", "", own, "application/json")
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"github.import-read"}, commands)
		require.Contains(t, out.Body.String(), "owner-import-private-error")
	})
	t.Run("stream checks the live credential on every poll", func(t *testing.T) {
		_, err := pool.Exec(f.ctx, `UPDATE import_jobs SET status='cloning' WHERE id=$1`, own)
		require.NoError(t, err)
		calls := 0
		handler.Service = &importReadAdmissionProbe{GitHubImportRouteService: service, before: func() {
			calls++
			if calls == 2 {
				_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
				require.NoError(t, err)
				_, err = f.pool.Exec(f.ctx, `UPDATE import_jobs SET status='failed',error='later-private-marker' WHERE id=$1`, own)
				require.NoError(t, err)
			}
		}}
		defer func() {
			handler.Service = service
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		out, commands := call("import-owner", "", own, "text/event-stream")
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"github.import-read"}, commands)
		require.Equal(t, 2, calls)
		require.Equal(t, 1, strings.Count(out.Body.String(), "event: import_job"))
		require.Contains(t, out.Body.String(), "event: error")
		require.NotContains(t, out.Body.String(), "later-private-marker")
	})
}
