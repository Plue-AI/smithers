package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only check launch is recorded: native rewrite, object transport, capture,
// PostgreSQL and the composed member HTTP door are real. This is Linux process
// evidence, not the reference microVM/broker writer matrix.
func TestBranchRebaseNowNativeComposedExecution(t *testing.T) {
	testBranchRebaseNative(t, true, "")
}

// Real composed person HTTP door, installed daemon, native jj and durable
// outbox. EmptyBroker does not qualify cgroup freezing or the Mac budget.
func TestPerfGuestRebaseObservations(t *testing.T) {
	testBranchRebaseNative(t, true, "")
}

// Supplemental process kills exercise the real dispatcher, native rewrite and
// retained-state recovery. EmptyBroker supplies no member sessions, so these
// controls cannot qualify real writer freezing or C-DUR-04.
func TestBranchRebaseNativeCrashRecovery(t *testing.T) {
	if os.Getenv("SMITHERS_REBASE_PROCESS_FAULTS") != "1" {
		t.Skip("requires an unprivileged killpoints rehearsal daemon")
	}
	for _, people := range []bool{true, false} {
		presence := "people-absent"
		if people {
			presence = "people-present"
		}
		for _, point := range []string{"rebase-post-capture", "rebase-mid", "rebase-post-apply"} {
			t.Run(presence+"/"+point, func(t *testing.T) { testBranchRebaseNative(t, people, point) })
		}
	}
}

func TestTodoInReviewRebaseSelfLoopComposedInstall(t *testing.T) {
	testBranchRebaseNative(t, true, "", rebaseNativeOptions{InReview: true})
}

func TestBranchRebaseNowNativeComposedConflictContinuation(t *testing.T) {
	testBranchRebaseNative(t, true, "", rebaseNativeOptions{Conflict: true})
}

func TestBranchRebaseNowNativeComposedConflictDone(t *testing.T) {
	testBranchRebaseNative(t, true, "", rebaseNativeOptions{Conflict: true, ManualDone: true})
}

// The parked input is seeded. Native conflict production, its runtime wait
// projection and the person's Done door are real; this does not qualify Stop
// parking, same-journal Resume or microVM isolation.
func TestTodoPausedConflictDoneNativeComposedInstall(t *testing.T) {
	testBranchRebaseNative(t, false, "", rebaseNativeOptions{Conflict: true, ManualDone: true, Paused: true})
}

func TestForeignBringNativeComposedExecution(t *testing.T) {
	testBranchRebaseNative(t, true, "", rebaseNativeOptions{Bring: true})
}

type rebaseNativeOptions struct{ Conflict, ManualDone, InReview, Paused, Bring bool }

