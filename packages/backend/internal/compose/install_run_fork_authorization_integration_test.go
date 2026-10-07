package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// No guest executes in this Linux test. The existing workspace adapter persists
// its machine request, while native repository storage publishes the real fork.
// MicroVM startup and Mac installation qualification remain separate checks.
type forkAdmissionRuntime struct{ workspaceapi.WorkspaceRuntime }

func (*forkAdmissionRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (*forkAdmissionRuntime) GuestIdentity() (string, int) { return "agent", 19999 }

func TestInstallRunForkAuthorizationPostgres(t *testing.T) {
	testInstallRunForkAuthorizationPostgres(t)
}

func testInstallRunForkAuthorizationPostgres(t *testing.T) map[string]any {
	configureNativeInstallFixture(t)
	t.Setenv("TMPDIR", t.TempDir())
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	storage := t.TempDir()
	engine, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "fork-native", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := engine.Client()
	require.NoError(t, client.InitRepo(f.ctx, "gate-owner", "app", "main", false))
	seed := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		c := exec.CommandContext(f.ctx, "git", args...)
		c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := c.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "--initial-branch=main", seed)
	require.NoError(t, os.WriteFile(filepath.Join(seed, "proof.txt"), []byte("Fork retains this revision\n"), 0600))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Verified source")
	head := git("-C", seed, "rev-parse", "HEAD")
	hostGit := filepath.Join(storage, "gate-owner", "app", ".jj/repo/store/git")
	// Seed the source mirror and its verified retention ref. The request below
	// uses only the production native transport and may never move main.
	git("-C", seed, "push", hostGit, "HEAD:refs/heads/main", "HEAD:"+repohost.MythicalReservedRefNS+"keep/"+head)
	require.NoError(t, client.ImportRefs(f.ctx, "gate-owner", "app"))
	source, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: "run-source", Kind: "container", Status: "stopped", TargetBookmark: "smithers/own"})
	require.NoError(t, err)
	var number int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt,candidate_head,candidate_base,candidate_verified) VALUES($1,'todo','proposed',1,'Own execution',$2,'fork-run',$3,$3,1,$4,$4,true) RETURNING number`, f.repoID, source.ID, f.owner.ID, head).Scan(&number))
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(f.q), &forkAdmissionRuntime{})
	workspaces := services.NewWorkspaceService(f.q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(providers))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, workspaces.WaitForProvisioning(ctx))
	})
	forks := services.NewMythicalService(f.pool, client, services.WithMythicalInstallAuthorization(true))
	forks.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(workspaces))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: forks}}, &routes.WorkspaceHandler{Service: workspaces})
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(source.ID) + "," + middleware.AgentSessionRestrictionScope("fork-run")
	run := f.token(f.owner, "fork-own-run", scopes, true)
	reader := f.token(f.owner, "fork-reader", strings.Replace(scopes, "write:repository", "read:repository", 1), true)
	unbound := f.token(f.owner, "fork-unbound", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID), true)
	other := f.token(f.owner, "fork-other-run", strings.Replace(scopes, "fork-run", "other-run", 1), true)
	machine := f.token(f.owner, "fork-machine", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(source.ID), true)
	call := func(t *testing.T, token, from, key string, status int) services.BranchMachineResponse {
		t.Helper()
		raw, _ := json.Marshal(services.BranchForkInput{From: from, Name: "run-proof"})
		req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/branches", strings.NewReader(string(raw)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"branch.fork"}, decisions)
		if status != 201 {
			require.Contains(t, out.Body.String(), `"code":"permission"`)
			return services.BranchMachineResponse{}
		}
		var branch services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &branch))
		return branch
	}
	from := fmt.Sprintf("T%d", number)
	for _, row := range []struct{ name, token, from string }{{"read only", reader, from}, {"unbound", unbound, from}, {"other run", other, from}, {"machine", machine, from}, {"main", run, "main"}, {"other TODO", run, fmt.Sprintf("T%d", number+1)}} {
		t.Run(row.name, func(t *testing.T) { call(t, row.token, row.from, "denied-"+row.name, 403) })
	}
	var count int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workspaces WHERE is_fork`).Scan(&count))
	require.Zero(t, count)
	t.Run("own TODO forks and replays", func(t *testing.T) {
		first := call(t, run, from, "own-fork", 201)
		require.Equal(t, head, first.Head)
		require.Equal(t, "scratch/gate-owner/run-proof", first.Name)
		require.NotNil(t, first.ForkedFrom)
		require.Equal(t, number, first.ForkedFrom.Item)
		require.Equal(t, head, git("--git-dir", hostGit, "rev-parse", "refs/heads/"+first.Name))
		second := call(t, run, from, "own-fork", 201)
		require.Equal(t, first.Machine.ID, second.Machine.ID)
		_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$3 WHERE repository_id=$1 AND number=$2`, f.repoID, number, f.other.ID)
		require.NoError(t, err)
		call(t, run, from, "own-fork", 403)
	})

	t.Run("fresh member sponsor can fork", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$3,request_run_id='takeover-run' WHERE repository_id=$1 AND number=$2`, f.repoID, number, f.other.ID)
		require.NoError(t, err)
		fresh := f.token(f.other, "fork-new-sponsor", strings.Replace(scopes, "fork-run", "takeover-run", 1), true)
		forked := call(t, fresh, from, "fresh-fork", 201)
		require.Equal(t, "scratch/"+f.other.Username+"/run-proof", forked.Name)
		require.Equal(t, head, git("--git-dir", hostGit, "rev-parse", "refs/heads/"+forked.Name))
		call(t, run, from, "own-fork", 403)
	})
	for _, mutation := range []struct{ name, sql string }{
		{"sponsor", fmt.Sprintf(`UPDATE mythical_items SET owner_id=%d WHERE repository_id=$1 AND number=$2`, f.other.ID)},
		{"run", `UPDATE mythical_items SET request_run_id='replacement-run' WHERE repository_id=$1 AND number=$2`},
		{"workspace", `UPDATE mythical_items SET workspace_id='' WHERE repository_id=$1 AND number=$2`},
	} {
		t.Run("changed after admission/"+mutation.name, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$3,request_run_id='fork-run',workspace_id=$4 WHERE repository_id=$1 AND number=$2`, f.repoID, number, f.owner.ID, source.ID)
			require.NoError(t, err)
			sum := sha256.Sum256([]byte(run))
			hash := hex.EncodeToString(sum[:])
			token, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
			require.NoError(t, err)
			info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: token.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
			ctx := middleware.ContextWithAuthInfo(f.ctx, info)
			decisions := 0
			ctx = services.WithAuthorizationObserver(ctx, func(string) { decisions++ })
			input := services.BranchForkInput{From: from, Name: "run-proof", Request: "own-fork"}
			subject := services.InstallBranchForkSubject(ctx, f.repoID, input)
			decision, err := services.Authorize(ctx, f.q, "branch.fork", subject)
			require.NoError(t, err)
			ctx = services.WithInstallAuthorization(ctx, "branch.fork", decision, subject)
			_, err = f.pool.Exec(f.ctx, mutation.sql, f.repoID, number)
			require.NoError(t, err)
			result, err := forks.ForkBranch(ctx, f.repoID, f.owner.ID, input)
			var refused *services.AccessError
			require.ErrorAs(t, err, &refused)
			require.Equal(t, 403, refused.Status)
			require.Empty(t, result.Machine.ID)
			require.Equal(t, 1, decisions)
		})
	}

	t.Run("credential expires after admission", func(t *testing.T) {
		_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET owner_id=$3,request_run_id='fork-run',workspace_id=$4 WHERE repository_id=$1 AND number=$2`, f.repoID, number, f.owner.ID, source.ID)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte(run))
		hash := hex.EncodeToString(sum[:])
		token, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		info := &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: token.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}
		ctx := middleware.ContextWithAuthInfo(f.ctx, info)
		decisions := 0
		ctx = services.WithAuthorizationObserver(ctx, func(string) { decisions++ })
		input := services.BranchForkInput{From: from, Name: "run-proof", Request: "own-fork"}
		subject := services.InstallBranchForkSubject(ctx, f.repoID, input)
		decision, err := services.Authorize(ctx, f.q, "branch.fork", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "branch.fork", decision, subject)
		_, err = f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 minute' WHERE id=$1`, token.TokenID)
		require.NoError(t, err)
		result, err := forks.ForkBranch(ctx, f.repoID, f.owner.ID, input)
		var refused *services.AccessError
		require.ErrorAs(t, err, &refused)
		require.Equal(t, 401, refused.Status)
		require.Empty(t, result.Machine.ID)
		require.Equal(t, 1, decisions)
	})
	require.Equal(t, head, git("--git-dir", hostGit, "rev-parse", "refs/heads/main"))
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM workspaces WHERE is_fork`).Scan(&count))
	require.Equal(t, 2, count)
	sum := sha256.Sum256([]byte(run))
	return map[string]any{"credential_hash": hex.EncodeToString(sum[:]), "todo": number, "workspace": source.ID, "run": "fork-run", "attempt": 1}
}
