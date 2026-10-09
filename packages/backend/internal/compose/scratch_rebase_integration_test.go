package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestScratchRebaseCardComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "app-card")
}

func TestScratchRebaseNativeComposedInstall(t *testing.T) { testScratchRebaseComposed(t, false, false) }
func TestScratchRebaseConflictDoneComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, true, false)
}
func TestScratchRebaseConflictCardComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, true, false, "conflict-card")
}

func TestScratchRebaseConflictRestartComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, true, false, "restart")
}
func TestScratchRebaseConflictMovedTargetComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, true, false, "conflict-moved")
}
func TestScratchRebaseAsleepComposedInstall(t *testing.T) { testScratchRebaseComposed(t, false, true) }
func TestScratchRebaseAsleepConflictMaterializationComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, true, true)
}

func TestScratchRebaseFromScratchSourceComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "scratch-source")
}

func TestScratchRebaseFromScratchSourceAsleepComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, true, "scratch-source")
}

func TestScratchRebaseRevokedRequesterComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "revoked")
}

func TestScratchRebaseMovedTargetComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "moved-target")
}

func TestScratchRebaseBusyWriterComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "busy")
}
func TestScratchRebaseBusyWriterCapturedEditComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "busy", "busy-edit")
}
func TestScratchRebaseBusyWriterCapturedSleepComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "busy", "busy-edit", "busy-sleep")
}
func TestScratchRebaseTwiceComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "twice")
}
func TestScratchRebaseMovedAfterNativeRewriteComposedInstall(t *testing.T) {
	testScratchRebaseComposed(t, false, false, "moved-after-native")
}

// The refusal models the guest kernel freeze budget unavailable on this host.
// Admission, retained request, following rewrite and publication are real.
type scratchBusyRebase struct {
	machineRebase
	busy  atomic.Bool
	calls atomic.Int32
}

func (r *scratchBusyRebase) Rebase(ctx context.Context, branch string, member int64, onto, base string, admit func(pgx.Tx) error, guard func(func() error) error) (machined.RewriteResult, error) {
	r.calls.Add(1)
	if r.busy.Swap(false) {
		return machined.RewriteResult{}, &machined.SessionError{Code: "busy", Session: 1}
	}
	return r.machineRebase.Rebase(ctx, branch, member, onto, base, admit, guard)
}

