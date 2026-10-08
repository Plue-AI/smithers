package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Real installed watcher, native versions/capture, durable outbox, bundle
// transport, host store, PostgreSQL and sleeping HTTP diff. The rehearsal broker
// has an empty census: this qualifies outside-write daemon recovery only, not
// C-DUR-04's member cgroup, init supervision, host-kill or VM-kill acceptance.
func TestOutsideWatcherDaemonFaultRecovery(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY")
	if binary == "" {
		t.Skip("requires rehearsal_daemon built with --features killpoints")
	}
	for _, point := range []string{"K1", "K2", "K3", "K3b", "K5a", "K5b", "K5c"} {
		t.Run(point, func(t *testing.T) {
			for run := 1; run <= 10; run++ {
				t.Run(fmt.Sprint(run), func(t *testing.T) { outsideWatcherDaemonFault(t, binary, point) })
			}
		})
	}
}

// A deliberately failed child campaign must archive its real provider state
// before fixture cleanup. A green parent is not a passing recovery campaign.
func TestOutsideWatcherFailureArtifacts(t *testing.T) {
	if os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY") == "" {
		t.Skip("requires rehearsal_daemon built with --features killpoints")
	}
	directory := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestOutsideWatcherFaultArchiveChild$", "-test.v")
	child.Env = append(os.Environ(), "SMITHERS_FAULT_ARCHIVE_CHILD=1", "SMITHERS_REHEARSAL_FAULT_EVIDENCE="+directory)
	output, err := child.CombinedOutput()
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit, string(output))
	require.Equal(t, 1, exit.ExitCode(), string(output))
	require.Contains(t, string(output), "failure-archive probe", "setup must reach the deliberately failed assertion")
	evidence := filepath.Join(directory, "K1", "TestOutsideWatcherFaultArchiveChild")
	for _, table := range []string{"product_job_events", "burst_files", "machine_event_receipts", "outbox"} {
		data, err := os.ReadFile(filepath.Join(evidence, "failure-"+table+".json"))
		require.NoError(t, err)
		var rows []json.RawMessage
		require.NoError(t, json.Unmarshal(data, &rows))
	}
	checkpoint, err := os.ReadFile(filepath.Join(evidence, "failure-watcher.json"))
	require.NoError(t, err)
	var stored struct{ Version int }
	require.NoError(t, json.Unmarshal(checkpoint, &stored))
	require.Equal(t, 1, stored.Version)
	for n := 0; n < 20; n++ {
		data, err := os.ReadFile(filepath.Join(evidence, fmt.Sprintf("failure-acknowledged-%02d.ts", n)))
		require.NoError(t, err)
		require.Equal(t, fmt.Sprintf("// acknowledged write %02d at K1\n", n), string(data))
	}
}

