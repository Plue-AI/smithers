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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only runtime observations are simulated. The composed HTTP admission, private
// workspace ACL, credential fences and recency transaction use real PostgreSQL.
// This proves authorization, not guest execution or microVM isolation.
type serviceListRuntime struct {
	workspaceapi.WorkspaceRuntime
	calls     int
	waitUntil time.Time
}

func (*serviceListRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (*serviceListRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (r *serviceListRuntime) ListServices(ctx context.Context, _ string) ([]workspaceapi.ServiceObservation, error) {
	r.calls++
	if !r.waitUntil.IsZero() {
		timer := time.NewTimer(time.Until(r.waitUntil))
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return []workspaceapi.ServiceObservation{{Service: workspaceapi.Service{Name: "private-api", Address: "127.0.0.1:3000"}, State: workspaceapi.ServiceRunning}}, nil
}

type serviceListAdmissionProbe struct {
	*services.WorkspaceService
	before            func()
	repository, actor int64
	workspace         string
}

func (p *serviceListAdmissionProbe) ListWorkspaceServices(ctx context.Context, id string, repo, user int64) ([]services.WorkspaceManagedService, error) {
	if p.before != nil {
		p.before()
	}
	if p.repository != 0 {
		repo = p.repository
	}
	if p.actor != 0 {
		user = p.actor
	}
	if p.workspace != "" {
		id = p.workspace
	}
	return p.WorkspaceService.ListWorkspaceServices(ctx, id, repo, user)
}
func TestInstallWorkspaceServicesAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	runtime := &serviceListRuntime{}
	service := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool), services.WithWorkspaceRuntime(runtime))
	probe := &serviceListAdmissionProbe{WorkspaceService: service}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, pool, nil, &routes.WorkspaceHandler{Service: probe})
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	hash := session(f.other, "services-member")
	session(f.owner, "services-owner")
	own, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "member", TargetBookmark: "scratch/member/services", Kind: "container", Status: "running"})
	require.NoError(t, err)
	foreign, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "owner", TargetBookmark: "scratch/owner/services", Kind: "container", Status: "running"})
	require.NoError(t, err)
	app := f.token(f.other, "services-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.other, "services-external", "read:repository,via:codex", true)
	run := f.token(f.other, "services-run", "read:repository", true)
	machine := f.token(f.other, "services-machine", "read:repository,"+middleware.WorkspaceRestrictionScope(own.ID), true)
	limited := f.token(f.other, "services-limited", "read:user,via:codex", true)
	call := func(t *testing.T, id, cookie, token string, status int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 6*time.Second)
		defer cancel()
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		req := httptest.NewRequest("GET", fmt.Sprintf("%s/api/repos/%s/%s/workspaces/%s/services", cfg.Server.PublicURL, f.owner.Username, "app", id), nil).WithContext(ctx)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"workspace.services.list"}, commands)
		if status == 200 {
			require.Contains(t, out.Body.String(), "private-api")
		} else {
			require.NotContains(t, out.Body.String(), "private-api")
		}
	}
	for _, a := range []struct {
		name, cookie, token string
		status              int
	}{
		{"member", "services-member", "", 200}, {"app", "", app, 200}, {"external", "", external, 403}, {"run", "", run, 403}, {"machine", "", machine, 403}, {"scope", "", limited, 403}, {"anonymous", "", "", 401},
	} {
		t.Run(a.name, func(t *testing.T) {
			before := runtime.calls
			call(t, own.ID, a.cookie, a.token, a.status)
			if a.status == 200 {
				require.Equal(t, before+1, runtime.calls)
			} else {
				require.Equal(t, before, runtime.calls)
			}
		})
	}
	t.Run("private and shared", func(t *testing.T) {
		before := runtime.calls
		call(t, own.ID, "services-owner", "", 403)
		call(t, foreign.ID, "services-member", "", 403)
		require.Equal(t, before, runtime.calls)
		call(t, foreign.ID, "services-owner", "", 200)
		_, err := q.UpsertWorkspaceShare(f.ctx, db.UpsertWorkspaceShareParams{WorkspaceID: own.ID, OwnerUserID: f.other.ID, GranteeUserID: f.owner.ID, Level: "read"})
		require.NoError(t, err)
		call(t, own.ID, "services-owner", "", 200)
		require.NoError(t, q.DeleteWorkspaceShare(f.ctx, db.DeleteWorkspaceShareParams{WorkspaceID: own.ID, GranteeUserID: f.owner.ID}))
		before = runtime.calls
		call(t, own.ID, "services-owner", "", 403)
		require.Equal(t, before, runtime.calls)
	})
	t.Run("substitutions", func(t *testing.T) {
		before := runtime.calls
		probe.actor = f.owner.ID
		call(t, own.ID, "services-member", "", 403)
		probe.actor = 0
		probe.repository = f.repoID + 1
		call(t, own.ID, "services-member", "", 403)
		probe.repository = 0
		probe.workspace = foreign.ID
		call(t, own.ID, "services-member", "", 403)
		probe.workspace = ""
		require.Equal(t, before, runtime.calls)
	})
	t.Run("expiry after admission", func(t *testing.T) {
		probe.before = func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}
		defer func() {
			probe.before = nil
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		before := runtime.calls
		call(t, own.ID, "services-member", "", 401)
		require.Equal(t, before, runtime.calls)
	})
	t.Run("recency commits only with live credential", func(t *testing.T) {
		old := time.Now().Add(-time.Hour).Truncate(time.Microsecond)
		_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET last_accessed_at=$2 WHERE id=$1`, own.ID, old)
		require.NoError(t, err)
		call(t, own.ID, "services-member", "", 200)
		var accessed time.Time
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT last_accessed_at FROM workspaces WHERE id=$1`, own.ID).Scan(&accessed))
		require.True(t, accessed.After(old))
		_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET last_accessed_at=$2 WHERE id=$1`, own.ID, old)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, hash, deadline)
		require.NoError(t, err)
		runtime.waitUntil = deadline.Add(25 * time.Millisecond)
		defer func() {
			runtime.waitUntil = time.Time{}
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		before := runtime.calls
		call(t, own.ID, "services-member", "", 401)
		require.Equal(t, before+1, runtime.calls)
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT last_accessed_at FROM workspaces WHERE id=$1`, own.ID).Scan(&accessed))
		require.True(t, accessed.Equal(old))
	})
	t.Run("direct call needs credential", func(t *testing.T) {
		before := runtime.calls
		_, err := service.ListWorkspaceServices(f.ctx, own.ID, f.repoID, f.other.ID)
		require.Error(t, err)
		require.Equal(t, before, runtime.calls)
	})
}
