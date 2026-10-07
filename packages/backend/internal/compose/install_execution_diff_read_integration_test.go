package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInstallExecutionDiffReadsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	storage := t.TempDir()
	engine, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "native-history", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := engine.Client()
	require.NoError(t, client.InitRepo(f.ctx, "gate-owner", "app", "main", false))
	seed := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(f.ctx, "git", args...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "--initial-branch=main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "history.txt"), []byte("Recorded repository content\n"), 0600))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Recorded revision")
	head := git("-C", seed, "rev-parse", "HEAD")
	git("-C", seed, "push", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "HEAD:refs/heads/main")
	require.NoError(t, client.ImportRefs(f.ctx, "gate-owner", "app"))

	base := head
	require.NoError(t, os.WriteFile(filepath.Join(seed, "diff.txt"), []byte("Private bound diff canary\n"), 0600))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Execution branch")
	head = git("-C", seed, "rev-parse", "HEAD")
	machineOwner, err := f.q.GetBranchMachineOwner(f.ctx)
	require.NoError(t, err)
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: machineOwner, Name: "file-read", Kind: "container", Status: "suspended", TargetBookmark: "smithers/file-read"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET vm_id='retained-files',head_commit_id=$2 WHERE id=$1`, ws.ID, head)
	require.NoError(t, err)
	git("-C", seed, "push", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "HEAD:"+repohost.BranchHeadRef(ws.ID))
	require.NoError(t, client.ImportRefs(f.ctx, "gate-owner", "app"))
	var itemID pgtype.UUID
	var number int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',1,'Execution files',$2,'file-run',$3,$3,1) RETURNING id,number`, f.repoID, ws.ID, f.owner.ID).Scan(&itemID, &number))
	_, _, err = f.q.BindMythicalLane(f.ctx, db.MythicalLane{RepositoryID: f.repoID, WorkspaceID: ws.ID, ItemID: itemID, Name: "file-read"})
	require.NoError(t, err)
	store := &accessNativeFileReads{Client: client}
	service := services.NewWorkspaceService(f.q, services.WithWorkspaceInstallAuthorization(f.q), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(f.q), nil)), services.WithBranchHeads(store))
	_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET base_commit=$2,candidate_base=$2,candidate_head=$3,candidate_verified=true,checks=jsonb_build_object('branch',$4::text) WHERE id=$1`, itemID, base, head, ws.TargetBookmark)
	require.NoError(t, err)
	todos := services.NewMythicalService(f.pool, store, services.WithMythicalInstallAuthorization(true))
	todos.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(service))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: service}, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}})
	cookie := "diff-member"
	hash := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	scopes := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(ws.ID) + "," + middleware.AgentSessionRestrictionScope("file-run")
	own := f.token(f.owner, "diff-run", scopes, true)
	machine := f.token(f.owner, "diff-machine", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID), true)
	for _, tc := range []struct {
		name, token, branch string
		status              int
	}{
		{"member", "", ws.ID, 200},
		{"external", f.token(f.other, "diff-external", "read:repository,via:codex", true), ws.ID, 200},
		{"app", f.token(f.other, "diff-app", "read:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true), ws.ID, 200},
		{"own run", own, ws.ID, 200},
		{"own machine", machine, ws.ID, 200},
		{"bookmark", own, url.PathEscape(ws.TargetBookmark), 200},
		{"other run", f.token(f.owner, "diff-other", strings.Replace(scopes, "file-run", "other-run", 1), true), ws.ID, 403},
		{"unbound", f.token(f.owner, "diff-unbound", "read:repository", true), ws.ID, 403},
		{"foreign workspace", own, "11111111-1111-4111-8111-111111111111", 403},
		{"main", own, "main", 403},
		{"historical", own, ws.ID + "/diff?at=" + base, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := "/api/branches/" + tc.branch + "/diff"
			if tc.name == "historical" {
				path = "/api/branches/" + tc.branch
			}
			req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
			if tc.token == "" {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			} else {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			var commands []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
			before := store.reads.Load()
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, tc.status, out.Code, out.Body.String())
			require.Equal(t, []string{"branch.read"}, commands)
			if tc.status == 200 {
				require.Contains(t, out.Body.String(), "Private bound diff canary")
				require.Contains(t, out.Body.String(), base)
			} else {
				require.Contains(t, out.Body.String(), `"code":"permission"`)
				require.NotContains(t, out.Body.String(), "Private bound diff canary")
				require.Equal(t, before, store.reads.Load())
			}
		})
	}
	t.Run("a file decision cannot be replayed as a diff", func(t *testing.T) {
		sum := sha256.Sum256([]byte(own))
		hash := hex.EncodeToString(sum[:])
		token, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: token.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		calls := 0
		ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(f.ctx, info), func(string) { calls++ })
		subject, err := services.InstallExecutionFileSubject(ctx, f.q, f.repoID, ws.ID)
		require.NoError(t, err)
		decision, err := services.Authorize(ctx, f.q, "branch.read", subject)
		require.NoError(t, err)
		before := store.reads.Load()
		_, err = todos.TODOBranchDiff(services.WithInstallAuthorization(ctx, "branch.read", decision, subject), ws.ID)
		var denied *services.AccessError
		require.ErrorAs(t, err, &denied)
		require.Equal(t, 403, denied.Status)
		require.Equal(t, 1, calls)
		require.Equal(t, before, store.reads.Load())
	})
	stored, err := f.q.GetWorkspace(f.ctx, ws.ID)
	require.NoError(t, err)
	require.Equal(t, "suspended", stored.Status)
	require.Equal(t, base, git("--git-dir", filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git"), "rev-parse", "refs/heads/main"))
}