func testScratchRebaseComposed(t *testing.T, conflict, asleep bool, options ...string) {
	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY") == "" {
		t.Skip("requires real rehearsal daemon")
	}
	t.Setenv("TMPDIR", t.TempDir())
	f := presenceInstall(t)
	ctx, q := t.Context(), db.New(f.pool)
	// The presence fixture's unrelated TODO is removed before any operation.
	// Scratch has no item, lane, attempt, flow pin or coding run.
	_, err := f.pool.Exec(ctx, `DELETE FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID)
	require.NoError(t, err)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "scratch-native"}
	repoPath := cfg.RepoPath("presence-owner", "app")
	_, err = native.InitRepo(repoPath)
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
	commit := func(message string) string {
		t.Helper()
		git("-C", source, "add", ".")
		git("-C", source, "commit", "-m", message)
		return git("-C", source, "rev-parse", "HEAD")
	}
	require.NoError(t, os.WriteFile(filepath.Join(source, "a.txt"), []byte("fork tip\n"), 0600))
	base := commit("Fork tip")
	require.NoError(t, os.WriteFile(filepath.Join(source, "a.txt"), []byte("scratch first edit\n"), 0600))
	first := commit("First Scratch capture")
	require.NoError(t, os.WriteFile(filepath.Join(source, "later.txt"), []byte("scratch later edit\n"), 0600))
	before := commit("Later Scratch capture")
	git("-C", source, "reset", "--hard", base)
	require.NoError(t, os.WriteFile(filepath.Join(source, "source.txt"), []byte("source new bytes\n"), 0600))
	if conflict {
		require.NoError(t, os.WriteFile(filepath.Join(source, "a.txt"), []byte("source changed\n"), 0600))
	}
	onto := commit("Source moved")
	git("-C", store, "fetch", source, "main:refs/heads/main")
	main, sourceName := onto, "main"
	if slices.Contains(options, "scratch-source") {
		parent, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Name: "source", TargetBookmark: "scratch/presence-owner/source", Kind: "vm", Status: "suspended"})
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `UPDATE workspaces SET parent_workspace_id=$2 WHERE id=$1`, f.row.ID, parent.ID)
		require.NoError(t, err)
		git("-C", store, "update-ref", repohost.BranchHeadRef(parent.ID), onto)
		git("-C", store, "update-ref", "refs/heads/main", base)
		main, sourceName = base, parent.TargetBookmark
	}
	git("-C", store, "fetch", source, before)
	branch := f.row.TargetBookmark
	git("-C", store, "update-ref", "refs/heads/"+branch, before)
	git("-C", store, "update-ref", repohost.BranchHeadRef(f.row.ID), before)
	git("-C", store, "update-ref", repohost.WorkspaceSourceRef(f.row.ID, base), base)
	require.NoError(t, native.ImportGitRefs(repoPath))
	engine, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(engine.Handler(), cfg.AuthToken)
	client.BindMachineRepository(engine.WithMachineRepository)
	service := services.NewMythicalService(f.pool, client, services.WithMythicalInstallAuthorization(true))
	service.SetPolicyReader(noPolicy{})
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state='bootstrapping' WHERE repository_id=$1`, f.row.RepositoryID)
	require.NoError(t, err)
	_, err = service.RequestBootstrap(ctx, f.row.RepositoryID, f.user.ID, 100, false)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(ctx))
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,source_commit=$2,forked_from_base=$2,head_commit_id=$3,vm_id=id::text,status=$4 WHERE id=$1`, f.row.ID, base, before, map[bool]string{true: "suspended", false: "running"}[asleep])
	require.NoError(t, err)
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	t.Cleanup(bindMachineObjects(ctx, registry, f.pool, client))
	stop, err := bindMachineEvents(ctx, registry, f.pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	runtimeBase, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtimeBase.Close()) })
	_, err = runtimeBase.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: f.row.ID})
	require.NoError(t, err)
	observed, err := runtimeBase.StartWorkspace(ctx, f.row.ID)
	require.NoError(t, err)
	guest := observed.Root
	init := exec.CommandContext(ctx, jj, "git", "init", "--colocate", guest)
	out, err := init.CombinedOutput()
	require.NoError(t, err, string(out))
	git("-C", guest, "fetch", store, repohost.BranchHeadRef(f.row.ID)+":refs/heads/fixture")
	edit := exec.CommandContext(ctx, jj, "edit", before)
	edit.Dir = guest
	out, err = edit.CombinedOutput()
	require.NoError(t, err, string(out))
	descendant := exec.CommandContext(ctx, jj, "new", "-r", "@")
	descendant.Dir = guest
	out, err = descendant.CombinedOutput()
	require.NoError(t, err, string(out))
	evidence := t.TempDir()
	runtime := bindingProcessRuntime{rehearsalAdmissionRuntime: &rehearsalAdmissionRuntime{Runtime: runtimeBase}, t: t, daemons: registry, daemonStops: new(sync.Map), pool: f.pool, repository: client, evidence: evidence, daemonBinary: os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")}
	if !asleep {
		require.NoError(t, runtime.ensureDaemon(ctx, f.row.ID, guest))
	}
	launcher := new(rebaseRecordedLauncher)
	workspaces := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)), services.WithWorkspaceInstallAuthorization(q), services.WithBranchHeads(client), services.WithWorkspaceRuntime(runtime))
	service.SetOrchestration(nil, launcher, services.NewWorkspaceMythicalLanes(workspaces))
	service.SetBranchRebaseExecutor(machineRebase{registry: registry, pool: f.pool})
	var busyExecutor *scratchBusyRebase
	if slices.Contains(options, "busy") {
		executor := &scratchBusyRebase{machineRebase: machineRebase{registry: registry, pool: f.pool}}
		busyExecutor = executor
		executor.busy.Store(true)
		service.SetBranchRebaseExecutor(executor)
	}
	service.SetRebasePresence(func(context.Context, int64, string) (services.RebasePresence, error) {
		return services.RebasePresenceEmpty, nil
	})
	f.p.branches = workspaces
	cfgHTTP := testConfigAllFlagsOn()
	cfgHTTP.Auth.Mode, cfgHTTP.Auth.SessionCookieName = "selfhost", "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfgHTTP.Server.PublicURL, cfgHTTP.Server.AllowedOrigins = origin, []string{origin}
	topics := &liveTopics{changePool: f.pool, queries: q, presence: f.p, todos: service}
	channel := &routes.LiveHandler{Queries: q, Hub: live.NewHub(ctx, nil), Origins: func() []string { return cfgHTTP.Server.AllowedOrigins }, Topics: topics.resolver, Presence: f.p.session}
	server.Config.Handler = githubAppSetupComposeRouter(cfgHTTP, f.pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: f.pool}, Owners: q, Roster: q, Origins: func() []string { return cfgHTTP.Server.AllowedOrigins }}, &routes.WorkspaceHandler{Service: workspaces}, routerExtras{Mythical: &routes.MythicalHandler{Service: service}, Live: channel})
	server.Start()
	t.Cleanup(server.Close)
	request := func(method, path, key string, body any, status int) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, err := http.NewRequest(method, origin+path, bytes.NewReader(raw))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		var data map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&data))
		require.Equal(t, status, response.StatusCode, data)
		return data
	}
	branchPath := "/api/branches/" + url.PathEscape(branch)
	receiptKey := "scratch-rebase"
	initial := request("GET", branchPath, "", nil, 200)
	require.Equal(t, map[string]any{"state": "pending", "onto": sourceName}, initial["rebase"], "the real Branch card exposes Rebase now before admission")
	runCard := func(mode string) string {
		script, err := filepath.Abs("../../../../apps/app/e2e/real/branch-card-install.fixture.tsx")
		require.NoError(t, err)
		command := exec.CommandContext(ctx, "bun", "run", script)
		command.Env = append(os.Environ(), "SMITHERS_BRANCH_CARD_ORIGIN="+origin, "SMITHERS_BRANCH_CARD_ID="+f.row.ID,
			"SMITHERS_BRANCH_CARD_SUBJECT="+branch, "SMITHERS_BRANCH_CARD_REBASE="+mode, "SMITHERS_BRANCH_CARD_COOKIE=session="+f.cookie, "SMITHERS_BRANCH_CARD_LOGIN=presence-owner")
		var output bytes.Buffer
		cardKey := ""
		command.Stdout, command.Stderr = &output, &output
		require.NoError(t, command.Start())
		finished := make(chan error, 1)
		go func() { finished <- command.Wait() }()
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		timeout := time.NewTimer(30 * time.Second)
		defer timeout.Stop()
		observed := false
		for !observed {
			select {
			case err := <-finished:
				require.NoError(t, err, output.String())
				for _, line := range strings.Split(output.String(), "\n") {
					if key, ok := strings.CutPrefix(line, "REBASE_CARD_REQUEST="); ok {
						cardKey = key
					}
				}
				require.NotEmpty(t, cardKey, output.String())
				observed = true
			case <-ticker.C:
				_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
				require.NoError(t, err)
				require.NoError(t, service.PollOnce(ctx))
			case <-timeout.C:
				_ = command.Process.Kill()
				<-finished
				t.Fatal("mounted scratch Rebase timed out", output.String())
			}
		}
		t.Log(output.String())
		return cardKey
	}
	if slices.Contains(options, "app-card") {
		receiptKey = runCard("1")
	}
	receipt := request("POST", branchPath, receiptKey, map[string]bool{"rebase": true}, 202)
	require.Equal(t, f.row.ID, receipt["branch"])
	require.Equal(t, onto, receipt["onto"])
	require.NotContains(t, receipt, "n")
	require.Equal(t, receipt, request("POST", branchPath, receiptKey, map[string]bool{"rebase": true}, 202))
	if slices.Contains(options, "busy") {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		require.NoError(t, service.PollOnce(ctx))
		var phase string
		var outages int32
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT authorization_context->'scratch_rebase'->>'phase' FROM product_job_requests WHERE operation='branch.rebase-requested' AND principal_id=$1`, "branch:"+f.row.ID).Scan(&phase))
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT attempts FROM mythical_stacks WHERE repository_id=$1`, f.row.RepositoryID).Scan(&outages))
		require.Equal(t, "requested", phase)
		require.Zero(t, outages, "a busy writer retains the request without a stack outage")
		require.Equal(t, before, git("-C", store, "rev-parse", "refs/heads/"+branch))
		require.Equal(t, receipt, request("POST", branchPath, receiptKey, map[string]bool{"rebase": true}, 202))
		if slices.Contains(options, "busy-edit") {
			current, err := registry.ReadFile(ctx, f.row.ID, "later.txt", "")
			require.NoError(t, err)
			link, err := registry.Current(f.row.ID)
			require.NoError(t, err)
			actor, err := machined.CommitActor(ctx, f.pool, f.row.ID, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
				return machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "web"}, nil
			})
			require.NoError(t, err)
			written, err := registry.WriteFiles(ctx, f.row.ID, actor, []machined.FileChange{{Path: "later.txt", BaseDigest: &current.Digest, Content: []byte("edit while writer blocks rebase\n")}})
			require.NoError(t, err)
			require.Len(t, written.Applied, 1)
			var capture machined.CaptureResult
			require.Eventually(t, func() bool {
				capture, err = registry.Capture(ctx, f.row.ID)
				return err == nil
			}, 5*time.Second, 25*time.Millisecond)
			require.NotEqual(t, before, capture.Head)
			if slices.Contains(options, "busy-sleep") {
				_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, f.row.ID)
				require.NoError(t, err)
			}
		}
	}
	if slices.Contains(options, "revoked") || slices.Contains(options, "moved-target") {
		if slices.Contains(options, "revoked") {
			_, err = f.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE user_id=$1`, f.user.ID)
			require.NoError(t, err)
		} else {
			require.NoError(t, os.WriteFile(filepath.Join(source, "newer-main.txt"), []byte("newer target\n"), 0600))
			main = commit("Target moved after admission")
			git("-C", store, "fetch", source, "main:refs/heads/main")
			require.NoError(t, native.ImportGitRefs(repoPath))
		}
		for range 3 {
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
		}
		var phase string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT authorization_context->'scratch_rebase'->>'phase' FROM product_job_requests WHERE operation='branch.rebase-requested' AND principal_id=$1`, "branch:"+f.row.ID).Scan(&phase))
		require.Equal(t, "failed", phase)
		require.Equal(t, before, git("-C", store, "rev-parse", "refs/heads/"+branch))
		require.Equal(t, main, git("-C", store, "rev-parse", "refs/heads/main"))
		require.Empty(t, launcher.requests)
		require.Empty(t, launcher.signals)
		if slices.Contains(options, "busy-sleep") {
			require.Equal(t, int32(1), busyExecutor.calls.Load(), "asleep continuation never invokes native rewrite or wakes the daemon")
		}
		return
	}
	if slices.Contains(options, "moved-after-native") {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		require.NoError(t, service.PollOnce(ctx))
		var phase string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT authorization_context->'scratch_rebase'->>'phase' FROM product_job_requests WHERE operation='branch.rebase-requested' AND principal_id=$1`, "branch:"+f.row.ID).Scan(&phase))
		require.Equal(t, "prepared", phase)
		require.NoError(t, os.WriteFile(filepath.Join(source, "source.txt"), []byte("source latest bytes\n"), 0600))
		newOnto := commit("Source changes before publication")
		git("-C", store, "fetch", source, "main:refs/heads/main")
		require.NoError(t, native.ImportGitRefs(repoPath))
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		require.NoError(t, service.PollOnce(ctx))
		failed := request("GET", branchPath+"?rebase_request=scratch-rebase", "", nil, 200)
		require.Equal(t, map[string]any{"onto": onto, "state": "failed"}, failed["rebase_execution"])
		require.Equal(t, before, git("-C", store, "rev-parse", "refs/heads/"+branch))
		receiptKey = "scratch-native-recovery"
		accepted := request("POST", branchPath, receiptKey, map[string]bool{"rebase": true}, 202)
		require.Equal(t, newOnto, accepted["onto"])
		onto, main = newOnto, newOnto
	}
	for range 3 {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		require.NoError(t, service.PollOnce(ctx))
	}
	if asleep && conflict {
		parked := request("GET", branchPath, "", nil, 200)["rebase"].(map[string]any)
		require.Equal(t, "conflict", parked["state"])
		require.Equal(t, []any{"a.txt"}, parked["paths"])
		require.NotContains(t, parked, "conflict_change", "host markers cannot authorize native Done")
		require.Empty(t, registry.ConnectedBranches(), "data-only conflict never starts a daemon")
		// Model the existing Wake service's running state. Rebase admission,
		// native materialization and Done still enter the production HTTP door;
		// this fixture does not qualify a physical guest launch or public Wake.
		_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, f.row.ID)
		require.NoError(t, err)
		require.NoError(t, runtime.ensureDaemon(ctx, f.row.ID, guest))
		for range 3 {
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
		}
	}
	resolveScratch := func() {
		current, err := registry.ReadFile(ctx, f.row.ID, "a.txt", "")
		require.NoError(t, err)
		link, err := registry.Current(f.row.ID)
		require.NoError(t, err)
		actor, err := machined.CommitActor(ctx, f.pool, f.row.ID, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
			return machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "web"}, nil
		})
		require.NoError(t, err)
		result, err := registry.WriteFiles(ctx, f.row.ID, actor, []machined.FileChange{{Path: "a.txt", BaseDigest: &current.Digest, Content: []byte("scratch and source resolved\n")}})
		require.NoError(t, err)
		require.Len(t, result.Applied, 1)
	}
	if conflict {
		card := request("GET", branchPath, "", nil, 200)
		rebase := card["rebase"].(map[string]any)
		require.Equal(t, "conflict", rebase["state"])
		require.Equal(t, []any{"a.txt"}, rebase["paths"])
		change := rebase["conflict_change"].(string)
		require.Equal(t, onto, rebase["onto_revision"])
		if slices.Contains(options, "restart") {
			_, hasState := runtime.daemonStates.Load(f.row.ID)
			require.True(t, hasState, "restart retains the original native journal")
			retained, err := machineRetainedConflict(ctx, f.pool, f.row.ID)
			require.NoError(t, err)
			require.Equal(t, &machined.RetainedConflict{Change: change, Onto: onto}, retained)
			if done, exists := runtime.daemonStops.LoadAndDelete(f.row.ID); exists {
				done.(func())()
			}
			require.NoError(t, registry.Close())
			stop()
			registry = new(machined.Registry)
			t.Cleanup(func() { require.NoError(t, registry.Close()) })
			t.Cleanup(bindMachineObjects(ctx, registry, f.pool, client))
			stop, err = bindMachineEvents(ctx, registry, f.pool, client, nil, nil)
			require.NoError(t, err)
			t.Cleanup(stop)
			runtime.daemons = registry
			require.NoError(t, runtime.ensureDaemon(ctx, f.row.ID, guest))
			service.SetBranchRebaseExecutor(machineRebase{registry: registry, pool: f.pool})
			workspaces = services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)), services.WithWorkspaceInstallAuthorization(q), services.WithBranchHeads(client), services.WithWorkspaceRuntime(runtime))
			service.SetOrchestration(nil, launcher, services.NewWorkspaceMythicalLanes(workspaces))
			// Recompose the same authenticated router against retained data.
			server.Config.Handler = githubAppSetupComposeRouter(cfgHTTP, f.pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: f.pool}, Owners: q, Roster: q, Origins: func() []string { return cfgHTTP.Server.AllowedOrigins }}, &routes.WorkspaceHandler{Service: workspaces}, routerExtras{Mythical: &routes.MythicalHandler{Service: service}})
			reopened := request("GET", branchPath, "", nil, 200)
			require.Equal(t, rebase, reopened["rebase"])
		}
		for range 10 {
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
		}
		if slices.Contains(options, "conflict-moved") {
			require.NoError(t, os.WriteFile(filepath.Join(source, "source.txt"), []byte("source latest bytes\n"), 0600))
			newOnto := commit("Conflict source moves again")
			git("-C", store, "fetch", source, "main:refs/heads/main")
			require.NoError(t, native.ImportGitRefs(repoPath))
			staleTarget := request("POST", branchPath, "scratch-old-target-done", map[string]string{"conflict_change": change, "onto_revision": onto}, 409)
			require.Equal(t, "stale_conflict", staleTarget["code"])
			require.Equal(t, rebase, request("GET", branchPath, "", nil, 200)["rebase"], "stale Done changes neither head nor paths")
			paths, err := registry.InspectConflict(ctx, f.row.ID, change, onto)
			require.NoError(t, err)
			require.Equal(t, []string{"a.txt"}, paths)
			refused := request("POST", branchPath, "scratch-new-target", map[string]bool{"rebase": true}, 409)
			require.Equal(t, "still_conflicted", refused["code"])
			require.Equal(t, rebase, request("GET", branchPath, "", nil, 200)["rebase"])
			resolveScratch()
			receiptKey = "scratch-new-target"
			newReceipt := request("POST", branchPath, receiptKey, map[string]bool{"rebase": true}, 202)
			require.Equal(t, newOnto, newReceipt["onto"])
			for range 3 {
				_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
				require.NoError(t, err)
				require.NoError(t, service.PollOnce(ctx))
			}
			onto, main = newOnto, newOnto
			oldReceipt := request("POST", branchPath, "scratch-rebase", map[string]bool{"rebase": true}, 202)
			require.Equal(t, receipt, oldReceipt, "old-key replay cannot overwrite the fresh target")
		}
		if !slices.Contains(options, "conflict-moved") {
			stale := request("POST", branchPath, "scratch-done-stale", map[string]string{"conflict_change": first, "onto_revision": onto}, 409)
			require.Equal(t, "stale_conflict", stale["code"])
			remaining := request("POST", branchPath, "scratch-done", map[string]string{"conflict_change": change, "onto_revision": onto}, 409)
			require.Equal(t, "still_conflicted", remaining["code"])
			if slices.Contains(options, "conflict-card") {
				runCard("unresolved")
				require.Equal(t, before, git("-C", store, "rev-parse", "refs/heads/"+branch))
			}
			resolveScratch()
			if slices.Contains(options, "conflict-card") {
				runCard("done")
			} else {
				done := request("POST", branchPath, "scratch-done", map[string]string{"conflict_change": change, "onto_revision": onto}, 202)
				require.Equal(t, done, request("POST", branchPath, "scratch-done", map[string]string{"conflict_change": change, "onto_revision": onto}, 202))
				for range 3 {
					_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
					require.NoError(t, err)
					require.NoError(t, service.PollOnce(ctx))
				}
			}
		}
	}
	final := request("GET", branchPath+"?rebase_request="+receiptKey, "", nil, 200)
	require.Equal(t, map[string]any{"onto": onto, "state": "completed"}, final["rebase_execution"])
	require.NotContains(t, final, "rebase")
	head := git("-C", store, "rev-parse", "refs/heads/"+branch)
	require.Equal(t, onto, git("-C", store, "rev-parse", head+"^"))
	if slices.Contains(options, "busy-edit") {
		require.Equal(t, "edit while writer blocks rebase", git("-C", store, "show", head+":later.txt"))
	} else {
		require.Equal(t, "scratch later edit", git("-C", store, "show", head+":later.txt"))
	}
	if slices.Contains(options, "conflict-moved") || slices.Contains(options, "moved-after-native") {
		require.Equal(t, "source latest bytes", git("-C", store, "show", head+":source.txt"))
	} else {
		require.Equal(t, "source new bytes", git("-C", store, "show", head+":source.txt"))
	}
	if conflict {
		require.Equal(t, "scratch and source resolved", git("-C", store, "show", head+":a.txt"))
	} else {
		require.Equal(t, "scratch first edit", git("-C", store, "show", head+":a.txt"))
	}
	require.Equal(t, main, git("-C", store, "rev-parse", "refs/heads/main"), "Scratch must never move main")
	var items int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, f.row.RepositoryID).Scan(&items))
	require.Zero(t, items)
	require.Empty(t, launcher.requests)
	require.Empty(t, launcher.signals)
	row, err := q.GetWorkspace(ctx, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, base, row.SourceCommit, "startup source stays immutable")
	if asleep && !conflict {
		require.Equal(t, "suspended", row.Status)
		require.Empty(t, registry.ConnectedBranches(), "asleep Scratch rebase has zero daemon wakes")
	}
	require.Equal(t, head, row.HeadCommitID)
	require.Empty(t, row.CapturePending, "published rebase consumes its exact native capture recovery")
	if slices.Contains(options, "twice") {
		require.NoError(t, os.WriteFile(filepath.Join(source, "source.txt"), []byte("source latest bytes\n"), 0600))
		newOnto := commit("Source moves again")
		git("-C", store, "fetch", source, "main:refs/heads/main")
		require.NoError(t, native.ImportGitRefs(repoPath))
		second := request("POST", branchPath, "scratch-rebase-two", map[string]bool{"rebase": true}, 202)
		require.Equal(t, newOnto, second["onto"])
		for range 4 {
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
		}
		secondFinal := request("GET", branchPath+"?rebase_request=scratch-rebase-two", "", nil, 200)
		require.Equal(t, map[string]any{"onto": newOnto, "state": "completed"}, secondFinal["rebase_execution"])
		secondHead := git("-C", store, "rev-parse", "refs/heads/"+branch)
		require.Equal(t, newOnto, git("-C", store, "rev-parse", secondHead+"^"))
		require.Equal(t, "source latest bytes", git("-C", store, "show", secondHead+":source.txt"))
		require.Equal(t, "scratch first edit", git("-C", store, "show", secondHead+":a.txt"))
		require.Equal(t, "scratch later edit", git("-C", store, "show", secondHead+":later.txt"))
		require.Empty(t, launcher.requests)
		require.Empty(t, launcher.signals)
	}
}
