package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The composed HTTP door reads real native conflict objects from the retained
// branch. No guest is launched, no validator or repository dependency is mocked.
// Real awake microVM inspection still requires the Mac reference host.
func TestConflictDoneRetainedWorkingCopyComposedInstall(t *testing.T) {
	f := presenceInstall(t)
	q, ctx := db.New(f.pool), t.Context()
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "conflict-native"}
	repoPath := cfg.RepoPath("presence-owner", "app")
	_, err := native.InitRepo(repoPath)
	require.NoError(t, err)
	store := filepath.Join(repoPath, ".jj", "repo", "store", "git")
	git := func(args ...string) string {
		t.Helper()
		out, err := hostexec.Git(ctx, append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null"}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	source := t.TempDir()
	git("init", "--initial-branch=main", source)
	commit := func(text string) string {
		t.Helper()
		require.NoError(t, os.WriteFile(filepath.Join(source, "a.txt"), []byte(text), 0600))
		git("-C", source, "add", ".")
		git("-C", source, "commit", "-m", text)
		return git("-C", source, "rev-parse", "HEAD")
	}
	commit("base\n")
	edited := commit("first\n")
	onto := commit("second\n")
	git("-C", store, "fetch", source, "main:refs/heads/main")
	require.NoError(t, native.ImportGitRefs(repoPath))
	original, err := native.GetChange(repoPath, edited)
	require.NoError(t, err)
	conflict, err := native.BackoutChange(repoPath, original.ChangeID, edited, "main", "")
	require.NoError(t, err)
	require.True(t, conflict.HasConflict)
	unresolved, err := native.GetConflicts(repoPath, conflict.CommitID)
	require.NoError(t, err)
	require.Len(t, unresolved, 1)
	require.Equal(t, "a.txt", unresolved[0].FilePath)
	branchRef := repohost.BranchHeadRef(f.row.ID)
	git("-C", store, "update-ref", branchRef, conflict.CommitID)
	require.NoError(t, native.ImportGitRefs(repoPath))
	engine, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(engine.Handler(), cfg.AuthToken)
	workspaces := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)), services.WithWorkspaceInstallAuthorization(q), services.WithBranchHeads(client))
	service := services.NewMythicalService(f.pool, nil)
	signals := &conflictDoorProvider{}
	service.SetLauncher(signals)
	inspections := 0
	bindConflictValidator(service, workspaces, func(context.Context, string, string, string) ([]string, error) {
		inspections++
		return nil, fmt.Errorf("guest inspection sentinel")
	})
	item, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	digest := strings.Repeat("b", 64)
	tenant, principal := fmt.Sprintf("repository:%d", f.row.RepositoryID), fmt.Sprintf("user:%d", f.user.ID)
	checks := map[string]any{
		"todo": true, "run_launched": true, "run_attached": true, "flowSource": strings.Repeat("a", 40),
		"rebase":              map[string]any{"onto": onto, "name": "main"},
		"conflictReservation": map[string]any{"change": conflict.CommitID, "onto": onto, "run": "pinned-run", "limit": 1, "reserved": 1},
		"waits": []any{map[string]any{"id": "conflict-1", "kind": "conflict", "paths": []string{"a.txt"}, "conflict_change": conflict.CommitID, "onto_revision": onto,
			"signal": map[string]any{"flow": "todo", "run": "pinned-run", "name": "conflict", "scope": map[string]any{"tenantId": tenant, "principalId": principal},
				"target": map[string]any{"tenantId": tenant, "principalId": principal, "workspaceId": f.row.ID, "bindingKind": "mythical-item", "bindingId": fmt.Sprint(item.ID)}}}},
	}
	raw, err := json.Marshal(checks)
	require.NoError(t, err)
	integration, err := json.Marshal(map[string]any{"conflict": map[string]any{"head": conflict.CommitID, "onto": onto, "paths": []string{"a.txt"}}})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=1,flow_digest=$2,request_run_id='pinned-run',workspace_id=$3,checks=$4,integration=$5 WHERE id=$1`, item.ID, digest, f.row.ID, raw, integration)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, f.row.RepositoryID, onto)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='suspended',vm_id='retained-machine',head_commit_id=$2 WHERE id=$1`, f.row.ID, conflict.CommitID)
	require.NoError(t, err)
	httpCfg := testConfigAllFlagsOn()
	httpCfg.Auth.Mode, httpCfg.Auth.SessionCookieName = "selfhost", "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	httpCfg.Server.PublicURL, httpCfg.Server.AllowedOrigins = origin, []string{origin}
	server.Config.Handler = todoMergeComposeRouter(httpCfg, q, f.pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	call := func(expected int, code string) {
		t.Helper()
		req, err := http.NewRequest("POST", origin+"/api/todos/1/answer", strings.NewReader(`{"wait":"conflict-1","answer":"done"}`))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		require.Equal(t, expected, res.StatusCode, body)
		if code != "" {
			require.Equal(t, code, body["code"])
		}
	}
	call(409, "still_conflicted")
	retained, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(raw), string(retained.Checks))
	require.JSONEq(t, string(integration), string(retained.Integration))
	require.Zero(t, signals.signals)
	// An awake branch must never substitute even a verified retained snapshot
	// for its daemon, and an absent retained ref must fail closed.
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	call(503, "conflict_validation_unavailable")
	require.Equal(t, 1, inspections)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	git("-C", store, "update-ref", "-d", branchRef)
	call(503, "conflict_validation_unavailable")
	git("-C", store, "update-ref", branchRef, conflict.CommitID)
	require.Zero(t, signals.signals)
	// A clean unrelated retained head must never settle the conflict.
	git("-C", store, "update-ref", branchRef, onto)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, f.row.ID, onto)
	require.NoError(t, err)
	call(503, "conflict_validation_unavailable")
	require.Zero(t, signals.signals)
	// Resolve the captured working-copy tree, preserving the conflict's ancestry.
	tree := git("-C", store, "rev-parse", onto+"^{tree}")
	resolved := git("-C", store, "commit-tree", tree, "-p", conflict.CommitID, "-m", "Resolved")
	git("-C", store, "update-ref", branchRef, resolved)
	require.NoError(t, native.ImportGitRefs(repoPath))
	clean, err := native.GetConflicts(repoPath, resolved)
	require.NoError(t, err)
	require.Empty(t, clean)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, f.row.ID, resolved)
	require.NoError(t, err)
	call(202, "")
	call(202, "")
	require.Equal(t, 1, signals.signals)
	require.Equal(t, 1, inspections, "only the explicitly awake request enters the guest")
}