func TestOutsideWatcherFaultArchiveChild(t *testing.T) {
	if os.Getenv("SMITHERS_FAULT_ARCHIVE_CHILD") != "1" {
		return
	}
	outsideWatcherDaemonFault(t, os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY"), "K1")
}

func TestOutsideWatcherInterruptedWriterRecovery(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY")
	if binary == "" {
		t.Skip("requires rehearsal_daemon built with --features killpoints")
	}
	outsideWatcherDaemonFault(t, binary, "K3", true)
}

// Exercises the reference campaign's release-to-exit hook through the real
// Linux daemon, host ingestion and sleeping HTTP diff before Mac execution.
func TestOutsideWatcherQualificationExitRecovery(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY")
	if binary == "" {
		t.Skip("requires real killpoint-enabled rehearsal daemon")
	}
	outsideWatcherDaemonFault(t, binary, "K1", false, true)
}

func outsideWatcherDaemonFault(t *testing.T, binary, point string, interruptWriter ...bool) {
	f := presenceInstall(t, true)
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "outside-fault"}
	repo := cfg.RepoPath("presence-owner", "app")
	_, err = native.InitRepo(repo)
	require.NoError(t, err)
	store := filepath.Join(repo, ".jj", "repo", "store", "git")
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(server.Handler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	registry := new(machined.Registry)
	registry.BindObjectImporter(machined.GitBundleImporter(func(_ context.Context, branch string) (string, error) {
		if branch != f.row.ID {
			return "", machined.ErrUnauthorized
		}
		return store, nil
	}))
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	stop, err := bindMachineEvents(ctx, registry, f.pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	root := t.TempDir()
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	output, err := exec.Command(jj, "git", "init", root).CombinedOutput()
	require.NoError(t, err, string(output))
	headCommand := exec.Command(jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	headCommand.Dir = root
	head, err := headCommand.Output()
	require.NoError(t, err)
	seed := strings.TrimSpace(string(head))
	seedRef := "refs/smithers/fixture/seed"
	bundle := filepath.Join(t.TempDir(), "seed.bundle")
	for _, argv := range [][]string{
		{"-C", root, "update-ref", seedRef, seed},
		{"-C", root, "bundle", "create", bundle, seedRef},
		{"-C", store, "fetch", "--no-tags", bundle, seedRef + ":refs/smithers/branches/" + f.row.ID + "/head"},
	} {
		output, err = exec.Command("/usr/bin/git", argv...).CombinedOutput()
		require.NoError(t, err, string(output))
	}
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2,head_commit_id=$2 WHERE id=$1`, f.row.ID, seed)
	require.NoError(t, err)
	evidence := t.TempDir()
	if directory := os.Getenv("SMITHERS_REHEARSAL_FAULT_EVIDENCE"); directory != "" {
		require.True(t, filepath.IsAbs(directory), "evidence directory must be absolute")
		evidence = filepath.Join(directory, point, filepath.Base(t.Name()))
		require.NoError(t, os.MkdirAll(evidence, 0700))
	}
	writeEvidence := func(name string, value any) {
		t.Helper()
		data, err := json.MarshalIndent(value, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(evidence, name), data, 0600))
	}
	writeEvidence("env.json", map[string]any{"commit": os.Getenv("SMITHERS_REHEARSAL_COMMIT"), "point": point, "run": t.Name(), "scope": "outside-daemon-recovery", "broker": "empty-census", "guest_init": false, "vm": false, "head_before": seed})
	qualificationExit := len(interruptWriter) > 1 && interruptWriter[1]
	restart := &rehearsalRestart{State: t.TempDir(), Run: t.TempDir(), KillAt: point, Exited: make(chan error, 1)}
	if strings.HasPrefix(point, "K5") {
		restart.KillAt = "armed:" + point
	}
	if qualificationExit {
		restart.KillAt = ""
	}
	require.NoError(t, startRehearsalMachinedWith(t, ctx, registry, f.row.ID, root, evidence, binary, &machined.ItemBinding{}, restart))
	if qualificationExit {
		require.NoError(t, os.WriteFile(filepath.Join(restart.State, "qualification-"+point+".arm"), nil, 0600))
	}
	// Independent acknowledged-write oracle: log only after fsync and close.
	writer, err := os.Create(filepath.Join(evidence, "writer.jsonl"))
	require.NoError(t, err)
	expected := map[string]string{}
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		// Archive before the daemon, repository and database fixture cleanups.
		// A failed convergence assertion must retain the actual rows/checkpoint,
		// rather than leave only a timeout and destroy its recovery evidence.
		archive := func(name string, data []byte, err error) {
			if err != nil {
				data = []byte(err.Error())
				name += ".error"
			}
			if err := os.WriteFile(filepath.Join(evidence, "failure-"+name), data, 0600); err != nil {
				t.Logf("failure evidence %s: %v", name, err)
			}
		}
		diagnosticCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		for _, table := range []string{"product_job_events", "burst_files", "machine_event_receipts"} {
			var data []byte
			err := f.pool.QueryRow(diagnosticCtx, "SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM "+table+" r").Scan(&data)
			archive(table+".json", data, err)
		}
		checkpoint, err := os.ReadFile(filepath.Join(restart.State, "watcher.json"))
		archive("watcher.json", checkpoint, err)
		entries, err := os.ReadDir(filepath.Join(restart.State, "outbox"))
		names := []string{}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".ev") {
				names = append(names, entry.Name())
				data, err := os.ReadFile(filepath.Join(restart.State, "outbox", entry.Name()))
				archive(entry.Name(), data, err)
			}
		}
		manifest, _ := json.Marshal(names)
		archive("outbox.json", manifest, err)
		for path := range expected {
			data, err := os.ReadFile(filepath.Join(root, path))
			archive(path, data, err)
		}
	})
	for n := 0; n < 20; n++ {
		path := fmt.Sprintf("acknowledged-%02d.ts", n)
		content := fmt.Sprintf("// acknowledged write %02d at %s\n", n, point)
		file, err := os.Create(filepath.Join(root, path))
		require.NoError(t, err)
		_, err = file.WriteString(content)
		require.NoError(t, err)
		require.NoError(t, file.Sync())
		require.NoError(t, file.Close())
		hash := sha256.Sum256([]byte(content))
		expected[path] = content
		require.NoError(t, json.NewEncoder(writer).Encode(map[string]any{"seq": n, "path": path, "sha256": hex.EncodeToString(hash[:])}))
		if n == 0 && len(interruptWriter) == 1 && interruptWriter[0] {
			// Continue the same acknowledged writer after the first burst kills
			// the daemon. Restart must discover the other nineteen files too.
			require.Eventually(t, func() bool { return len(restart.Exited) == 1 }, 20*time.Second, 50*time.Millisecond)
		}
		if n == 0 && strings.HasPrefix(point, "K5") && filepath.Base(t.Name()) == "1" {
			// Deliberately cross the five-second background capture boundary.
			// The old eagerly armed hook exits here, before the remaining writes.
			select {
			case err := <-restart.Exited:
				t.Fatalf("capture hook fired before acknowledged writer completed: %v", err)
			case <-time.After(6 * time.Second):
			}
			var setupHead string
			require.Eventually(t, func() bool {
				head, err := exec.Command("/usr/bin/git", "-C", store, "rev-parse", "refs/smithers/branches/"+f.row.ID+"/head").Output()
				setupHead = strings.TrimSpace(string(head))
				return err == nil && setupHead != seed
			}, 15*time.Second, 50*time.Millisecond, "background capture must complete before the hook is armed")
			captured, err := exec.Command("/usr/bin/git", "-C", store, "show", setupHead+":"+path).CombinedOutput()
			require.NoError(t, err, string(captured))
			require.Equal(t, content, string(captured))
			writeEvidence("setup-capture.json", map[string]string{"head": setupHead, "path": path, "sha256": hex.EncodeToString(hash[:])})
		}
	}
	require.NoError(t, writer.Sync())
	require.NoError(t, writer.Close())
	if os.Getenv("SMITHERS_FAULT_ARCHIVE_CHILD") == "1" {
		t.Fatal("failure-archive probe")
	}
	if qualificationExit {
		require.Eventually(t, func() bool {
			bytes, err := os.ReadFile(filepath.Join(restart.State, "qualification-"+point+".hit"))
			return err == nil && string(bytes) == point
		}, 20*time.Second, 25*time.Millisecond)
		select {
		case err := <-restart.Exited:
			t.Fatalf("qualification exited before release: %v", err)
		default:
		}
		require.NoError(t, os.WriteFile(filepath.Join(restart.State, "qualification-"+point+".exit"), nil, 0600))
	}
	if strings.HasPrefix(point, "K5") {
		require.Eventually(t, func() bool {
			var n int
			err := f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&n)
			return err == nil && n == 20
		}, 20*time.Second, 50*time.Millisecond)
		// Cadence captures during setup must not kill the daemon before all
		// acknowledged writes have reached the host. Arm only after that receipt.
		require.NoError(t, os.WriteFile(filepath.Join(restart.State, "fault-armed"), []byte(point), 0600))
		// Capture invokes the actual native snapshot/object stream/captured event.
		_, _ = registry.Capture(ctx, f.row.ID)
	}
	select {
	case err := <-restart.Exited:
		var exit *exec.ExitError
		require.ErrorAs(t, err, &exit)
		require.Equal(t, 73, exit.ExitCode(), "must reach the compiled kill hook")
	case <-time.After(30 * time.Second):
		t.Fatal("daemon did not reach " + point)
	}
	// Retain the exact durable records at the kill, before replay changes them.
	killedEntries, err := os.ReadDir(filepath.Join(restart.State, "outbox"))
	require.NoError(t, err)
	var outboxNames []string
	for _, entry := range killedEntries {
		if strings.HasSuffix(entry.Name(), ".ev") {
			data, err := os.ReadFile(filepath.Join(restart.State, "outbox", entry.Name()))
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(evidence, "killed-"+entry.Name()), data, 0600))
			outboxNames = append(outboxNames, entry.Name())
		}
	}
	writeEvidence("outbox-at-kill.json", outboxNames)
	// Reconnect the same boot with the original private outbox/checkpoint files.
	// Guest init/VM supervision is deliberately not claimed by this Linux test.
	require.NoError(t, os.Remove(filepath.Join(restart.Run, "machined.sock")))
	restart.KillAt = ""
	restart.Exited = nil
	require.NoError(t, startRehearsalMachinedWith(t, ctx, registry, f.row.ID, root, evidence, binary, &machined.ItemBinding{}, restart))
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&n)
		return err == nil && n == 20
	}, 20*time.Second, 50*time.Millisecond)
	var capture machined.CaptureResult
	require.Eventually(t, func() bool {
		capture, err = registry.Capture(ctx, f.row.ID)
		if errors.Is(err, machined.ErrNotReady) {
			return false
		}
		require.NoError(t, err)
		return true
	}, 20*time.Second, 50*time.Millisecond)
	hashes := map[string]string{}
	for path, content := range expected {
		disk, err := os.ReadFile(filepath.Join(root, path))
		require.NoError(t, err)
		require.Equal(t, content, string(disk))
		captured, err := exec.Command("/usr/bin/git", "-C", store, "show", capture.Head+":"+path).CombinedOutput()
		require.NoError(t, err, string(captured))
		require.Equal(t, content, string(captured))
		var n int
		var digest string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*),min(post_digest) FROM burst_files WHERE path=$1`, path).Scan(&n, &digest))
		require.Equal(t, 1, n, "one durable file row per acknowledged path")
		hash := sha256.Sum256([]byte(content))
		require.Equal(t, hex.EncodeToString(hash[:]), digest)
		hashes[path] = digest
	}
	writeEvidence("working-copy-hashes.json", hashes)
	writeEvidence("head-after.json", map[string]string{"head": capture.Head})
	for _, table := range []string{"product_job_events", "burst_files", "machine_event_receipts"} {
		var data []byte
		require.NoError(t, f.pool.QueryRow(ctx, "SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM "+table+" r").Scan(&data))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, table+".json"), data, 0600))
	}
	remaining, err := os.ReadDir(filepath.Join(restart.State, "outbox"))
	require.NoError(t, err)
	for _, entry := range remaining {
		require.False(t, strings.HasSuffix(entry.Name(), ".ev"), "outbox must drain")
	}
	var duplicate int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT data->>'id' FROM product_job_events WHERE event_type='branch.burst' GROUP BY data->>'id' HAVING count(*)>1) d`).Scan(&duplicate))
	require.Zero(t, duplicate)
	// Close the machine; a person must still be able to open every exact diff.
	require.NoError(t, registry.Close())
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	q := db.New(f.pool)
	workspace := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)), services.WithWorkspaceBurstVersions(f.pool, client))
	install := testConfigAllFlagsOn()
	install.Auth.Mode = "selfhost"
	install.Auth.SessionCookieName = "session"
	install.Server.PublicURL = f.origin
	install.Server.AllowedOrigins = []string{f.origin}
	router := githubAppSetupComposeRouter(install, f.pool, nil, &routes.WorkspaceHandler{Service: workspace})
	rows, err := f.pool.Query(ctx, `SELECT data->>'id' FROM product_job_events WHERE event_type='branch.burst' ORDER BY sequence`)
	require.NoError(t, err)
	var entries []string
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		entries = append(entries, id)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	seen := map[string]bool{}
	for _, entry := range entries {
		req := httptest.NewRequest("GET", f.origin+"/api/branches/"+f.row.ID+"/diff?entry="+entry, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		req.RemoteAddr = "127.0.0.1:61000"
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var diff services.BranchDiff
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &diff))
		for _, file := range diff.Files {
			require.False(t, seen[file.Path])
			seen[file.Path] = true
			require.Equal(t, []services.BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "+", Text: strings.TrimSuffix(expected[file.Path], "\n")}}}}, file.Hunks)
		}
	}
	require.Len(t, seen, 20)
	t.Logf("point=%s acknowledged=20 durable_files=20 sleeping_http_files=20 capture=%s scope=outside-daemon-recovery", point, capture.Head)
}
