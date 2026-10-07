package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInstallMemberWorkspaceListsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	service := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool))
	broker := sse.NewBroker(f.pool)
	require.NoError(t, broker.Start(f.ctx))
	defer broker.Stop()
	handler := &routes.WorkspaceHandler{Service: service, Broker: broker}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, handler)
	own, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "member-visible-workspace", TargetBookmark: "smithers/member", Kind: "container", Status: "running"})
	require.NoError(t, err)
	foreign, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "private-owner-workspace", TargetBookmark: "smithers/owner", Kind: "container", Status: "running"})
	require.NoError(t, err)
	ownSession, err := f.q.CreateWorkspaceSession(f.ctx, db.CreateWorkspaceSessionParams{RepositoryID: f.repoID, UserID: f.other.ID, WorkspaceID: own.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	foreignSession, err := f.q.CreateWorkspaceSession(f.ctx, db.CreateWorkspaceSessionParams{RepositoryID: f.repoID, UserID: f.owner.ID, WorkspaceID: foreign.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	t.Run("direct metadata reads require a credential", func(t *testing.T) {
		_, _, err := service.ListWorkspaces(f.ctx, f.repoID, f.other.ID, 1, 30)
		require.Error(t, err)
		_, _, err = service.ListSessions(f.ctx, f.repoID, f.other.ID, 1, 30)
		require.Error(t, err)
		_, err = service.GetSession(f.ctx, ownSession.ID, f.repoID, f.other.ID)
		require.Error(t, err)
		_, err = service.GetWorkspace(f.ctx, own.ID, f.repoID, f.other.ID)
		require.Error(t, err)
	})
	cookie := "workspace-list-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	t.Run("direct reads bind the supplied actor and repository", func(t *testing.T) {
		info := &middleware.AuthInfo{User: &f.other, SessionHash: hex.EncodeToString(sum[:])}
		for _, tc := range []struct {
			name       string
			repo, user int64
			allowed    bool
		}{
			{"own", f.repoID, f.other.ID, true}, {"substituted actor", f.repoID, f.owner.ID, false}, {"substituted repository", f.repoID + 1, f.other.ID, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				calls := 0
				ctx := middleware.ContextWithAuthInfo(f.ctx, info)
				ctx = services.WithAuthorizationObserver(ctx, func(string) { calls++ })
				rows, _, err := service.ListSessions(ctx, tc.repo, tc.user, 1, 30)
				require.Equal(t, 1, calls)
				if tc.allowed {
					require.NoError(t, err)
					require.Len(t, rows, 1)
					require.Equal(t, ownSession.ID, rows[0].ID)
				} else {
					require.Error(t, err)
					require.Empty(t, rows)
				}
			})
		}
	})
	external := f.token(f.other, "workspace-list-external", "read:repository,via:codex", true)
	app := f.token(f.other, "workspace-list-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	run := f.token(f.other, "workspace-list-run", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.LandingWorkspaceScope(own.ID)+","+middleware.AgentSessionRestrictionScope("list-run"), true)
	machine := f.token(f.other, "workspace-list-machine", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(own.ID), true)
	for _, actor := range []struct {
		name, bearer, cookie string
		status               int
	}{{"person", "", cookie, 200}, {"external", external, "", 200}, {"app", app, "", 200}, {"run", run, "", 403}, {"machine", machine, "", 403}, {"scope", f.token(f.other, "list-scope", "read:user,via:codex", true), "", 403}, {"anonymous", "", "", 404}} {
		for _, path := range []string{"/api/repos/gate-owner/app/workspaces", "/api/repos/gate-owner/app/workspace/sessions", "/api/repos/gate-owner/app/workspace/sessions/" + ownSession.ID, "/api/repos/gate-owner/app/workspace/sessions/" + foreignSession.ID, "/api/repos/gate-owner/app/workspaces/" + own.ID + "/stream", "/api/repos/gate-owner/app/workspaces/" + foreign.ID + "/stream", "/api/repos/gate-owner/app/workspace/sessions/" + ownSession.ID + "/stream", "/api/repos/gate-owner/app/workspace/sessions/" + foreignSession.ID + "/stream"} {
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
				if strings.HasSuffix(path, "/stream") {
					ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
					defer cancel()
					channelID := own.ID
					if strings.Contains(path, "/sessions/") {
						channelID = ownSession.ID
					}
					sent := false
					writer := &workspaceAuthorizationRecorder{ResponseRecorder: out, cancel: cancel, notify: func() {
						if sent {
							return
						}
						sent = true
						_, err := f.pool.Exec(f.ctx, "SELECT pg_notify($1,$2)", "workspace_status_"+strings.ReplaceAll(channelID, "-", ""), `{"id":"member-stream-update","workspace":"`+own.ID+`"}`)
						require.NoError(t, err)
					}}
					router.ServeHTTP(writer, req.WithContext(ctx))
				} else {
					router.ServeHTTP(out, req)
				}
				status := actor.status
				if status == 200 && (strings.Contains(path, foreignSession.ID) || strings.Contains(path, foreign.ID)) {
					status = 403
				}
				require.Equal(t, status, out.Code, out.Body.String())
				if actor.status == 404 {
					require.Empty(t, commands)
				} else {
					command := "branches.read"
					if strings.Contains(path, "/sessions/") || strings.HasSuffix(path, "/stream") {
						command = "branch.read"
					}
					require.Equal(t, []string{command}, commands)
				}
				if status == 200 {
					require.Contains(t, out.Body.String(), own.ID)
					if strings.HasSuffix(path, "/stream") {
						require.Contains(t, out.Body.String(), "member-stream-update")
					}
					require.NotContains(t, out.Body.String(), foreign.ID)
					require.NotContains(t, out.Body.String(), "private-owner-workspace")
					require.NotContains(t, out.Body.String(), foreignSession.ID)
				} else {
					require.NotContains(t, out.Body.String(), own.ID)
				}
			})
		}
	}
	for _, path := range []string{"/api/repos/gate-owner/app/workspaces", "/api/repos/gate-owner/app/workspace/sessions", "/api/repos/gate-owner/app/workspaces/" + own.ID + "/stream", "/api/repos/gate-owner/app/workspace/sessions/" + ownSession.ID + "/stream"} {
		t.Run("expiry after route admission"+path, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1", hex.EncodeToString(sum[:]))
			require.NoError(t, err)
			probe := &workspaceMetadataAdmissionProbe{WorkspaceRouteService: service, before: func() {
				_, err := f.pool.Exec(f.ctx, "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1", hex.EncodeToString(sum[:]))
				require.NoError(t, err)
			}}
			handler.Service = probe
			defer func() { handler.Service = service }()
			req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			commands := []string{}
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, 401, out.Code, out.Body.String())
			require.Len(t, commands, 1)
			require.NotContains(t, out.Body.String(), own.ID)
			require.NotContains(t, out.Body.String(), ": connected")
		})
	}

}