func testBranchRebaseNative(t *testing.T, people bool, point string, options ...rebaseNativeOptions) {
	var option rebaseNativeOptions
	if len(options) > 0 {
		option = options[0]
	}
	conflict, manualDone, bring := option.Conflict, option.ManualDone, option.Bring

	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY") == "" {
		t.Skip("requires real rehearsal daemon")
	}
	observe := t.Name() == "TestPerfGuestRebaseObservations"
	t.Setenv("TMPDIR", t.TempDir())
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
	boundHead := commit("first\n")
	require.NoError(t, os.WriteFile(filepath.Join(source, "second.txt"), []byte("later item bytes\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "Another authoring change on the same TODO")
	edited := git("-C", source, "rev-parse", "HEAD")
	git("-C", source, "reset", "--hard", base)
	require.NoError(t, os.WriteFile(filepath.Join(source, "main.txt"), []byte("new main bytes\n"), 0600))
	if conflict {
		require.NoError(t, os.WriteFile(filepath.Join(source, "a.txt"), []byte("main changed\n"), 0600))
	}
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "Main moved")
	onto := git("-C", source, "rev-parse", "HEAD")
	git("-C", store, "fetch", source, "main:refs/heads/main")
	git("-C", store, "fetch", source, edited)
	require.NoError(t, native.ImportGitRefs(repoPath))
	branchRef := repohost.BranchHeadRef(f.row.ID)
	git("-C", store, "update-ref", branchRef, edited)
	git("-C", store, "update-ref", repohost.WorkspaceSourceRef(f.row.ID, edited), edited)
	require.NoError(t, native.ImportGitRefs(repoPath))
	engine, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(engine.Handler(), cfg.AuthToken)
	client.BindMachineRepository(engine.WithMachineRepository)
	var retryClockOffset atomic.Int64
	service := services.NewMythicalService(f.pool, client, services.WithMythicalInstallAuthorization(true), services.WithMythicalNow(func() time.Time {
		return time.Now().Add(time.Duration(retryClockOffset.Load()))
	}))
	service.SetPolicyReader(noPolicy{})
	// The presence fixture has no repository engine. Restore its initial
	// bootstrap state before letting the production stack create its bookmark.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state='bootstrapping' WHERE repository_id=$1`, f.row.RepositoryID)
	require.NoError(t, err)
	// Bootstrap is a production stack transition, never a hand-written bookmark.
	_, err = service.RequestBootstrap(ctx, f.row.RepositoryID, f.user.ID, 100, false)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(ctx))
	item, err := q.GetMythicalItemByNumber(ctx, f.row.RepositoryID, 1)
	require.NoError(t, err)
	checkData := map[string]any{"todo": true, "branch": "smithers/test", "run_launched": true, "run_attached": true, "flowSource": base, "rebase": map[string]any{"onto": onto, "name": "main"}}
	if !conflict {
		// A real captured edit waiting on the moved prefix must reach native
		// rebase before ordinary edit verification can consume it.
		checkData["capture"] = map[string]any{"head": edited, "tree": git("-C", store, "rev-parse", edited+"^{tree}"), "base": base, "onto": edited}
	}
	checks, _ := json.Marshal(checkData)

	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='integrating',reason='rebase_pending',attempt=1,flow_digest=$2,request_run_id='pinned-run',workspace_id=$3,candidate_base=$4,candidate_head=$5,candidate_verified=true,next_attempt_at=NOW(),plan='{"checks":[]}',checks=$6 WHERE id=$1`, item.ID, strings.Repeat("b", 64), f.row.ID, base, edited, checks)
	require.NoError(t, err)
	if option.Paused {
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET paused_at=NOW() WHERE id=$1`, item.ID)
		require.NoError(t, err)
	}
	inReview := option.InReview
	if inReview {
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET pr_number=999,pr_state='open',pr_head=$2 WHERE id=$1`, item.ID, edited)
		require.NoError(t, err)
	}

	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='running',vm_id=$1,head_commit_id=$2 WHERE id=$1`, f.row.ID, edited)
	require.NoError(t, err)
	// The ordinary wake exporter must not accept an upstream target.
	_, err = machineObjectExporter(ctx, f.pool, client)(ctx, f.row.ID, onto, 0x80000000)
	require.ErrorIs(t, err, machined.ErrNotReady)
	forged := context.WithValue(ctx, machineRebaseExportKey{}, machineRebaseExport{branch: "other", target: onto, admit: func(pgx.Tx) error { t.Fatal("unbound target reached admission"); return nil }})
	_, err = machineObjectExporter(ctx, f.pool, client)(forged, f.row.ID, onto, 0x80000000)
	require.ErrorIs(t, err, machined.ErrUnauthorized)
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	stopObjects := bindMachineObjects(ctx, registry, f.pool, client)
	t.Cleanup(stopObjects)
	stop, err := bindMachineEvents(ctx, registry, f.pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	processRuntime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, processRuntime.Close()) })
	_, err = processRuntime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: f.row.ID})
	require.NoError(t, err)
	observed, err := processRuntime.StartWorkspace(ctx, f.row.ID)
	require.NoError(t, err)
	guest := observed.Root
	init := exec.CommandContext(ctx, jj, "git", "init", "--colocate", guest)
	output, err := init.CombinedOutput()
	require.NoError(t, err, string(output))
	git("-C", guest, "fetch", store, branchRef+":refs/heads/fixture")
	edit := exec.CommandContext(ctx, jj, "edit", edited)
	edit.Dir = guest
	output, err = edit.CombinedOutput()
	require.NoError(t, err, string(output))
	change := exec.CommandContext(ctx, jj, "log", "-r", boundHead, "--no-graph", "-T", "change_id")
	change.Dir = guest
	changeID, err := change.Output()
	require.NoError(t, err)
	// A real coding workspace keeps a working-copy descendant above its item.
	// Rebase must include the item's delta and keep that bound identity.
	descendant := exec.CommandContext(ctx, jj, "new", "-r", "@")
	descendant.Dir = guest
	// The fixture uses the native CLI; the rewrite uses authenticated RPC.
	output, err = descendant.CombinedOutput()
	require.NoError(t, err, string(output))
	evidence := t.TempDir()
	t.Cleanup(func() {
		if t.Failed() {
			log, _ := os.ReadFile(filepath.Join(evidence, "machined-"+f.row.ID+".log"))
			t.Log(string(log))
		}
	})
	bound, err := f.pool.Exec(ctx, `UPDATE mythical_lanes SET item_id=$2,name='coding',retired_at=NULL WHERE workspace_id=$1`, f.row.ID, item.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, bound.RowsAffected())
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{machineItemChanges}',jsonb_build_object($2::text,$3::text)) WHERE id=$1`, item.ID, f.row.ID, strings.TrimSpace(string(changeID)))
	require.NoError(t, err)
	runtime := bindingProcessRuntime{rehearsalAdmissionRuntime: &rehearsalAdmissionRuntime{Runtime: processRuntime}, t: t, daemons: registry, daemonStops: new(sync.Map), pool: f.pool, repository: client, evidence: evidence, daemonBinary: os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")}
	type bootResult struct {
		link *machined.Link
		err  error
	}
	boots := make(chan bootResult, 2)
	state, run := t.TempDir(), t.TempDir()
	t.Cleanup(func() {
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(state, "rebase.jsonl"))
			t.Logf("guest observations: %s", data)
		}
	})
	var stopDaemon func()
	var faultBootMu sync.Mutex
	startFaultDaemon := func() error {
		binding, err := machineItemBinding(ctx, f.pool, f.row.ID)
		if err != nil {
			return err
		}
		return startRehearsalMachinedWith(t, ctx, registry, f.row.ID, guest, evidence, runtime.daemonBinary, &binding, &rehearsalRestart{State: state, Run: run, HostHead: edited}, func(stop func()) { stopDaemon = stop })
	}
	for range 2 {
		go func() {
			var err error
			if point == "" && !observe {
				err = runtime.ensureDaemon(ctx, f.row.ID, guest)
			} else {
				faultBootMu.Lock()
				if stopDaemon == nil {
					err = startFaultDaemon()
				}
				faultBootMu.Unlock()
			}
			link, lookup := registry.Current(f.row.ID)
			if err == nil {
				err = lookup
			}
			boots <- bootResult{link, err}
		}()
	}
	first, second := <-boots, <-boots
	require.NoError(t, first.err)
	require.NoError(t, second.err)
	require.Same(t, first.link, second.link, "concurrent gateway and branch requests must retain one authenticated boot")
	// Exercise retained member paths against the installed daemon, rather than
	// accepting the host-only socket fixture as filesystem confinement proof.
	// This process provider has no member cgroups and cannot qualify root use.
	t.Run("retained root input transport controls", func(t *testing.T) {
		canary := filepath.Join(t.TempDir(), "outside-canary")
		require.NoError(t, os.WriteFile(canary, []byte("outside preserved\n"), 0600))
		require.NoError(t, os.Symlink(canary, filepath.Join(guest, "hostile-file")))
		require.NoError(t, os.Symlink(filepath.Dir(canary), filepath.Join(guest, "hostile-directory")))
		t.Cleanup(func() {
			require.NoError(t, os.Remove(filepath.Join(guest, "hostile-file")))
			require.NoError(t, os.Remove(filepath.Join(guest, "hostile-directory")))
		})
		for _, path := range []string{"hostile-file", "hostile-directory/outside-canary", "../outside-canary", "/root/canary"} {
			file, err := registry.ReadFile(ctx, f.row.ID, path, "")
			require.Error(t, err, path)
			require.Empty(t, file.Content, path)
			result, err := registry.WriteFiles(ctx, f.row.ID, []byte("member"), []machined.FileChange{{Path: path, Content: []byte("must not write\n")}})
			require.Error(t, err, path)
			require.Empty(t, result.Applied, path)
		}
		for _, target := range []string{"../../root-canary", "--config=alias.rebase=!touch /root/canary", "LD_PRELOAD=/workspace/evil.so", "SMITHERS_MACHINED_KILL_AT=rebase-mid"} {
			result, err := registry.Rebase(ctx, f.row.ID, []byte("stack"), target)
			require.Error(t, err, target)
			require.Zero(t, result, target)
		}
		bytes, err := os.ReadFile(canary)
		require.NoError(t, err)
		require.Equal(t, "outside preserved\n", string(bytes))
		file, err := registry.ReadFile(ctx, f.row.ID, "a.txt", "")
		require.NoError(t, err, "refusals must preserve the authenticated transport")
		require.Equal(t, "first\n", string(file.Content))
	})
	if bring {
		checks, _ = json.Marshal(map[string]any{"todo": true, "branch": "smithers/test", "run_launched": true, "run_attached": true, "flowSource": base, "machineItemChanges": map[string]string{f.row.ID: strings.TrimSpace(string(changeID))}, "foreignHead": onto, "waits": []map[string]any{{"id": "00000000-0000-4000-8000-000000000001", "kind": "foreign_push", "sha": onto, "since": time.Now().UTC()}}})
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',reason='',candidate_base=$2,checks=$3 WHERE id=$1`, item.ID, onto, checks)
		require.NoError(t, err)
	}
	launcher := new(rebaseRecordedLauncher)
	service.SetLauncher(launcher)
	workspaces := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)), services.WithWorkspaceInstallAuthorization(q), services.WithBranchHeads(client))
	bindConflictValidator(service, workspaces, registry.InspectConflict)
	service.SetBranchRebaseExecutor(machineRebase{registry: registry, pool: f.pool})
	service.SetRebasePresence(func(context.Context, int64, string) (services.RebasePresence, error) {
		if people {
			return services.RebasePresencePeople, nil
		}
		return services.RebasePresenceEmpty, nil
	})
	cfgHTTP := testConfigAllFlagsOn()
	cfgHTTP.Auth.Mode, cfgHTTP.Auth.SessionCookieName = "selfhost", "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfgHTTP.Server.PublicURL, cfgHTTP.Server.AllowedOrigins = origin, []string{origin}
	topics := &liveTopics{changePool: f.pool, queries: q, presence: f.p, todos: service}
	channel := &routes.LiveHandler{Queries: q, Hub: live.NewHub(ctx, nil), Origins: func() []string { return cfgHTTP.Server.AllowedOrigins }, Topics: topics.resolver, Presence: f.p.session}
	server.Config.Handler = githubAppSetupComposeRouter(cfgHTTP, f.pool, &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: f.pool}, Owners: q, Roster: q, Origins: func() []string { return cfgHTTP.Server.AllowedOrigins }}, &routes.WorkspaceHandler{Service: f.p.branches}, routerExtras{Mythical: &routes.MythicalHandler{Service: service}, AckDelay: &routes.InstallAckDelayHandler{Queries: q, Registry: registry}, Live: channel})
	server.Start()
	t.Cleanup(server.Close)
	assertCardState := func(expected string) {
		t.Helper()
		req, err := http.NewRequest("GET", origin+"/api/todos/1", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		var card map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
		require.NoError(t, response.Body.Close())
		require.Equal(t, 200, response.StatusCode, card)
		require.Equal(t, expected, card["state"])
	}
	if option.Paused {
		assertCardState("paused")
	}
	doneRequest := func(change, onto string, status int) {
		t.Helper()
		payload, err := json.Marshal(map[string]string{"conflict_change": change, "onto_revision": onto})
		require.NoError(t, err)
		req, err := http.NewRequest("POST", origin+"/api/branches/"+f.row.ID, bytes.NewReader(payload))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "conflict-done")
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		require.NoError(t, res.Body.Close())
		require.Equal(t, status, res.StatusCode, body)
	}
	readReceipt := func(state string) {
		req, err := http.NewRequest("GET", origin+"/api/todos/1?rebase_request=native-press", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		require.Equal(t, 200, res.StatusCode, body)
		require.Equal(t, map[string]any{"onto": onto, "state": state}, body["rebase_execution"])
	}
	if point != "" {
		require.NoError(t, os.WriteFile(filepath.Join(state, "qualification-"+point+".arm"), nil, 0600))
	}
	var delay machined.AckDelayReceipt
	ackRequest := func(method, body string) machined.AckDelayReceipt {
		req, err := http.NewRequest(method, origin+"/api/install/ack-delay?branch="+f.row.ID, strings.NewReader(body))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		var receipt machined.AckDelayReceipt
		require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
		require.Equal(t, http.StatusOK, response.StatusCode)
		return receipt
	}
	if observe {
		// An ordinary member write makes this rewrite's pre-capture distinct.
		// No database writer or native capture call substitutes for the guest.
		require.NoError(t, os.WriteFile(filepath.Join(guest, "perf-uncommitted.txt"), []byte("queued before rebase\n"), 0600))
		delay = ackRequest("POST", `{"branch":"`+f.row.ID+`","delay_ms":10000}`)
		require.Equal(t, "armed", delay.State)
	}
	branchPath := f.row.ID
	body := `{"rebase":true}`
	if bring {
		branchPath = "smithers%2Ftest"
		body = fmt.Sprintf(`{"op":"bring-in","id":"00000000-0000-4000-8000-000000000001","revision":"%s"}`, onto)
	}
	if people {
		for range 2 {
			req, err := http.NewRequest("POST", origin+"/api/branches/"+branchPath, strings.NewReader(body))
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "native-press")
			res, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			var body map[string]any
			require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
			require.NoError(t, res.Body.Close())
			require.Equal(t, 202, res.StatusCode, body)
			if !bring {
				require.Equal(t, onto, body["onto"])
			}
		}
	}
	if people && !bring {
		readReceipt("running")
	}
	// The HTTP door returns with the old head; only the stack worker rewrites.
	current, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, edited, current.CandidateHead)
	if point != "" {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		polled := make(chan error, 1)
		go func() { polled <- service.PollOnce(ctx) }()
		hit := filepath.Join(state, "qualification-"+point+".hit")
		require.Eventually(t, func() bool { _, err := os.Stat(hit); return err == nil }, 30*time.Second, 10*time.Millisecond, "missing kill marker %s", point)
		marker, err := os.ReadFile(hit)
		require.NoError(t, err)
		require.Equal(t, point, string(marker))
		t.Log("CRASH-POINT " + point + " scope=unprivileged-process")
		stopDaemon() // SIGKILL only this test's namespace process and daemon.
		require.NoError(t, first.link.Close())
		require.NoError(t, <-polled)
		outage, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		require.Contains(t, outage.Reason, "the branch could not be rebased")
		require.True(t, outage.NextAttemptAt.Time.After(time.Now()), "restart must preserve the production outage backoff")
		// Advance only the stack's supported retry clock, not daemon time or
		// freeze timing. Never rewrite a persisted recovery or candidate row.
		retryClockOffset.Store(int64(3 * time.Minute))
		require.NoError(t, os.Remove(hit))
		// This namespace owns its socket path; SIGKILL cannot unlink it.
		require.NoError(t, os.Remove(filepath.Join(run, "machined.sock")))
		require.NoError(t, startFaultDaemon())
		// Wake recovery must retain the whole acknowledged pre-rebase tree,
		// never a mix of the committed repository operation and checkout.
		for path, want := range map[string]string{"a.txt": "first\n", "second.txt": "later item bytes\n"} {
			bytes, err := os.ReadFile(filepath.Join(guest, path))
			require.NoError(t, err)
			require.Equal(t, want, string(bytes), path)
		}
	}
	if observe {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		done := make(chan error, 1)
		go func() { done <- service.PollOnce(ctx) }()
		require.Eventually(t, func() bool {
			data, _ := os.ReadFile(filepath.Join(state, "rebase.jsonl"))
			return strings.Contains(string(data), `"phase":"thawed"`)
		}, 5*time.Second, 10*time.Millisecond)
		receipt := ackRequest("GET", "")
		require.Equal(t, delay.ID, receipt.ID)
		require.Contains(t, []string{"armed", "withheld"}, receipt.State, "guest thaw must precede host ACK")
		require.NoError(t, <-done)

	}
	if bring {
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{foreignBring,checkpoint}','true'::jsonb) WHERE id=$1`, item.ID)
		require.NoError(t, err)
	}
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		require.NoError(t, service.PollOnce(ctx))
		current, err = q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		if current.State == "verifying" || (conflict && current.Reason == "rebase_conflict_pending") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if conflict {
		require.Equal(t, "rebase_conflict_pending", current.Reason)
		for range 3 {
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
		}
		require.Len(t, launcher.requests, 1, "one durable repair launch under the existing attempt")
		require.Equal(t, "coding/rebase-conflict", launcher.requests[0].FlowID)
		require.Equal(t, strings.Repeat("b", 64), launcher.requests[0].Pin.ExecutionDigest)
		require.Empty(t, launcher.signals)
		if option.Paused {
			assertCardState("paused")
		}
		if people {
			readReceipt("running")
		}
		// This boundary test records engine launches; the host/agent journey
		// separately exercises real projection and durable repair execution.
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{conflictReservation,resolution_run}','"repair-run"') WHERE id=$1`, item.ID)
		require.NoError(t, err)
		if !manualDone {
			require.NoError(t, os.WriteFile(filepath.Join(guest, "a.txt"), []byte("first and main changed\n"), 0600))
			// Resolution can precede the real engine's Done projection. Polling
			// must hold it rather than signal an alias which does not exist yet.
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
			require.Empty(t, launcher.signals)
			current, err = q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, "rebase_conflict_pending", current.Reason)
		}
		var repair struct {
			Input struct{ Change, Onto, Name string }
		}
		require.NoError(t, json.Unmarshal(launcher.requests[0].Payload, &repair))
		projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(item.ID.Bytes).String(), "generation": current.Generation, "attempt": current.Attempt, "phase": "conflict", "flowDigest": strings.Repeat("b", 64), "flowSource": base})
		require.NoError(t, err)
		waitRequest, err := json.Marshal(map[string]string{"kind": "conflict", "conflict_change": repair.Input.Change, "onto_revision": repair.Input.Onto})
		require.NoError(t, err)
		update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Scope: launcher.requests[0].Scope, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/rebase-conflict", ExecutionDigest: strings.Repeat("b", 64), Projection: projection, Target: launcher.requests[0].Target, RunID: "repair-run", Run: &flowruntime.Run{RunID: "repair-run", Status: "running", PendingWaits: []flowruntime.PendingWait{{RunID: "repair-step", Token: "repair-token", Name: repair.Input.Name, Request: waitRequest}}}}}
		require.NoError(t, service.ProjectFlowRuntime(ctx, update))
		require.NoError(t, service.ProjectFlowRuntime(ctx, update))
		assertCardState("needs_you")
		if manualDone {
			doneRequest("stale-change", repair.Input.Onto, 409)
			doneRequest(repair.Input.Change, repair.Input.Onto, 409)
			require.NoError(t, os.WriteFile(filepath.Join(guest, "a.txt"), []byte("first and main changed\n"), 0600))
			doneRequest(repair.Input.Change, repair.Input.Onto, 202)
			doneRequest(repair.Input.Change, repair.Input.Onto, 202)
			require.Len(t, launcher.signals, 1, "Done replays the same bound wait")
		}
		for range 5 {
			_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
			require.NoError(t, err)
			require.NoError(t, service.PollOnce(ctx))
			current, err = q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			if current.State == "verifying" {
				break
			}
		}
		require.Len(t, launcher.signals, 1, "resolution releases the repair launch once")
		require.Equal(t, "repair-run", launcher.signals[0].RunID)
		require.Contains(t, launcher.signals[0].Name, "conflict#")
		require.Equal(t, "pinned-run", current.RequestRunID)
		require.EqualValues(t, 1, current.Attempt)
	}
	require.Equal(t, "verifying", current.State, "reason=%s checks=%s", current.Reason, current.Checks)
	if people && !bring {
		readReceipt("completed")
	}

	require.Equal(t, onto, current.CandidateBase)
	require.NotEqual(t, edited, current.CandidateHead)
	require.Equal(t, int64(1), current.Generation)
	launches := 1
	if conflict {
		launches = 2
	}
	require.Len(t, launcher.requests, launches)
	require.Equal(t, "coding/verify", launcher.requests[launches-1].FlowID)
	require.Equal(t, onto, git("--git-dir", store, "rev-parse", current.CandidateHead+"^"))
	if conflict {
		require.Equal(t, "first and main changed", git("--git-dir", store, "show", current.CandidateHead+":a.txt"))
	} else {
		require.Equal(t, "first", git("--git-dir", store, "show", current.CandidateHead+":a.txt"))
	}
	require.Equal(t, "later item bytes", git("--git-dir", store, "show", current.CandidateHead+":second.txt"))
	require.Equal(t, "new main bytes", git("--git-dir", store, "show", current.CandidateHead+":main.txt"))
	if bring {
		require.Len(t, launcher.signals, 2)
		return
	}
	var system, requester string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT data->'actor'->>'id',COALESCE(data->'by'->>'person','') FROM product_job_events WHERE event_type='todo.rebased'`).Scan(&system, &requester))
	require.Equal(t, "stack", system)
	if people {
		require.Equal(t, "presence-owner", requester)
	}
	var entries int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.rebased'`).Scan(&entries))
	require.Equal(t, 1, entries)
	if observe {
		require.Eventually(t, func() bool { delay = ackRequest("GET", ""); return delay.State == "acknowledged" }, 30*time.Second, 50*time.Millisecond)
		require.GreaterOrEqual(t, delay.WithheldMS, float64(10000))
		data, err := os.ReadFile(filepath.Join(state, "rebase.jsonl"))
		require.NoError(t, err)
		var rows []map[string]any
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			var row map[string]any
			require.NoError(t, json.Unmarshal([]byte(line), &row))
			rows = append(rows, row)
		}
		require.Len(t, rows, 3, "%s", data)
		var receiptID, revision string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT data->>'receipt_id',data->>'onto_revision' FROM product_job_events WHERE event_type='todo.rebased'`).Scan(&receiptID, &revision))
		require.Equal(t, rows[0]["id"], receiptID)
		require.Equal(t, onto, revision)
		req, err := http.NewRequest("GET", origin+"/api/branches/"+f.row.ID+"/activity", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		var activity []map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&activity))
		require.Equal(t, http.StatusOK, response.StatusCode)
		var rebases []map[string]any
		for _, entry := range activity {
			if entry["kind"] == "rebase" {
				rebases = append(rebases, entry)
			}
		}
		require.Len(t, rebases, 1)
		require.Equal(t, receiptID, rebases[0]["receipt_id"])
		require.Equal(t, onto, rebases[0]["onto_revision"])
		require.Equal(t, true, rebases[0]["head_changed"])
		require.Equal(t, true, rebases[0]["approvals_cleared"])
		require.Equal(t, map[string]any{"kind": "system", "id": "stack", "color_index": float64(7)}, rebases[0]["actor"])

		require.Equal(t, "held", rows[0]["phase"])
		require.Equal(t, "thawed", rows[1]["phase"])
		require.Equal(t, "drained", rows[2]["phase"])
		for _, row := range rows[1:] {
			require.Equal(t, rows[0]["id"], row["id"])
			require.Equal(t, rows[0]["start"], row["start"])
			require.Equal(t, rows[0]["clock"], row["clock"])
			require.Equal(t, onto, row["onto"])
		}
		require.Equal(t, false, rows[1]["failed"])
		require.Equal(t, true, rows[1]["localSnapshotQueued"])
		require.Equal(t, rows[1]["capture"], rows[2]["capture"])
		require.Equal(t, float64(0), rows[2]["outboxDepth"])
		capture := rows[1]["capture"].(map[string]any)
		require.Equal(t, rows[0]["boot"], capture["boot"])
		require.Equal(t, delay.Boot, capture["boot"])
		require.Equal(t, delay.Event, capture["event"])
		require.Equal(t, float64(delay.Sequence), capture["sequence"])
		require.Equal(t, false, rows[1]["acknowledgedBeforeThaw"])

		require.Len(t, capture["event"], 32)
		require.Greater(t, capture["sequence"].(float64), float64(0))
		require.GreaterOrEqual(t, rows[1]["end"].(float64), rows[0]["start"].(float64))
		// Revalidate real guest and owner HTTP receipts through the same module
		// used by the live driver and artifact verdict. No marker is invented:
		// live-document activation still requires the owner's review.
		module, err := filepath.Abs("../../../../scripts/perf/lib/rebase-receipts.mjs")
		require.NoError(t, err)
		source := `import {verifyHeldObservation,verifyCaptureDelay,verifyDrain} from ` + strconv.Quote((&url.URL{Scheme: "file", Path: module}).String()) + `;
        const {rows,ack,branch}=JSON.parse(process.argv[1]);
        const [held,hold,drained]=rows.map(row=>({...row,branch}));
        const armed={id:ack.id,boot:ack.boot,branch,state:"armed"};
        verifyHeldObservation(held,{branch,onto:hold.onto},hold);
        verifyCaptureDelay(ack,hold,armed); verifyDrain(drained,hold);
        for(const change of [{branch:"foreign"},{id:"foreign"},{boot:"0".repeat(32)},{sequence:ack.sequence+1}]){
          let refused=false;try{verifyCaptureDelay({...ack,...change},hold,armed)}catch{refused=true}
          if(!refused)throw new Error("altered host evidence accepted");
        }
        for(const change of [{id:"foreign"},{onto:"0".repeat(40)},{start:hold.start+1},{clock:"browser monotonic"}]){
          let refused=false;try{verifyHeldObservation(held,{branch,onto:hold.onto},{...hold,...change})}catch{refused=true}
          if(!refused)throw new Error("altered guest evidence accepted");
        }
        for(const change of [{branch:"foreign"},{outboxDepth:1},{capture:{...drained.capture,sequence:ack.sequence+1}}]){
          let refused=false;try{verifyDrain({...drained,...change},hold)}catch{refused=true}
          if(!refused)throw new Error("altered drain evidence accepted");
        }`
		evidence, err := json.Marshal(map[string]any{"rows": rows, "ack": delay, "branch": f.row.ID})
		require.NoError(t, err)
		output, err := exec.CommandContext(ctx, "node", "--input-type=module", "-e", source, string(evidence)).CombinedOutput()
		require.NoError(t, err, "%s", output)

	}
	var eventRaw []byte
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_type='todo.rebased'`).Scan(&eventRaw))
	var event map[string]any
	require.NoError(t, json.Unmarshal(eventRaw, &event))
	expectedState := "working"
	if option.Paused {
		expectedState = "paused"
	}
	if inReview {
		expectedState = "in_review"
	}
	require.Equal(t, expectedState, event["from"])
	require.Equal(t, expectedState, event["to"])
	require.Equal(t, base, event["previous_base"])
	require.Equal(t, expectedState, event["card"].(map[string]any)["state"])
	assertCardState(expectedState)
	require.Equal(t, "pinned-run", current.RequestRunID)
	require.EqualValues(t, 1, current.Attempt)

	// Recovery still observes this exact completed rewrite after the pending
	// destination changes. A newer request cannot settle an older toast.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{rebase}', '{"onto":"later-main","name":"main"}') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	if people && !bring {
		readReceipt("completed")
	}
}

type rebaseRecordedLauncher struct {
	requests []flowdispatch.LaunchRequest
	signals  []flowdispatch.SignalRequest
}

func (l *rebaseRecordedLauncher) SignalInTx(_ context.Context, _ pgx.Tx, in flowdispatch.SignalRequest) (jobs.RequestReceipt, error) {
	l.signals = append(l.signals, in)
	return jobs.RequestReceipt{}, nil
}

func (l *rebaseRecordedLauncher) AdmitInTx(_ context.Context, _ pgx.Tx, in flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	l.requests = append(l.requests, in)
	return jobs.RequestReceipt{}, nil
}
