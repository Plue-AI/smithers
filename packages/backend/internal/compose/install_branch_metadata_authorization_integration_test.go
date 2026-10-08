package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type delayedBranchMetadataHead func(context.Context, string, string) ([]byte, error)

func (f delayedBranchMetadataHead) InfoRefsUploadPack(ctx context.Context, owner, repo string) ([]byte, error) {
	return f(ctx, owner, repo)
}

type branchMetadataAdmissionProbe struct {
	*services.WorkspaceService
	before            func()
	repository, actor int64
}

func (p *branchMetadataAdmissionProbe) GetBranch(ctx context.Context, branch string, repo, user int64) (services.BranchMachineResponse, error) {
	if p.before != nil {
		p.before()
	}
	if p.repository != 0 {
		repo = p.repository
	}
	if p.actor != 0 {
		user = p.actor
	}
	return p.WorkspaceService.GetBranch(ctx, branch, repo, user)
}

func TestInstallBranchMetadataAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	service := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
	probe := &branchMetadataAdmissionProbe{WorkspaceService: service}
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
	hash := session(f.other, "branch-read-member")
	session(f.owner, "branch-read-owner")
	own, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "private member branch", TargetBookmark: "scratch/member/read", Kind: "container", Status: "stopped"})
	require.NoError(t, err)
	foreign, err := q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "private owner branch", TargetBookmark: "scratch/owner/read", Kind: "container", Status: "stopped"})
	require.NoError(t, err)
	app := f.token(f.other, "branch-read-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.other, "branch-read-external", "read:repository,via:codex", true)
	run := f.token(f.other, "branch-read-run", "read:repository", true)
	machine := f.token(f.other, "branch-read-machine", "read:repository,"+middleware.WorkspaceRestrictionScope(own.ID), true)
	limited := f.token(f.other, "branch-read-limited", "read:user,via:codex", true)
	call := func(t *testing.T, branch, cookie, token string, status int) *httptest.ResponseRecorder {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
		defer cancel()
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/branches/"+url.PathEscape(branch), nil).WithContext(ctx)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"branch.read"}, commands)
		return out
	}
	for _, a := range []struct {
		name, cookie, token string
		status              int
	}{
		{"member", "branch-read-member", "", 200}, {"app", "", app, 200}, {"external", "", external, 200}, {"run", "", run, 403}, {"machine", "", machine, 403}, {"scope", "", limited, 403}, {"anonymous", "", "", 401},
	} {
		t.Run(a.name, func(t *testing.T) {
			for _, selector := range []string{own.ID, own.TargetBookmark} {
				out := call(t, selector, a.cookie, a.token, a.status)
				if a.status == 200 {
					require.Contains(t, out.Body.String(), own.Name)
				} else {
					require.NotContains(t, out.Body.String(), own.Name)
				}
			}
		})
	}
	t.Run("private branches", func(t *testing.T) {
		call(t, own.ID, "branch-read-owner", "", 403)
		call(t, foreign.ID, "branch-read-member", "", 403)
		out := call(t, foreign.ID, "branch-read-owner", "", 200)
		require.Contains(t, out.Body.String(), foreign.Name)
	})
	t.Run("substituted actor", func(t *testing.T) {
		probe.actor = f.owner.ID
		defer func() { probe.actor = 0 }()
		call(t, own.ID, "branch-read-member", "", 403)
	})
	t.Run("substituted repository", func(t *testing.T) {
		probe.repository = f.repoID + 1
		defer func() { probe.repository = 0 }()
		call(t, own.ID, "branch-read-member", "", 403)
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
		out := call(t, own.ID, "branch-read-member", "", 401)
		require.NotContains(t, out.Body.String(), own.Name)
	})

	t.Run("expiry during projection suppresses the response", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, own.ID)
		require.NoError(t, err)
		deadline := time.Now().Add(4 * time.Second)
		_, err = f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=$2 WHERE session_key=$1`, hash, deadline)
		require.NoError(t, err)
		defer func() {
			probe.WorkspaceService = service
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, hash)
			require.NoError(t, err)
			_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, own.ID)
			require.NoError(t, err)
		}()
		// Only the ref reader is deliberately delayed. Membership, credential
		// expiry and the branch projection use the real one-connection SQL store.
		called := false
		heads := delayedBranchMetadataHead(func(ctx context.Context, _, _ string) ([]byte, error) {
			called = true
			timer := time.NewTimer(time.Until(deadline) + 25*time.Millisecond)
			defer timer.Stop()
			select {
			case <-timer.C:
				return []byte("0000"), nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
		probe.WorkspaceService = services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)), services.WithBranchHeads(heads))
		out := call(t, own.ID, "branch-read-member", "", 401)
		require.True(t, called)
		require.NotContains(t, out.Body.String(), own.Name)
	})
	t.Run("direct service authorization", func(t *testing.T) {
		_, err := service.GetBranch(f.ctx, own.ID, f.repoID, f.other.ID)
		require.Error(t, err)
		commands := []string{}
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.other, SessionHash: hash})
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		row, err := service.GetBranch(ctx, own.ID, f.repoID, f.other.ID)
		require.NoError(t, err)
		require.Equal(t, own.ID, row.Machine.ID)
		require.Equal(t, []string{"branch.read"}, commands)
	})
}
