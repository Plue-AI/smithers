package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// Production HTTP, PostgreSQL, registry, object ingest, native rewrite and FIFO
// are real. The rehearsal's empty broker cannot qualify cgroup freeze or W2-W4;
// those require the approved reference VM. Build rehearsal_daemon with killpoints.
func TestMachinedMutationQueuedHTTPWrites(t *testing.T) { testMachinedNativeMutation(t, "queued") }

// Real daemon capture/event dispatch following authenticated composed HTTP saves.
// Unlike the scripted capture peer, this executes the native snapshot/outbox.
func TestMachinedCapturePendingWork(t *testing.T) { testMachinedNativeMutation(t, "pending") }

// Browser saves enforce preconditions through the installed daemon, then the
// transactional host capture retains exactly the accepted bytes.
func TestMachinedFilePreconditionsHTTP(t *testing.T) { testMachinedNativeMutation(t, "preconditions") }

func TestMachinedMutationDelayedCaptureAck(t *testing.T) { testMachinedNativeMutation(t, "ack") }

func TestMachinedMutationOutsideRename(t *testing.T) { testMachinedNativeMutation(t, "race") }

// Extend the real HTTP writer/rewrite campaign with open daemon documents.
// Linux still has an empty broker; the installed W2-W4 campaign is separate.
func TestLiveDocumentMutationQueuedHTTPWrites(t *testing.T) {
	testMachinedNativeMutation(t, "live")
}