// Publish only after the real broker has subscribed and flushed its initial
// frame. Cancel on the delivered fixture event, never merely on stream launch.
type workspaceAuthorizationRecorder struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
	notify func()
}

func (w *workspaceAuthorizationRecorder) Flush() { w.ResponseRecorder.Flush(); w.notify() }
func (w *workspaceAuthorizationRecorder) Write(body []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(body)
	if strings.Contains(w.Body.String(), "member-stream-update") {
		w.cancel()
	}
	return n, err
}

type workspaceMetadataAdmissionProbe struct {
	routes.WorkspaceRouteService
	before func()
}

func (p *workspaceMetadataAdmissionProbe) GetWorkspace(ctx context.Context, id string, repo, user int64) (services.WorkspaceResponse, error) {
	p.before()
	return p.WorkspaceRouteService.GetWorkspace(ctx, id, repo, user)
}
func (p *workspaceMetadataAdmissionProbe) GetSession(ctx context.Context, id string, repo, user int64) (services.WorkspaceSessionResponse, error) {
	p.before()
	return p.WorkspaceRouteService.GetSession(ctx, id, repo, user)
}
func (p *workspaceMetadataAdmissionProbe) ListWorkspaces(ctx context.Context, repo, user int64, page, per int) ([]services.WorkspaceResponse, int64, error) {
	p.before()
	return p.WorkspaceRouteService.ListWorkspaces(ctx, repo, user, page, per)
}
func (p *workspaceMetadataAdmissionProbe) ListSessions(ctx context.Context, repo, user int64, page, per int) ([]services.WorkspaceSessionResponse, int64, error) {
	p.before()
	return p.WorkspaceRouteService.ListSessions(ctx, repo, user, page, per)
}
