package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The transport is simulated; authorization, workspace grants and recency
// writes run through the composed router against a real one-connection store.
type serviceControlRuntime struct {
	workspaceapi.WorkspaceRuntime
	calls           int
	waitUntil       time.Time
	actions         []string
	rows            map[string]db.Workspace
	repositoryCalls int
	rootWait        time.Time
	state           workspaceapi.WorkspaceState
	starts          int
}

func (*serviceControlRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{ManagedServices: true, Execution: true, PersistentFiles: true, FileOperations: true}
}
func (*serviceControlRuntime) GuestIdentity() (string, int) { return "agent", 19999 }
func (*serviceControlRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (r *serviceControlRuntime) InspectWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	if !r.waitUntil.IsZero() {
		timer := time.NewTimer(time.Until(r.waitUntil))
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return workspaceapi.Workspace{}, ctx.Err()
		}
	}
	state := r.state
	if state == "" {
		state = workspaceapi.WorkspaceRunning
	}
	return workspaceapi.Workspace{ID: id, State: state}, nil
}
func (r *serviceControlRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.starts++
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (r *serviceControlRuntime) ManageService(_ context.Context, _ string, name, action string) (workspaceapi.ServiceObservation, error) {
	r.calls++
	r.actions = append(r.actions, name+":"+action)
	return workspaceapi.ServiceObservation{Service: workspaceapi.Service{Name: name, Address: "127.0.0.1:3000"}, State: workspaceapi.ServiceRunning}, nil
}

// A pre-existing guest checkout is simulated, not certified by this test.
func (r *serviceControlRuntime) ListFiles(ctx context.Context, _ string, path string) ([]workspaceapi.FileEntry, error) {
	r.repositoryCalls++
	if path == "" {
		if !r.rootWait.IsZero() {
			timer := time.NewTimer(time.Until(r.rootWait))
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
	}
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return nil, fmt.Errorf("unexpected list path %q", path)
}
func (r *serviceControlRuntime) ReadFile(_ context.Context, id, path string) ([]byte, error) {
	r.repositoryCalls++
	if path != ".git/smithers-workspace-initialization.json" {
		return nil, fmt.Errorf("unexpected read path %q", path)
	}
	row := r.rows[id]
	return json.Marshal(map[string]any{"version": 1, "workspace_id": id, "repository_id": row.RepositoryID, "clone_url": "http://example.com/gate-owner/app.git", "source_bookmark": row.TargetBookmark, "source_revision": strings.Repeat("0", 40), "initialized_at": time.Now().UTC()})
}
func (r *serviceControlRuntime) ExecuteCommand(_ context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	r.repositoryCalls++
	if strings.Join(command.Args, " ") != "git remote get-url origin" {
		return workspaceapi.CommandResult{}, fmt.Errorf("unexpected command")
	}
	return workspaceapi.CommandResult{Stdout: "http://example.com/gate-owner/app.git\n"}, nil
}

type serviceControlAdmissionProbe struct {
	*services.WorkspaceService
	before                  func()
	repository, actor       int64
	workspace, name, action string
}

func (p *serviceControlAdmissionProbe) ManageWorkspaceService(ctx context.Context, id string, repo, user int64, name, action string) (services.WorkspaceManagedService, error) {
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
	if p.name != "" {
		name = p.name
	}
	if p.action != "" {
		action = p.action
	}
	return p.WorkspaceService.ManageWorkspaceService(ctx, id, repo, user, name, action)
}
func TestInstallWorkspaceServiceControlAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	runtime := &serviceControlRuntime{}
	service := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool), services.WithWorkspaceRuntime(runtime), services.WithWorkspaceGitBaseURL("http://example.com"), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)))
	probe := &serviceControlAdmissionProbe{WorkspaceService: service}
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
	runtime.rows = map[string]db.Workspace{own.ID: own, foreign.ID: foreign}
	app := f.token(f.other, "services-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.other, "services-external", "write:repository,via:codex", true)
	run := f.token(f.other, "services-run", "write:repository", true)
	machine := f.token(f.other, "services-machine", "write:repository,"+middleware.WorkspaceRestrictionScope(own.ID), true)
	limited := f.token(f.other, "services-limited", "read:user,via:codex", true)
	call := func(t *testing.T, id, cookie, token string, status int, control ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 6*time.Second)
		defer cancel()
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		name, action := "web", "restart"
		if len(control) == 2 {
			name, action = control[0], control[1]
		}
		req := httptest.NewRequest("POST", fmt.Sprintf("%s/api/repos/%s/%s/workspaces/%s/services/%s/%s", cfg.Server.PublicURL, f.owner.Username, "app", id, name, action), nil).WithContext(ctx)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "control-csrf"})
			req.Header.Set("X-CSRF-Token", "control-csrf")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Origin", cfg.Server.PublicURL)
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"box.services"}, commands)
		if status == 200 {
			require.Contains(t, out.Body.String(), "web")
		} else {
			require.NotContains(t, out.Body.String(), "127.0.0.1:3000")
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
	t.Run("literal controls and invalid actions", func(t *testing.T) {
		for _, action := range []string{"start", "stop", "restart"} {
			before := runtime.calls
			call(t, own.ID, "services-member", "", 200, "web.service", action)
			require.Equal(t, before+1, runtime.calls)
			require.Equal(t, "web:"+action, runtime.actions[len(runtime.actions)-1])
		}
		before := runtime.calls
		call(t, own.ID, "services-member", "", 400, "web", "reload")
		call(t, own.ID, "services-member", "", 404, "smithers-workspace-agent", "stop")
		require.Equal(t, before, runtime.calls)
	})
	t.Run("private and shared", func(t *testing.T) {
		before := runtime.calls
		call(t, own.ID, "services-owner", "", 403)
		call(t, foreign.ID, "services-member", "", 403)
		require.Equal(t, before, runtime.calls)
		call(t, foreign.ID, "services-owner", "", 200)
		_, err := q.UpsertWorkspaceShare(f.ctx, db.UpsertWorkspaceShareParams{WorkspaceID: own.ID, OwnerUserID: f.other.ID, GranteeUserID: f.owner.ID, Level: "read"})
		require.NoError(t, err)
		call(t, own.ID, "services-owner", "", 403)
		_, err = q.UpsertWorkspaceShare(f.ctx, db.UpsertWorkspaceShareParams{WorkspaceID: own.ID, OwnerUserID: f.other.ID, GranteeUserID: f.owner.ID, Level: "write"})
		require.NoError(t, err)
		call(t, own.ID, "services-owner", "", 200)
		require.NoError(t, q.DeleteWorkspaceShare(f.ctx, db.DeleteWorkspaceShareParams{WorkspaceID: own.ID, GranteeUserID: f.owner.ID}))
		before = runtime.calls
		call(t, own.ID, "services-owner", "", 403)
		require.Equal(t, before, runtime.calls)
	})
	t.Run("install-owned branch uses the real member and share boundary", func(t *testing.T) {
		machineOwner, err := q.GetBranchMachineOwner(f.ctx)
		require.NoError(t, err)
		branch, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: machineOwner, Name: "shared branch", TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		runtime.rows[branch.ID] = branch
		_, err = q.UpsertWorkspaceShare(f.ctx, db.UpsertWorkspaceShareParams{WorkspaceID: branch.ID, OwnerUserID: machineOwner, GranteeUserID: f.other.ID, Level: "write"})
		require.NoError(t, err)
		call(t, branch.ID, "services-member", "", 200)
		call(t, branch.ID, "", app, 200)
		before := runtime.calls
		call(t, branch.ID, "services-owner", "", 403)
		require.Equal(t, before, runtime.calls)
		require.NoError(t, q.DeleteWorkspaceShare(f.ctx, db.DeleteWorkspaceShareParams{WorkspaceID: branch.ID, GranteeUserID: f.other.ID}))
		call(t, branch.ID, "services-member", "", 403)
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
		probe.name = "another"
		call(t, own.ID, "services-member", "", 403)
		probe.name = ""
		probe.action = "stop"
		call(t, own.ID, "services-member", "", 403)
		probe.action = ""
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
		repositoryBefore := runtime.repositoryCalls
		call(t, own.ID, "services-member", "", 401)
		require.Equal(t, before, runtime.calls)
		require.Equal(t, repositoryBefore, runtime.repositoryCalls)
		require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT last_accessed_at FROM workspaces WHERE id=$1`, own.ID).Scan(&accessed))
		require.True(t, accessed.Equal(old))
	})
	t.Run("expiry during checkout", func(t *testing.T) {
		deadline := time.Now().Add(4 * time.Second)
		_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, hash, deadline)
		require.NoError(t, err)
		runtime.rootWait = deadline.Add(25 * time.Millisecond)
		defer func() {
			runtime.rootWait = time.Time{}
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		before, reads := runtime.calls, runtime.repositoryCalls
		call(t, own.ID, "services-member", "", 401)
		require.Equal(t, before, runtime.calls)
		require.Equal(t, reads+1, runtime.repositoryCalls)
	})
	t.Run("stopped workspace retains machine admission and expiry fences", func(t *testing.T) {
		runtime.state = workspaceapi.WorkspaceStopped
		_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, own.ID)
		require.NoError(t, err)
		call(t, own.ID, "services-member", "", 503)
		require.Zero(t, runtime.starts)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, hash, deadline)
		require.NoError(t, err)
		runtime.waitUntil = deadline.Add(25 * time.Millisecond)
		defer func() {
			runtime.state = ""
			runtime.waitUntil = time.Time{}
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
		}()
		before := runtime.calls
		call(t, own.ID, "services-member", "", 401)
		require.Equal(t, before, runtime.calls)
		require.Zero(t, runtime.starts)
	})
	t.Run("direct call needs credential", func(t *testing.T) {
		before := runtime.calls
		_, err := service.ManageWorkspaceService(f.ctx, own.ID, f.repoID, f.other.ID, "web", "restart")
		require.Error(t, err)
		require.Equal(t, before, runtime.calls)
	})
}
