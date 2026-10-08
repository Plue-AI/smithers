package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Only check launch is recorded: native rewrite, object transport, capture,
// PostgreSQL and the composed member HTTP door are real. This is Linux process
// evidence, not the reference microVM/broker writer matrix.
func TestBranchRebaseNowNativeComposedExecution(t *testing.T) {
	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY") == "" {
		t.Skip("requires real rehearsal daemon")
	}
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
	service := services.NewMythicalService(f.pool, client, services.WithMythicalInstallAuthorization(true))
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
	checks, _ := json.Marshal(map[string]any{"todo": true, "branch": "smithers/test", "run_launched": true, "run_attached": true, "flowSource": base, "capture": map[string]any{"head": edited, "tree": git("--git-dir", store, "rev-parse", edited+"^{tree}"), "base": base, "onto": edited}, "rebase": map[string]any{"onto": onto, "name": "main"}})
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='integrating',reason='rebase_pending',attempt=1,flow_digest=$2,request_run_id='pinned-run',workspace_id=$3,candidate_base=$4,candidate_head=$5,candidate_verified=true,next_attempt_at=NOW(),plan='{"checks":[]}',checks=$6 WHERE id=$1`, item.ID, strings.Repeat("b", 64), f.row.ID, base, edited, checks)
	require.NoError(t, err)
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
	guest := t.TempDir()
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
	runtime := bindingProcessRuntime{rehearsalAdmissionRuntime: &rehearsalAdmissionRuntime{}, t: t, daemons: registry, daemonStops: new(sync.Map), pool: f.pool, repository: client, evidence: evidence, daemonBinary: os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")}
	type bootResult struct {
		link *machined.Link
		err  error
	}
	boots := make(chan bootResult, 2)
	for range 2 {
		go func() {
			err := runtime.ensureDaemon(ctx, f.row.ID, guest)
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
	launcher := new(rebaseRecordedLauncher)
	service.SetLauncher(launcher)
	service.SetBranchRebaseExecutor(machineRebase{registry: registry, pool: f.pool})
	service.SetRebasePresence(func(context.Context, int64, string) (services.RebasePresence, error) {
		return services.RebasePresencePeople, nil
	})
	cfgHTTP := testConfigAllFlagsOn()
	cfgHTTP.Auth.Mode, cfgHTTP.Auth.SessionCookieName = "selfhost", "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfgHTTP.Server.PublicURL, cfgHTTP.Server.AllowedOrigins = origin, []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfgHTTP, q, f.pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
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
	for range 2 {
		req, err := http.NewRequest("POST", origin+"/api/branches/"+f.row.ID, strings.NewReader(`{"rebase":true}`))
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
		require.Equal(t, onto, body["onto"])
	}
	readReceipt("running")
	// The HTTP door returns with the old head; only the stack worker rewrites.
	current, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, edited, current.CandidateHead)
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		_, err = q.RequestMythicalStack(ctx, f.row.RepositoryID)
		require.NoError(t, err)
		require.NoError(t, service.PollOnce(ctx))
		current, err = q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		if current.State == "verifying" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	require.Equal(t, "verifying", current.State, "reason=%s checks=%s", current.Reason, current.Checks)
	readReceipt("completed")
	require.Equal(t, onto, current.CandidateBase)
	require.NotEqual(t, edited, current.CandidateHead)
	require.Equal(t, int64(1), current.Generation)
	require.Len(t, launcher.requests, 1)
	require.Equal(t, "coding/verify", launcher.requests[0].FlowID)
	require.Equal(t, onto, git("--git-dir", store, "rev-parse", current.CandidateHead+"^"))
	require.Equal(t, "first", git("--git-dir", store, "show", current.CandidateHead+":a.txt"))
	require.Equal(t, "later item bytes", git("--git-dir", store, "show", current.CandidateHead+":second.txt"))
	require.Equal(t, "new main bytes", git("--git-dir", store, "show", current.CandidateHead+":main.txt"))
	var system, requester string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT data->'actor'->>'id',data->'by'->>'person' FROM product_job_events WHERE event_type='todo.rebased'`).Scan(&system, &requester))
	require.Equal(t, "stack", system)
	require.Equal(t, "presence-owner", requester)
	// Recovery still observes this exact completed rewrite after the pending
	// destination changes. A newer request cannot settle an older toast.
	_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{rebase}', '{"onto":"later-main","name":"main"}') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	readReceipt("completed")
}

type rebaseRecordedLauncher struct{ requests []flowdispatch.LaunchRequest }

func (l *rebaseRecordedLauncher) AdmitInTx(_ context.Context, _ pgx.Tx, in flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	l.requests = append(l.requests, in)
	return jobs.RequestReceipt{}, nil
}
