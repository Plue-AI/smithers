package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type mirrorReadAdmissionProbe struct {
	routes.GitMirrorSyncRouteService
	before          func()
	repository, run int64
}

func (p *mirrorReadAdmissionProbe) GetMirrorSyncRun(ctx context.Context, repo, run int64) (services.GitMirrorSyncRunResult, error) {
	if p.before != nil {
		p.before()
	}
	if p.repository != 0 {
		repo = p.repository
	}
	if p.run != 0 {
		run = p.run
	}
	return p.GitMirrorSyncRouteService.GetMirrorSyncRun(ctx, repo, run)
}
func TestInstallMirrorReadAuthorizationPostgres(t *testing.T) {
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
	service := services.NewGitMirrorSyncService(q, services.WithGitMirrorInstallAuthorization(pool))
	handler := &routes.GitMirrorSyncHandler{Service: service}
	router := githubAppSetupComposeRouter(cfg, pool, nil, handler)
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerHash := session(f.owner, "mirror-owner")
	session(f.other, "mirror-member")
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "mirror-maintainer", LowerUsername: "mirror-maintainer"})
	require.NoError(t, err)
	_, err = pool.Exec(f.ctx, "INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')", f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "mirror-maintainer")
	run, err := q.CreateGithubMirrorSyncRun(f.ctx, db.CreateGithubMirrorSyncRunParams{RepositoryID: f.repoID, RequestedBy: pgtype.Int8{Int64: f.owner.ID, Valid: true}})
	require.NoError(t, err)
	n, err := q.MarkGithubMirrorSyncRunRunning(f.ctx, run.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	n, err = q.UpsertGithubMirrorSyncRefResult(f.ctx, db.UpsertGithubMirrorSyncRefResultParams{RunID: run.ID, Name: "refs/heads/private-diagnostics", FromRevision: "old", ToRevision: "new", Status: "failed", Error: "owner-only-mirror-diagnostic"})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	require.NoError(t, q.FinishGithubMirrorSyncRun(f.ctx, db.FinishGithubMirrorSyncRunParams{ID: run.ID, State: "failed"}))
	call := func(cookie, token string, id int64) (*httptest.ResponseRecorder, []string) {
		req := httptest.NewRequest("GET", fmt.Sprintf("%s/api/repos/gate-owner/app/mirror-sync/%d", cfg.Server.PublicURL, id), nil)
		ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
		defer cancel()
		req = req.WithContext(ctx)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		commands := []string{}
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	for _, actor := range []struct {
		name, cookie, token string
		status              int
	}{
		{"owner", "mirror-owner", "", 200}, {"member", "mirror-member", "", 403}, {"maintainer", "mirror-maintainer", "", 403},
		{"app", "", f.token(f.owner, "mirror-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true), 403},
		{"external", "", f.token(f.owner, "mirror-external", "read:repository,via:codex", true), 403},
		{"run", "", f.token(f.owner, "mirror-run", "read:repository", true), 403},
		{"machine", "", f.token(f.owner, "mirror-machine", "read:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true), 403},
		{"scope", "", f.token(f.owner, "mirror-scope", "read:user,via:codex", true), 403}, {"anonymous", "", "", 401},
	} {
		t.Run(actor.name, func(t *testing.T) {
			out, commands := call(actor.cookie, actor.token, run.ID)
			require.Equal(t, actor.status, out.Code, out.Body.String())
			require.Equal(t, []string{"mirror.read"}, commands)
			if actor.status == 200 {
				require.Contains(t, out.Body.String(), "owner-only-mirror-diagnostic")
				require.Contains(t, out.Body.String(), "refs/heads/private-diagnostics")
			} else {
				require.NotContains(t, out.Body.String(), "owner-only-mirror-diagnostic")
			}
		})
	}
	for _, mode := range []string{"repository", "run"} {
		t.Run("substituted "+mode, func(t *testing.T) {
			probe := &mirrorReadAdmissionProbe{GitMirrorSyncRouteService: service}
			if mode == "repository" {
				probe.repository = f.repoID + 1
			} else {
				probe.run = run.ID + 1
			}
			handler.Service = probe
			defer func() { handler.Service = service }()
			out, commands := call("mirror-owner", "", run.ID)
			require.Equal(t, 403, out.Code, out.Body.String())
			require.Equal(t, []string{"mirror.read"}, commands)
			require.NotContains(t, out.Body.String(), "owner-only-mirror-diagnostic")
		})
	}
	t.Run("unknown run", func(t *testing.T) {
		out, commands := call("mirror-owner", "", run.ID+100)
		require.Equal(t, 404, out.Code, out.Body.String())
		require.Equal(t, []string{"mirror.read"}, commands)
	})
	t.Run("expiry after route admission", func(t *testing.T) {
		handler.Service = &mirrorReadAdmissionProbe{GitMirrorSyncRouteService: service, before: func() {
			_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", ownerHash)
			require.NoError(t, err)
		}}
		defer func() { handler.Service = service }()
		out, commands := call("mirror-owner", "", run.ID)
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"mirror.read"}, commands)
		require.NotContains(t, out.Body.String(), "owner-only-mirror-diagnostic")
	})
	t.Run("composed recovery worker publishes expired status without git replay", func(t *testing.T) {
		_, err := pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1", ownerHash)
		require.NoError(t, err)
		expired, err := q.CreateGithubMirrorSyncRun(f.ctx, db.CreateGithubMirrorSyncRunParams{RepositoryID: f.repoID, RequestedBy: pgtype.Int8{Int64: f.owner.ID, Valid: true}})
		require.NoError(t, err)
		_, err = pool.Exec(f.ctx, "UPDATE github_mirror_sync_runs SET created_at=now()-interval '12 minutes' WHERE id=$1", expired.ID)
		require.NoError(t, err)
		// Reads do not perform recovery writes; the existing install worker does.
		out, commands := call("mirror-owner", "", expired.ID)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Contains(t, out.Body.String(), `"state":"queued"`)
		require.Equal(t, []string{"mirror.read"}, commands)
		workerCtx, cancel := context.WithCancel(f.ctx)
		done := make(chan struct{})
		go func() { defer close(done); service.StartRecovery(workerCtx) }()
		defer func() { cancel(); <-done }()
		require.Eventually(t, func() bool {
			row, err := q.GetGithubMirrorSyncRun(f.ctx, db.GetGithubMirrorSyncRunParams{ID: expired.ID, RepositoryID: f.repoID})
			return err == nil && row.State == "failed"
		}, 3*time.Second, 10*time.Millisecond)
		cancel()
		<-done
		out, commands = call("mirror-owner", "", expired.ID)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Contains(t, out.Body.String(), `"state":"failed"`)
		require.Equal(t, []string{"mirror.read"}, commands)
	})
	_, err = service.GetMirrorSyncRun(context.Background(), f.repoID, run.ID)
	require.Error(t, err)
}
