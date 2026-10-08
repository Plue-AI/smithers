package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The private configuration crosses a process boundary, not a wire fixture.
// The child authenticates and consumes the installed daemon's actual frames.
type outsideFaultHostConfig struct {
	Database, Storage, Branch, Endpoint, Head, Ready, Captured, Evidence string
	Authority                                                            machined.BootAuthority
	Crash, Outage                                                        bool
}

// K4 with a real inotify producer, versions, bundles, host ingest and PostgreSQL.
// The host process really exits at the committed-before-ACK boundary. The
// daemon is owned by the parent and stays alive across that exit. This Linux
// campaign has an empty broker census; it does not qualify guest member/init/VM.
func TestOutsideWatcherHostFaultRecovery(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY")
	if binary == "" {
		t.Skip("requires real killpoint-enabled rehearsal daemon")
	}
	for run := 1; run <= 10; run++ {
		t.Run(fmt.Sprint(run), func(t *testing.T) { outsideWatcherHostFault(t, binary, "K4") })
	}
}

func TestOutsideWatcherHostOutageRecovery(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY")
	if binary == "" {
		t.Skip("requires real killpoint-enabled rehearsal daemon")
	}
	for run := 1; run <= 10; run++ {
		t.Run(fmt.Sprint(run), func(t *testing.T) { outsideWatcherHostFault(t, binary, "K4b") })
	}
}