func testMachinedNativeMutation(t *testing.T, mode string) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if os.Getenv("SMITHERS_MACHINED_MUTATION_DEBUG") != "1" {
		t.Skip("debug rehearsal daemon with killpoints required")
	}
	require.NotEmpty(t, binary)
	server, provider, pool, branch, cookie := workspaceFileInstallFixture(t, nil)
	budget := 90 * time.Second
	if mode == "race" {
		budget = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(t.Context(), budget)
	defer cancel()
	root, state, run := t.TempDir(), t.TempDir(), t.TempDir()
	evidence := t.TempDir()
	t.Cleanup(func() {
		if t.Failed() {
			data, _ := os.ReadFile(filepath.Join(evidence, "machined-"+branch+".log"))
			t.Log(string(data))
		}
	})
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	jjCall := func(args ...string) string {
		t.Helper()
		c := exec.CommandContext(ctx, jj, args...)
		c.Dir = root
		out, err := c.CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	jjCall("git", "init", "--colocate", root)
	require.NoError(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("hello"), 0644))
	jjCall("describe", "-m", "base")
	base := jjCall("log", "-r", "@", "--no-graph", "-T", "commit_id")
	jjCall("new", base)
	require.NoError(t, os.WriteFile(filepath.Join(root, "item.txt"), []byte("item bytes\n"), 0644))
	jjCall("describe", "-m", "item")
	item := jjCall("log", "-r", "@", "--no-graph", "-T", "commit_id")
	change := jjCall("log", "-r", "@", "--no-graph", "-T", "change_id")
	jjCall("new", base)
	require.NoError(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("world"), 0644))
	jjCall("describe", "-m", "target")
	onto := jjCall("log", "-r", "@", "--no-graph", "-T", "commit_id")
	jjCall("edit", item)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "mutation-campaign"}
	repository := cfg.RepoPath("digestowner", "demo")
	_, err = native.InitRepo(repository)
	require.NoError(t, err)
	store := filepath.Join(repository, ".jj", "repo", "store", "git")
	git := func(args ...string) []byte {
		t.Helper()
		out, err := hostexec.Git(ctx, args...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return out
	}
	git("-C", store, "fetch", filepath.Join(root, ".git"), item)
	git("-C", store, "update-ref", "refs/smithers/branches/"+branch+"/head", item)
	_, err = pool.Exec(ctx, "UPDATE workspaces SET head_commit_id=$2,vm_id=$1 WHERE id=$1", branch, item)
	require.NoError(t, err)
	host, err := repohostserver.NewWithFFI(cfg, native)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, host.Shutdown(context.Background())) })
	client := repohost.NewLocalClient(http.NotFoundHandler(), cfg.AuthToken)
	client.BindMachineRepository(host.WithMachineRepository)
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	t.Cleanup(bindMachineObjects(ctx, registry, pool, client))
	stop, err := bindMachineEvents(ctx, registry, pool, client, nil, nil)
	require.NoError(t, err)
	t.Cleanup(stop)
	require.NoError(t, startRehearsalMachinedWith(t, ctx, registry, branch, root, evidence, binary, &machined.ItemBinding{Number: 1, Change: change}, &rehearsalRestart{State: state, Run: run}))
	provider.reader = func(ctx context.Context, id, path string) ([]byte, error) {
		file, err := registry.ReadFile(ctx, id, path, "")
		return file.Content, err
	}
	provider.writer = machined.WorkspaceWriter{Client: mutationWriteObserver{registry, t}, EnsureReady: func(ctx context.Context, id string) error {
		link, err := registry.Current(id)
		if err != nil {
			return err
		}
		return link.RequireReady(id)
	}}
	row, err := db.New(pool).GetWorkspace(ctx, branch)
	require.NoError(t, err)
	link, err := registry.Current(branch)
	require.NoError(t, err)
	actor, err := machined.CommitActor(ctx, pool, branch, link.Machine(), func(context.Context, pgx.Tx) (machined.ActorIdentity, error) {
		return machined.ActorIdentity{Kind: "person", MemberID: row.UserID, Via: "web"}, nil
	})
	require.NoError(t, err)
	type reply struct {
		status int
		body   []byte
		err    error
	}
	request := func(method, path, body string) reply {
		req, err := http.NewRequestWithContext(ctx, method, server.URL+"/api/repos/digestowner/demo/workspaces/"+branch+"/files/content?path="+path, strings.NewReader(body))
		if err != nil {
			return reply{err: err}
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL)
		req.Header.Set("X-CSRF-Token", "mutation-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "mutation-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		if err != nil {
			return reply{err: err}
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		return reply{res.StatusCode, data, err}
	}
	first, err := registry.Capture(ctx, branch)
	require.NoError(t, err)
	require.NotEmpty(t, first.Head)
	awaitIdle := func() {
		t.Helper()
		require.Eventually(t, func() bool {
			bursts, docs, err := registry.IdleSafety(ctx, branch)
			return err == nil && bursts && docs
		}, 10*time.Second, 10*time.Millisecond)

	}
	settledCapture := func() machined.CaptureResult {
		t.Helper()
		captured, err := registry.Capture(ctx, branch)
		if err == machined.ErrNotReady {
			// A capture can commit before its own jj metadata finishes the
			// watcher debounce. The production sleep guard correctly keeps
			// that machine awake. Re-enter capture after real quiet evidence;
			// replay must still signal edited only once for the same tree.
			awaitIdle()
			captured, err = registry.Capture(ctx, branch)
		}
		require.NoError(t, err)
		return captured
	}

	if mode == "preconditions" {
		initial, updated := "created from browser", "updated from browser"
		res := request("PUT", "preconditions.txt", `{"content":"created from browser","base_digest":"absent"}`)
		require.NoError(t, res.err)
		require.Equal(t, http.StatusOK, res.status, "%s", res.body)
		for _, base := range []string{"absent", strings.Repeat("0", 64)} {
			body, err := json.Marshal(map[string]string{"content": "lost", "base_digest": base})
			require.NoError(t, err)
			res = request("PUT", "preconditions.txt", string(body))
			require.NoError(t, res.err)
			require.Equal(t, http.StatusConflict, res.status, "%s", res.body)
			require.Equal(t, []byte(initial), mustReadMutationFile(t, filepath.Join(root, "preconditions.txt")))
		}
		digest := sha256.Sum256([]byte(initial))
		body, err := json.Marshal(map[string]string{"content": updated, "base_digest": hex.EncodeToString(digest[:])})
		require.NoError(t, err)
		res = request("PUT", "preconditions.txt", string(body))
		require.NoError(t, res.err)
		require.Equal(t, http.StatusOK, res.status, "%s", res.body)
		res = request("GET", "preconditions.txt", "")
		require.NoError(t, res.err)
		require.Equal(t, http.StatusOK, res.status, "%s", res.body)
		require.Contains(t, string(res.body), updated)
		awaitIdle()
		captured := settledCapture()
		require.Equal(t, []byte(updated), git("-C", store, "show", captured.Head+":preconditions.txt"))
		return
	}
	if mode == "race" {
		awaitIdle()
		original := "original race bytes"
		res := request("PUT", "race.txt", `{"content":"original race bytes","base_digest":"absent"}`)
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		_, err := registry.Capture(ctx, branch)
		require.NoError(t, err)
		var outsideSaves []string
		for run := 0; run < 100; run++ {
			awaitIdle()
			outside := fmt.Sprintf("outside rename %03d", run)
			replacement := fmt.Sprintf("daemon save %03d", run)
			digest := sha256.Sum256([]byte(original))
			body, err := json.Marshal(map[string]string{"content": replacement, "base_digest": hex.EncodeToString(digest[:])})
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(state, "qualification-write_swap.arm"), nil, 0600))
			saved := make(chan reply, 1)
			go func() { saved <- request("PUT", "race.txt", string(body)) }()
			hit := filepath.Join(state, "qualification-write_swap.hit")
			require.Eventually(t, func() bool { _, err := os.Stat(hit); return err == nil }, 5*time.Second, time.Millisecond)
			select {
			case early := <-saved:
				t.Fatalf("save completed before outside rename: %+v", early)
			default:
			}
			temp := filepath.Join(root, "outside-rename")
			require.NoError(t, os.WriteFile(temp, []byte(outside), 0644))
			require.NoError(t, os.Rename(temp, filepath.Join(root, "race.txt")))
			require.NoError(t, os.Remove(hit))
			res = <-saved
			require.NoError(t, res.err)
			require.Equal(t, 200, res.status, "run %d: %s", run, res.body)
			var result struct {
				Raced []struct{ Path, Version string }
			}
			require.NoError(t, json.Unmarshal(res.body, &result))
			require.Len(t, result.Raced, 1)
			require.Equal(t, "race.txt", result.Raced[0].Path)
			outsideDigest := sha256.Sum256([]byte(outside))
			require.Equal(t, hex.EncodeToString(outsideDigest[:]), result.Raced[0].Version)
			require.Equal(t, []byte(replacement), mustReadMutationFile(t, filepath.Join(root, "race.txt")))
			outsideSaves = append(outsideSaves, outside)
			original = replacement
		}
		// Drain once after the writers finish, then inspect every retained
		// outside version independently. This is not a retry of any mutation.
		require.Eventually(t, func() bool {
			bursts, docs, err := registry.IdleSafety(ctx, branch)
			return err == nil && bursts && docs
		}, 10*time.Second, 10*time.Millisecond)
		captured, err := registry.Capture(ctx, branch)
		require.NoError(t, err)
		require.Equal(t, []byte(original), git("-C", store, "show", captured.Head+":race.txt"))
		for run, outside := range outsideSaves {
			digest := sha256.Sum256([]byte(outside))
			var blob string
			require.NoError(t, pool.QueryRow(ctx, `SELECT f.after_blob FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE f.path='race.txt' AND f.post_digest=$1 AND e.data->>'branch'=$2 LIMIT 1`, hex.EncodeToString(digest[:]), branch).Scan(&blob))
			require.Equal(t, []byte(outside), git("-C", store, "cat-file", "blob", blob), "outside save lost at run %d", run)
		}
		return
	}
	if mode == "ack" {
		res := request("PUT", "ack.txt", `{"content":"pinned before rewrite","base_digest":"absent"}`)
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		window, err := registry.AckDelay(branch, 10000, "", "")
		require.NoError(t, err)
		t.Cleanup(func() { _, _ = registry.AckDelay(branch, 0, window.ID, window.Boot) })
		began := time.Now()
		_, err = registry.Rebase(ctx, branch, actor, base)
		require.NoError(t, err)
		require.Less(t, time.Since(began), 5*time.Second, "rewrite cannot await the ten-second host ACK")
		require.Eventually(t, func() bool {
			receipt, err := registry.ReadAckDelay(branch)
			return err == nil && receipt.State == "withheld"
		}, 5*time.Second, 5*time.Millisecond)
		waiting := make(chan error, 1)
		go func() { _, err := registry.Capture(ctx, branch); waiting <- err }()
		select {
		case err := <-waiting:
			t.Fatalf("capture did not wait for durable outbox delivery: %v", err)
		case <-time.After(150 * time.Millisecond):
		}
		// The pending capture cannot hold the mutation lock while draining.
		// A second authenticated browser write must complete during the hold.
		began = time.Now()
		res = request("PUT", "while-ack.txt", `{"content":"lock available during ACK hold","base_digest":"absent"}`)
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		require.Less(t, time.Since(began), 3*time.Second, "capture drain held the mutation lock")
		receipt, err := registry.ReadAckDelay(branch)
		require.NoError(t, err)
		require.Equal(t, "withheld", receipt.State)
		var receipts int
		eventBytes, err := hex.DecodeString(receipt.Event)
		require.NoError(t, err)
		require.Len(t, eventBytes, 16)
		eventID, err := uuid.FromBytes(eventBytes)
		require.NoError(t, err)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, eventID.String()).Scan(&receipts))
		require.Equal(t, 1, receipts, "event transaction commits before delayed ACK")
		require.NoError(t, <-waiting)
		require.Eventually(t, func() bool {
			receipt, err = registry.ReadAckDelay(branch)
			return err == nil && receipt.State == "acknowledged"
		}, time.Second, 5*time.Millisecond)
		require.GreaterOrEqual(t, receipt.WithheldMS, 10000.0)
		final, err := registry.Capture(ctx, branch)
		require.NoError(t, err)
		for path, want := range map[string]string{"ack.txt": "pinned before rewrite", "while-ack.txt": "lock available during ACK hold"} {
			require.Equal(t, []byte(want), git("-C", store, "show", final.Head+":"+path))
		}
		return
	}
	if mode == "pending" {

		_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,state,landed_main) VALUES($1,'active',$2)`, row.RepositoryID, base)
		require.NoError(t, err)
		var itemID string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,candidate_base,candidate_head,candidate_verified,attempt,generation,request_run_id,checks)
          VALUES($1,'todo','proposed',$2,$3,$4,true,3,9,'native-capture-run','{"todo":true,"land":{"head":"approved"},"attempts":[]}') RETURNING id::text`, row.RepositoryID, branch, base, first.Head).Scan(&itemID))
		generation := func() int64 {
			var n int64
			require.NoError(t, pool.QueryRow(ctx, `SELECT requested_generation FROM mythical_stacks WHERE repository_id=$1`, row.RepositoryID).Scan(&n))
			return n
		}
		initialGeneration := generation()
		var currentHead, currentBase string
		var attempt, itemGeneration int32
		var verified bool
		read := func() []byte {
			var checks []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT candidate_head,candidate_base,attempt,generation,candidate_verified,checks FROM mythical_items WHERE id=$1`, itemID).Scan(&currentHead, &currentBase, &attempt, &itemGeneration, &verified, &checks))
			require.Equal(t, first.Head, currentHead)
			require.Equal(t, base, currentBase)
			require.EqualValues(t, 3, attempt)
			require.EqualValues(t, 9, itemGeneration)
			return checks
		}
		_, err = registry.Capture(ctx, branch)
		require.NoError(t, err)
		require.Equal(t, initialGeneration, generation(), "equal accepted tree is not edited")
		read()
		require.True(t, verified)
		for i, text := range []string{"native pending bytes", "native pending bytes", "second native pending bytes"} {
			digest := "absent"
			if i > 0 {
				hash := sha256.Sum256([]byte("native pending bytes"))
				digest = hex.EncodeToString(hash[:])
			}
			body, err := json.Marshal(map[string]string{"content": text, "base_digest": digest})
			require.NoError(t, err)
			res := request("PUT", "pending.txt", string(body))
			require.NoError(t, res.err)
			require.Equal(t, 200, res.status, "%s", res.body)
			awaitIdle()
			captured := settledCapture()
			checks := read()
			require.False(t, verified)
			var record struct {
				Capture struct{ Head, Tree string }
				Land    json.RawMessage
			}
			require.NoError(t, json.Unmarshal(checks, &record))
			require.Equal(t, captured.Head, record.Capture.Head)
			require.Equal(t, captured.Tree, record.Capture.Tree)
			require.Empty(t, record.Land)
			want := initialGeneration + 1
			if i == 2 {
				want++
			}
			require.Equal(t, want, generation(), "new captured tree signals once; identical bytes do not")
			_, err = registry.Capture(ctx, branch)
			require.NoError(t, err)
			require.Equal(t, want, generation(), "drained/repeated capture is not another edit")
			require.Equal(t, []byte(text), git("-C", store, "show", captured.Head+":pending.txt"))
		}

		// Non-review work records its latest capture without scheduling edited.
		// The accepted generation is immutable across both states.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='running' WHERE id=$1`, itemID)
		require.NoError(t, err)
		beforeWorking := generation()
		digest := sha256.Sum256([]byte("second native pending bytes"))
		body, err := json.Marshal(map[string]string{"content": "working tree bytes", "base_digest": hex.EncodeToString(digest[:])})
		require.NoError(t, err)
		res := request("PUT", "pending.txt", string(body))
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		awaitIdle()
		working := settledCapture()
		var latest struct{ Capture struct{ Head, Tree string } }
		require.NoError(t, json.Unmarshal(read(), &latest))
		require.Equal(t, working.Head, latest.Capture.Head)
		require.Equal(t, working.Tree, latest.Capture.Tree)
		require.Equal(t, beforeWorking, generation(), "working capture cannot enqueue edited")
		require.Equal(t, []byte("working tree bytes"), git("-C", store, "show", working.Head+":pending.txt"))
		return
	}
	var liveReaders, typingReaders []*liveWriterProbe
	itemWant := "item bytes\n"
	if mode == "live" {
		for i := 0; i < 2; i++ {
			reader := openLiveWriterProbe(t, registry, branch, "README.md", actor)
			reader.converge(t, "hello")
			liveReaders = append(liveReaders, reader)
			typing := openLiveWriterProbe(t, registry, branch, "item.txt", actor)
			typing.converge(t, itemWant)
			typingReaders = append(typingReaders, typing)
		}
	}
	require.NoError(t, os.WriteFile(filepath.Join(state, "qualification-frozen.arm"), nil, 0600))
	rewrite := make(chan error, 1)
	go func() { _, err := registry.Rebase(ctx, branch, actor, onto); rewrite <- err }()
	require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(state, "qualification-frozen.hit")); return err == nil }, 10*time.Second, 5*time.Millisecond)
	if mode == "live" {
		// Input is accepted while the production executor is at its native
		// frozen barrier, but cannot save into the working copy mid-rewrite.
		itemWant += "PENDING 🧑🏽‍💻 e\u0301 "
		typingReaders[0].send(t, codeSync(2, codeInsert(typingReaders[0].client, "PENDING 🧑🏽‍💻 e\u0301 ")))
		require.Equal(t, "item bytes\n", string(mustReadMutationFile(t, filepath.Join(root, "item.txt"))))
	}
	writes := []struct {
		path, body string
		status     int
	}{
		{"README.md", `{"content":"must not replace target","base_digest":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}`, 409},
		{"queued.txt", `{"content":"queued bytes","base_digest":"absent"}`, 200},
	}
	done := make([]chan reply, len(writes))
	for i, w := range writes {
		done[i] = make(chan reply, 1)
		go func(i int, path, body string) { done[i] <- request("PUT", path, body) }(i, w.path, w.body)
	}
	// Neither queued write may finish at the native hold.
	for i := range done {
		select {
		case res := <-done[i]:
			t.Fatalf("write completed while frozen: %+v", res)
		case <-time.After(150 * time.Millisecond):
		}
	}
	require.Equal(t, "hello", string(mustReadMutationFile(t, filepath.Join(root, "README.md"))))
	require.NoError(t, os.Remove(filepath.Join(state, "qualification-frozen.hit")))
	require.NoError(t, <-rewrite)
	// The real daemon, rather than the HTTP harness, owns hold measurements.
	// This is native component evidence; kernel-freeze qualification stays on VM.
	require.Eventually(t, func() bool {
		log, err := os.ReadFile(filepath.Join(evidence, "machined-"+branch+".log"))
		require.NoError(t, err)
		var measured int
		for _, line := range strings.Split(string(log), "\n") {
			var sample struct {
				Event     string `json:"event"`
				Operation string `json:"operation"`
				Start     uint64 `json:"start_ns"`
				End       uint64 `json:"end_ns"`
				Hold      uint64 `json:"hold_ns"`
			}
			if json.Unmarshal([]byte(line), &sample) != nil || sample.Event != "mutation_hold" {
				continue
			}
			require.Equal(t, "rebase", sample.Operation)
			require.Greater(t, sample.Hold, uint64(0))
			require.GreaterOrEqual(t, sample.End, sample.Start)
			require.Equal(t, sample.End-sample.Start, sample.Hold)
			measured++
		}
		return measured == 1

	}, 5*time.Second, time.Millisecond)

	for i, w := range writes {
		res := <-done[i]
		require.NoError(t, res.err)
		require.Equal(t, w.status, res.status, "%s", res.body)
		if w.status == 409 {
			require.Contains(t, string(res.body), `"code":"stale"`)
			require.Contains(t, string(res.body), "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7")
		}
	}
	for path, want := range map[string]string{"README.md": "world", "queued.txt": "queued bytes", "item.txt": itemWant} {
		res := request("GET", path, "")
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		var file struct{ Content string }
		require.NoError(t, json.Unmarshal(res.body, &file))
		require.Equal(t, want, file.Content)
	}
	for _, reader := range liveReaders {
		reader.converge(t, "world")
	}
	for _, reader := range typingReaders {
		reader.converge(t, itemWant)
	}
	after, err := registry.Capture(ctx, branch)
	require.NoError(t, err)
	for path, want := range map[string]string{"README.md": "world", "queued.txt": "queued bytes", "item.txt": itemWant} {
		require.Equal(t, []byte(want), git("-C", store, "show", after.Head+":"+path), path)
	}
	if mode == "live" {
		// After rewrite, fresh writes to the already-open file are a document
		// transaction. Both independently reconstructed replicas must see it.
		body, err := json.Marshal(map[string]string{"content": "world\nFRESH 🧑🏽‍💻 e\u0301 漢字", "base_digest": "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7"})
		require.NoError(t, err)
		res := request("PUT", "README.md", string(body))
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		for _, reader := range liveReaders {
			reader.converge(t, "world\nFRESH 🧑🏽‍💻 e\u0301 漢字")
		}
		awaitIdle()
		captured, err := registry.Capture(ctx, branch)
		if err == machined.ErrNotReady {
			// A completed snapshot can still have debouncing jj metadata.
			// Honor the production quiet gate before a second capture.
			awaitIdle()
			captured, err = registry.Capture(ctx, branch)
		}
		require.NoError(t, err)
		require.Equal(t, []byte("world\nFRESH 🧑🏽‍💻 e\u0301 漢字"), git("-C", store, "show", captured.Head+":README.md"))
		// A real outside jj move leaves the item; Return must reconcile the
		// same open document from the item snapshot without a new epoch.
		awaitIdle()
		jjCall("new", base)
		// The metadata watcher must first admit the moved-off fact. An early
		// Return is unsupported and makes no mutation; success ends polling.
		require.Eventually(t, func() bool {
			_, err = registry.ReturnToItem(ctx, branch, actor)
			return err == nil
		}, 5*time.Second, 10*time.Millisecond)
		for _, reader := range liveReaders {
			reader.converge(t, "world\nFRESH 🧑🏽‍💻 e\u0301 漢字")
		}
		for _, reader := range typingReaders {
			reader.converge(t, itemWant)
		}
		require.Equal(t, []byte("world\nFRESH 🧑🏽‍💻 e\u0301 漢字"), mustReadMutationFile(t, filepath.Join(root, "README.md")))
		require.Equal(t, []byte(itemWant), mustReadMutationFile(t, filepath.Join(root, "item.txt")))
		for _, reader := range liveReaders {
			require.NoError(t, reader.stream.Close())
			reopened := openLiveWriterProbe(t, registry, branch, "README.md", actor)
			require.Equal(t, reader.epoch, reopened.epoch)
			reopened.converge(t, "world\nFRESH 🧑🏽‍💻 e\u0301 漢字")
		}
	}
}
func mustReadMutationFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	return data
}

// Keep the adapter's production refusal mapping while retaining native failures.
type mutationWriteObserver struct {
	registry *machined.Registry
	t        *testing.T
}

func (w mutationWriteObserver) WriteFiles(ctx context.Context, branch string, actor []byte, changes []machined.FileChange) (machined.WriteResult, error) {
	result, err := w.registry.WriteFiles(ctx, branch, actor, changes)
	w.t.Logf("native queued write: %+v %v", result, err)
	return result, err
}
