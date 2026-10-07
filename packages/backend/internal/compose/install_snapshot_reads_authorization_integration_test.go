package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestInstallMemberSnapshotReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service})
	own, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "member-visible-workspace", TargetBookmark: "smithers/member", Kind: "container", Status: "running"})
	require.NoError(t, err)
	foreign, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "private-owner-snapshot", TargetBookmark: "smithers/owner", Kind: "container", Status: "running"})
	require.NoError(t, err)
	ownSnapshot, err := f.q.CreateWorkspaceSnapshot(f.ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: f.repoID, UserID: f.other.ID, WorkspaceID: own.ID, Name: "member recovery", SnapshotID: "member-retained-machine"})
	require.NoError(t, err)
	foreignSnapshot, err := f.q.CreateWorkspaceSnapshot(f.ctx, db.CreateWorkspaceSnapshotParams{RepositoryID: f.repoID, UserID: f.owner.ID, WorkspaceID: foreign.ID, Name: "private-owner-snapshot", SnapshotID: "owner-retained-machine"})
	require.NoError(t, err)
	cookie := "workspace-list-member"
	sum := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	external := f.token(f.other, "workspace-list-external", "read:repository,via:codex", true)
	app := f.token(f.other, "workspace-list-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	run := f.token(f.other, "workspace-list-run", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.LandingWorkspaceScope(own.ID)+","+middleware.AgentSessionRestrictionScope("list-run"), true)
	machine := f.token(f.other, "workspace-list-machine", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(own.ID), true)
	for _, actor := range []struct {
		name, bearer, cookie string
		status               int
	}{{"person", "", cookie, 200}, {"external", external, "", 200}, {"app", app, "", 200}, {"run", run, "", 403}, {"machine", machine, "", 403}, {"scope", f.token(f.other, "list-scope", "read:user,via:codex", true), "", 403}, {"anonymous", "", "", 404}} {
		for _, path := range []string{"/api/repos/gate-owner/app/workspace-snapshots", "/api/repos/gate-owner/app/workspace-snapshots/" + ownSnapshot.ID, "/api/repos/gate-owner/app/workspace-snapshots/" + foreignSnapshot.ID} {
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
				if status == 200 && path == "/api/repos/gate-owner/app/workspace-snapshots/"+foreignSnapshot.ID {
					status = 403
				}
				require.Equal(t, status, out.Code, out.Body.String())
				if actor.name == "anonymous" {
					require.Empty(t, commands)
				} else {
					require.Equal(t, []string{"repo.read"}, commands)
				}
				if status == 200 {
					require.Contains(t, out.Body.String(), own.ID)
					require.NotContains(t, out.Body.String(), foreign.ID)
					require.NotContains(t, out.Body.String(), "private-owner-snapshot")
				} else {
					require.NotContains(t, out.Body.String(), own.ID)
					if status == 403 {
						require.Contains(t, out.Body.String(), `"code":"permission"`)
					}
				}
			})
		}
	}
}