func outsideWatcherHostFault(t *testing.T, binary, point string) {
	outage := point == "K4b"
	total := 20
	if outage {
		total = 50
	}
	f := presenceInstall(t, true)
	ctx, cancel := context.WithTimeout(t.Context(), 240*time.Second)
	defer cancel()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id=$1 WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	storage := t.TempDir()
	cfg := repohostserver.Config{StoragePath: storage, AuthToken: "outside-host-fault"}
	repo := cfg.RepoPath("presence-owner", "app")
	_, err = native.InitRepo(repo)
	require.NoError(t, err)
	store := filepath.Join(repo, ".jj", "repo", "store", "git")
	root, state, run := t.TempDir(), t.TempDir(), t.TempDir()
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	output, err := exec.Command(jj, "git", "init", root).CombinedOutput()
	require.NoError(t, err, string(output))
	headCommand := exec.Command(jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	headCommand.Dir = root
	head, err := headCommand.Output()
	require.NoError(t, err)
	seed := strings.TrimSpace(string(head))
	bundle := filepath.Join(t.TempDir(), "seed.bundle")
	for _, argv := range [][]string{
		{"-C", root, "update-ref", "refs/smithers/fixture/seed", seed},
		{"-C", root, "bundle", "create", bundle, "refs/smithers/fixture/seed"},
		{"-C", store, "fetch", "--no-tags", bundle, "refs/smithers/fixture/seed:refs/smithers/branches/" + f.row.ID + "/head"},
	} {
		output, err = exec.Command("/usr/bin/git", argv...).CombinedOutput()
		require.NoError(t, err, string(output))
	}
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2,head_commit_id=$2 WHERE id=$1`, f.row.ID, seed)
	require.NoError(t, err)
	evidence := t.TempDir()
	if directory := os.Getenv("SMITHERS_REHEARSAL_FAULT_EVIDENCE"); directory != "" {
		require.True(t, filepath.IsAbs(directory))
		evidence = filepath.Join(directory, point, filepath.Base(t.Name()))
		require.NoError(t, os.MkdirAll(evidence, 0700))
	}
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		diagnostic, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		for _, table := range []string{"product_job_events", "burst_files", "machine_event_receipts"} {
			var data []byte
			if err := f.pool.QueryRow(diagnostic, "SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM "+table+" r").Scan(&data); err == nil {
				_ = os.WriteFile(filepath.Join(evidence, "failure-"+table+".json"), data, 0600)
			} else {
				t.Logf("archive %s: %v", table, err)
			}
		}
		// Exclude the private host-authority configuration and its credentials.
		if data, err := os.ReadFile(filepath.Join(state, "watcher.json")); err == nil {
			_ = os.WriteFile(filepath.Join(evidence, "failure-watcher.json"), data, 0600)
		}

		for _, phase := range []string{"arm", "started", "phase", "hit"} {
			name := "qualification-K4b-capture." + phase
			if data, err := os.ReadFile(filepath.Join(state, name)); err == nil {
				_ = os.WriteFile(filepath.Join(evidence, "failure-"+name), data, 0600)
			}
		}
		queued, _ := os.ReadDir(filepath.Join(state, "outbox"))
		for _, entry := range queued {
			if strings.HasSuffix(entry.Name(), ".ev") {
				if data, err := os.ReadFile(filepath.Join(state, "outbox", entry.Name())); err == nil {
					_ = os.WriteFile(filepath.Join(evidence, "failure-"+entry.Name()), data, 0600)
				}
			}
		}
	})
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	authority, err := registry.MintBoot(f.row.ID, f.row.ID)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Join(run, "machined"), 0700))
	boot, err := authority.FileForItem(0, machined.ItemBinding{})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(run, "machined", "boot"), boot, 0400))
	config := outsideFaultHostConfig{Database: f.pool.Config().ConnString(), Storage: storage, Branch: f.row.ID,
		Head: seed, Ready: filepath.Join(state, "host-ready"), Captured: filepath.Join(state, "host-captured"), Authority: authority,
		Evidence: evidence, Crash: !outage, Outage: outage}
	var child *exec.Cmd
	var exited <-chan error
	launch := func(address string) {
		t.Helper()
		config.Endpoint = address
		path := filepath.Join(state, "host-authority.json")
		data, err := json.Marshal(config)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(path, data, 0600))
		_ = os.Remove(config.Ready)
		child = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestOutsideWatcherHostProcessChild$", "-test.v")
		child.Env = append(os.Environ(), "SMITHERS_OUTSIDE_HOST_CONFIG="+path)
		log, err := os.OpenFile(filepath.Join(evidence, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		require.NoError(t, err)
		child.Stdout, child.Stderr = log, log
		require.NoError(t, child.Start())
		done := make(chan error, 1)
		go func() { done <- child.Wait(); _ = log.Close() }()
		exited = done
		owned := child
		t.Cleanup(func() { _ = owned.Process.Kill() })
		require.Eventually(t, func() bool {
			_, err := os.Stat(config.Ready)
			return err == nil
		}, 40*time.Second, 25*time.Millisecond, "real host did not reconcile")
	}
	require.NoError(t, startRehearsalMachinedWith(t, ctx, registry, f.row.ID, root, evidence, binary, &machined.ItemBinding{},
		&rehearsalRestart{State: state, Run: run, Attach: func(_ context.Context, address string) error { launch(address); return nil }}))
	if outage {
		require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(state, "host-cut")); return err == nil }, 5*time.Second, 25*time.Millisecond)
	}
	writer, err := os.Create(filepath.Join(evidence, "writer.jsonl"))
	require.NoError(t, err)
	for n := 0; n < total; n++ {
		path := fmt.Sprintf("host-acknowledged-%02d.ts", n)
		content := fmt.Sprintf("// acknowledged host write %02d\n", n)
		file, err := os.Create(filepath.Join(root, path))
		require.NoError(t, err)
		_, err = file.WriteString(content)
		require.NoError(t, err)
		require.NoError(t, file.Sync())
		require.NoError(t, file.Close())
		hash := sha256.Sum256([]byte(content))
		require.NoError(t, json.NewEncoder(writer).Encode(map[string]any{"seq": n, "path": path, "sha256": hex.EncodeToString(hash[:])}))
		if !outage && n == 0 && strings.HasSuffix(t.Name(), "/1") {
			// Retain the scheduling counterexample: the first transaction
			// commits one file, and the remaining writes happen after K4.
			require.Eventually(t, func() bool {
				var committed int
				return f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&committed) == nil && committed == 1
			}, 20*time.Second, 25*time.Millisecond)
		}
		if outage {
			arm := filepath.Join(state, "qualification-K4b-capture.arm")
			hit := filepath.Join(state, "qualification-K4b-capture.hit")
			require.NoError(t, os.WriteFile(arm, nil, 0600))
			require.Eventually(t, func() bool { _, err := os.Stat(hit); return err == nil }, 30*time.Second, 10*time.Millisecond, "real local capture did not finish")
			receipt, err := os.ReadFile(hit)
			require.NoError(t, err)
			require.Equal(t, "captured", string(receipt), "ordinary local capture closes this real watcher burst")
			phase, err := os.ReadFile(filepath.Join(state, "qualification-K4b-capture.phase"))
			require.NoError(t, err)
			require.Equal(t, "complete", string(phase), "all local capture phases completed")
			require.NoError(t, os.Remove(hit))
		}
	}
	require.NoError(t, writer.Sync())
	require.NoError(t, writer.Close())
	if !outage {
		select {
		case err := <-exited:
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit)
			require.Equal(t, 73, exit.ExitCode())
		case <-time.After(30 * time.Second):
			t.Fatal("host did not exit after commit before ACK")
		}
	}
	var rows int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&rows))
	if outage {
		require.Zero(t, rows, "the disconnected real host must have no receipts yet")
	} else {
		// The real idle/capture cadence may close an early burst while the
		// fsynced writer is still running under contention. K4 exits after
		// the first committed transaction, not after all twenty files.
		require.Positive(t, rows, "the real host transaction survived process exit")
		require.LessOrEqual(t, rows, total)
		proof, err := json.Marshal(map[string]any{"committed_files_before_ack": rows, "acknowledged_writes": total})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "commit-before-ack.json"), proof, 0600))
	}
	queued, err := os.ReadDir(filepath.Join(state, "outbox"))
	require.NoError(t, err)
	retained := 0
	for _, entry := range queued {
		if strings.HasSuffix(entry.Name(), ".ev") {
			data, err := os.ReadFile(filepath.Join(state, "outbox", entry.Name()))
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(evidence, "unacknowledged-"+entry.Name()), data, 0600))
			retained++
		}
	}
	require.Positive(t, retained, "host exit must leave the actual daemon outbox unacknowledged")
	if outage {
		require.GreaterOrEqual(t, retained, 100, "fifty real bursts and their captures remain unacknowledged")
		require.NoError(t, os.WriteFile(filepath.Join(state, "host-writer-done"), nil, 0600))
	} else {
		config.Crash = false
		launch(config.Endpoint)
	}
	require.Eventually(t, func() bool { _, err := os.Stat(config.Captured); return err == nil }, 120*time.Second, 25*time.Millisecond)
	select {
	case err := <-exited:
		require.NoError(t, err)
	case <-time.After(30 * time.Second):
		t.Fatal("replacement host did not finish")
	}
	data, err := os.ReadFile(config.Captured)
	require.NoError(t, err)
	var captured machined.CaptureResult
	require.NoError(t, json.Unmarshal(data, &captured))
	remaining, err := os.ReadDir(filepath.Join(state, "outbox"))
	require.NoError(t, err)
	for _, entry := range remaining {
		require.False(t, strings.HasSuffix(entry.Name(), ".ev"))
	}
	for _, table := range []string{"product_job_events", "burst_files", "machine_event_receipts"} {
		var exported []byte
		require.NoError(t, f.pool.QueryRow(ctx, "SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM "+table+" r").Scan(&exported))
		require.NoError(t, os.WriteFile(filepath.Join(evidence, table+".json"), exported, 0600))
	}
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, server.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(server.Handler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	q := db.New(f.pool)
	workspace := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceInstallAuthorization(q), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)), services.WithWorkspaceBurstVersions(f.pool, client))
	install := testConfigAllFlagsOn()
	install.Auth.Mode, install.Auth.SessionCookieName = "selfhost", "session"
	install.Server.PublicURL, install.Server.AllowedOrigins = f.origin, []string{f.origin}
	router := githubAppSetupComposeRouter(install, f.pool, nil, &routes.WorkspaceHandler{Service: workspace})
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	bursts, err := f.pool.Query(ctx, `SELECT data->>'id' FROM product_job_events WHERE event_type='branch.burst' ORDER BY sequence`)
	require.NoError(t, err)
	var ids []string
	for bursts.Next() {
		var id string
		require.NoError(t, bursts.Scan(&id))
		ids = append(ids, id)
	}
	require.NoError(t, bursts.Err())
	bursts.Close()
	if outage {
		require.Len(t, ids, 50)
	} else {
		require.NotEmpty(t, ids)
		require.LessOrEqual(t, len(ids), total)
	}
	var files []services.BranchDiffModel
	for _, burst := range ids {
		request := httptest.NewRequest("GET", f.origin+"/api/branches/"+f.row.ID+"/diff?entry="+burst, nil)
		request.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		request.RemoteAddr = "127.0.0.1:61000"
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, 200, response.Code, response.Body.String())
		var diff services.BranchDiff
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &diff))
		if outage {
			require.Len(t, diff.Files, 1)
		}
		files = append(files, diff.Files...)
	}
	require.Len(t, files, total)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	for n, file := range files {
		path := fmt.Sprintf("host-acknowledged-%02d.ts", n)
		content := fmt.Sprintf("// acknowledged host write %02d\n", n)
		require.Equal(t, path, file.Path)
		require.Equal(t, []services.BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "+", Text: strings.TrimSuffix(content, "\n")}}}}, file.Hunks)
		bytes, err := exec.Command("/usr/bin/git", "-C", store, "show", captured.Head+":"+path).CombinedOutput()
		require.NoError(t, err, string(bytes))
		require.Equal(t, content, string(bytes))
		bytes, err = os.ReadFile(filepath.Join(root, path))
		require.NoError(t, err)
		require.Equal(t, content, string(bytes))
		var count int
		var digest string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*),min(post_digest) FROM burst_files WHERE path=$1`, path).Scan(&count, &digest))
		require.Equal(t, 1, count)
		hash := sha256.Sum256([]byte(content))
		require.Equal(t, hex.EncodeToString(hash[:]), digest)
	}
	var duplicate int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT data->>'id' FROM product_job_events WHERE event_type='branch.burst' GROUP BY data->>'id' HAVING count(*)>1) d`).Scan(&duplicate))
	require.Zero(t, duplicate)
	require.NoError(t, os.WriteFile(filepath.Join(evidence, "capture.json"), data, 0600))
	t.Logf("%s real watcher/host fault; daemon unchanged; acknowledged=%d durable_files=%d sleeping_http_files=%d; member/VM qualification outstanding", point, total, total, total)
}

func TestOutsideWatcherHostProcessChild(t *testing.T) {
	path := os.Getenv("SMITHERS_OUTSIDE_HOST_CONFIG")
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var config outsideFaultHostConfig
	require.NoError(t, json.Unmarshal(data, &config))
	ctx, cancel := context.WithTimeout(t.Context(), 230*time.Second)
	defer cancel()
	pool, err := postgresfixture.Open(ctx, config.Database, 4)
	require.NoError(t, err)
	defer pool.Close()
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: config.Storage, AuthToken: "outside-host-fault"}
	server, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	defer server.Shutdown(context.Background())
	client := repohost.NewLocalClient(server.Handler(), cfg.AuthToken)
	client.BindMachineRepository(server.WithMachineRepository)
	registry := new(machined.Registry)
	defer registry.Close()
	require.NoError(t, registry.RegisterBoot(config.Branch, config.Branch, config.Authority))
	registry.BindObjectImporter(machined.GitBundleImporter(func(_ context.Context, branch string) (string, error) {
		if branch != config.Branch {
			return "", machined.ErrUnauthorized
		}
		return filepath.Join(cfg.RepoPath("presence-owner", "app"), ".jj", "repo", "store", "git"), nil
	}))
	var observe func()
	if config.Crash {
		observe = func() { os.Exit(73) }
	}
	stop, err := bindMachineEvents(ctx, registry, pool, client, observe, nil)
	require.NoError(t, err)
	defer stop()
	establish := func(reconcile bool) *machined.Link {
		t.Helper()
		stream, err := (&net.Dialer{}).DialContext(ctx, "tcp", config.Endpoint)
		require.NoError(t, err)
		require.NoError(t, stream.SetReadDeadline(time.Now().Add(30*time.Second)))
		reader := bufio.NewReader(stream)
		_, err = reader.Peek(1)
		require.NoError(t, err, "wait for real provider initialization before the authentication clock")
		link, err := registry.Connect(ctx, config.Branch, rehearsalReadyConn{stream, reader})
		require.NoError(t, err)
		if reconcile {
			head, err := hex.DecodeString(config.Head)
			require.NoError(t, err)
			reply, err := link.Request(ctx, config.Branch, wire.WakeReconcile, wire.Field(1, head))
			require.NoError(t, err)
			fields, err := wire.Fields("response", reply.Payload[1:])
			require.NoError(t, err)
			require.NotEmpty(t, fields[2])
			require.Equal(t, byte(wire.WakeReconcile), fields[2][0], "wake must succeed before initial admission")
		}
		_, err = link.Request(ctx, config.Branch, wire.SetRoster, wire.Field(1, wire.U16(0)))
		require.NoError(t, err)
		var lastStatus []byte
		// Replay imports fifty real capture bundles as well as fifty bursts.
		// Its completion is distinct from the authentication deadline.
		require.Eventually(t, func() bool {
			reply, err := link.Request(ctx, config.Branch, wire.Status)
			if err != nil {
				return false
			}
			fields, err := wire.Fields("response", reply.Payload[1:])
			if err != nil || len(fields[2]) < 2 || fields[2][0] != byte(wire.Status) {
				return false
			}
			lastStatus = append(lastStatus[:0], fields[2][1:]...)
			status, err := wire.Fields("result1", fields[2][1:])
			return err == nil && len(status[1]) == 1 && status[1][0] == 3 && len(status[4]) == 4 && binary.BigEndian.Uint32(status[4]) == 0 && len(status[7]) == 1 && status[7][0] == 1 && len(status[8]) == 1 && status[8][0] == 1
		}, 90*time.Second, 25*time.Millisecond, "real replay did not drain; last status=%x", &lastStatus)
		require.NoError(t, link.Reconciled())
		return link
	}
	// A transport reconnect retains this daemon's completed native wake. Do
	// not rewrite it to the original seed while its real captures replay.
	link := establish(config.Crash || config.Outage)
	require.NoError(t, os.WriteFile(config.Ready, []byte("ready"), 0600))
	if config.Outage {
		require.NoError(t, link.Close())
		cut := time.Now()
		state := filepath.Dir(config.Ready)
		require.NoError(t, os.WriteFile(filepath.Join(state, "host-cut"), nil, 0600))
		timer := time.NewTimer(30 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(state, "host-writer-done")); return err == nil }, 60*time.Second, 25*time.Millisecond)
		require.GreaterOrEqual(t, time.Since(cut), 30*time.Second)
		link = establish(false)
		proof, err := json.Marshal(map[string]any{"outage_ms": time.Since(cut).Milliseconds(), "host_pid": os.Getpid(), "host_restarts": 0})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(config.Evidence, "outage.json"), proof, 0600))
	}
	if config.Crash {
		<-ctx.Done()
		t.Fatal("K4 host never reached committed boundary")
	}
	var captured machined.CaptureResult
	// Native snapshot's own metadata events can briefly invalidate idle
	// safety after delivery. Retry only that documented live-machine refusal;
	// a bad ACK, lost connection or any other error still fails immediately.
	require.Eventually(t, func() bool {
		captured, err = registry.Capture(ctx, config.Branch)
		return !errors.Is(err, machined.ErrNotReady)
	}, 5*time.Second, 25*time.Millisecond)
	require.NoError(t, err)
	data, err = json.Marshal(captured)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(config.Captured, data, 0600))
}
