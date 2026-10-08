package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestConflictDoneAwakeNativeComposedInstall(t *testing.T) {
	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY") == "" {
		t.Skip("requires real rehearsal daemon")
	}
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
	base := commit("base\n")
	edited := commit("first\n")
	git("-C", source, "reset", "--hard", base)
	onto := commit("second\n")
	git("-C", store, "fetch", source, "main:refs/heads/main")
	git("-C", store, "fetch", source, edited)
	require.NoError(t, native.ImportGitRefs(repoPath))
	branchRef := repohost.BranchHeadRef(f.row.ID)
	git("-C", store, "update-ref", branchRef, edited)
	require.NoError(t, native.ImportGitRefs(repoPath))
	engine, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(engine.Handler(), cfg.AuthToken)
	client.BindMachineRepository(engine.WithMachineRepository)
	workspaces := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)), services.WithWorkspaceInstallAuthorization(q), services.WithBranchHeads(client))
	service := services.NewMythicalService(f.pool, client)
	signals := &conflictDoorProvider{}
	service.SetLauncher(signals)
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	bindConflictValidator(service, workspaces, registry.InspectConflict)
	item, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	digest := strings.Repeat("b", 64)
	tenant, principal := fmt.Sprintf("repository:%d", f.row.RepositoryID), fmt.Sprintf("user:%d", f.user.ID)
	checks := map[string]any{
		"todo": true, "run_launched": true, "run_attached": true, "flowSource": strings.Repeat("a", 40),
		"rebase":              map[string]any{"onto": onto, "name": "main"},
		"conflictReservation": map[string]any{"change": edited, "onto": onto, "run": "pinned-run", "limit": 1, "reserved": 1},
		"waits": []any{map[string]any{"id": "conflict-1", "kind": "conflict", "paths": []string{"a.txt"}, "conflict_change": edited, "onto_revision": onto,
			"signal": map[string]any{"flow": "todo", "run": "pinned-run", "name": "conflict", "scope": map[string]any{"tenantId": tenant, "principalId": principal},
				"target": map[string]any{"tenantId": tenant, "principalId": principal, "workspaceId": f.row.ID, "bindingKind": "mythical-item", "bindingId": fmt.Sprint(item.ID)}}}},
	}
	raw, err := json.Marshal(checks)
	require.NoError(t, err)
	integration, err := json.Marshal(map[string]any{"conflict": map[string]any{"head": edited, "onto": onto, "paths": []string{"a.txt"}}})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='running',attempt=1,flow_digest=$2,request_run_id='pinned-run',workspace_id=$3,checks=$4,integration=$5 WHERE id=$1`, item.ID, digest, f.row.ID, raw, integration)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, f.row.RepositoryID, base)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='running',vm_id='retained-machine',head_commit_id=$2 WHERE id=$1`, f.row.ID, edited)
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
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	require.NotEmpty(t, binary)
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	guest := t.TempDir()
	init := exec.CommandContext(ctx, jj, "git", "init", "--colocate", guest)
	output, err := init.CombinedOutput()
	require.NoError(t, err, string(output))
	git("-C", guest, "fetch", store, branchRef+":refs/heads/fixture", "refs/heads/main:refs/remotes/fixture/main")
	edit := exec.CommandContext(ctx, jj, "edit", edited)
	edit.Dir = guest
	output, err = edit.CombinedOutput()
	require.NoError(t, err, string(output))
	change := exec.CommandContext(ctx, jj, "log", "-r", "@", "--no-graph", "-T", "change_id")
	change.Dir = guest
	changeID, err := change.Output()
	require.NoError(t, err)
	registry.BindObjectImporter(machineObjectImporter(ctx, f.pool, client))
	stop, err := bindMachineEvents(ctx, registry, f.pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET vm_id=$1 WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	require.NoError(t, startRehearsalMachined(t, ctx, registry, f.row.ID, guest, t.TempDir(), binary, &machined.ItemBinding{Number: 1, Change: strings.TrimSpace(string(changeID))}))
	link, err := registry.Current(f.row.ID)
	require.NoError(t, err)
	actor, err := machined.CommitActor(ctx, f.pool, f.row.ID, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "web"}, nil
	})
	require.NoError(t, err)
	result, err := registry.Rebase(ctx, f.row.ID, actor, onto)
	require.NoError(t, err)
	require.True(t, result.Inspected)
	require.Equal(t, []string{"a.txt"}, result.Paths)
	checks["conflictReservation"].(map[string]any)["change"] = result.Head
	checks["waits"].([]any)[0].(map[string]any)["conflict_change"] = result.Head
	raw, err = json.Marshal(checks)
	require.NoError(t, err)
	integration, err = json.Marshal(map[string]any{"conflict": map[string]any{"head": result.Head, "onto": onto, "paths": result.Paths}})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET checks=$2,integration=$3 WHERE id=$1`, item.ID, raw, integration)
	require.NoError(t, err)
	call(409, "still_conflicted")
	require.Zero(t, signals.signals)
	require.NoError(t, os.WriteFile(filepath.Join(guest, "a.txt"), []byte("resolved\n"), 0600))
	call(202, "")
	call(202, "")
	require.Equal(t, 1, signals.signals)
}
