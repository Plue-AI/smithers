package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Linux qualification of real outside writes through the installed watcher,
// bundle transfer, transactional host ingest and the composed /api/live door.
// An empty broker census deliberately qualifies only outside attribution.
func TestOutsideWatcherComposedInstallLive(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if binary == "" {
		t.Skip("requires installed rehearsal daemon and Linux user namespaces")
	}
	f := presenceInstall(t, true)
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	native := repohostffi.New(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, native.Load())
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "outside-watcher"}
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
	// Use the production qualifier over controlled registration facts. The
	// watcher, authenticated daemon and durable admission are real; no running
	// coding guest transcript is claimed by this Linux watcher case.
	var item string
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,workspace_id,owner_id,request_run_id,flow_digest,checks) VALUES($1,'todo','running',$2,$3,'pinned-notes-run',$4,$5) RETURNING id`, f.row.RepositoryID, f.row.ID, f.user.ID, strings.Repeat("a", 64), `{"flowSource":"`+strings.Repeat("b", 40)+`"}`).Scan(&item))
	jobStore, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: jobStore, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("watcher admission must not synchronously launch a coding host")
		return nil, machined.ErrNotReady
	})})
	require.NoError(t, err)
	authority, err := registry.MintBoot(f.row.ID, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET vm_id=$2 WHERE id=$1`, f.row.ID, f.row.ID)
	require.NoError(t, err)
	run := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(run, "machined"), 0700))
	bootFile, err := authority.FileForItem(0, machined.ItemBinding{})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(run, "machined", "boot"), bootFile, 0400))
	notes := &machined.OutsideChangeNotes{Runs: &machined.PinnedCodingNoteRuns{Host: qualifiedOutsideNoteHost(t, f, dispatcher, item, authority.ID)}, Dispatcher: dispatcher}
	stop, err := bindMachineEvents(ctx, registry, f.pool, client, nil, notes)
	require.NoError(t, err)
	t.Cleanup(stop)
	root := t.TempDir()
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	output, err := exec.Command(jj, "git", "init", root).CombinedOutput()
	require.NoError(t, err, string(output))
	// Byte paths cannot travel through the public UTF-8 watcher codec.
	// Exercise a preexisting name and a later modification through inotify.
	rawPath := "invalid-" + string([]byte{0xff}) + ".ts"
	require.NoError(t, os.WriteFile(filepath.Join(root, rawPath), []byte("raw before\n"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("node_modules/\n"), 0600))
	snapshot := exec.Command(jj, "status")
	snapshot.Dir = root
	output, err = snapshot.CombinedOutput()
	require.NoError(t, err, string(output))
	// A composed capture publishes with CAS against the head previously sent
	// to the guest. Give this real store that same initial branch head.
	headCommand := exec.Command(jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	headCommand.Dir = root
	initialHead, err := headCommand.Output()
	require.NoError(t, err)
	seedHead := strings.TrimSpace(string(initialHead))
	seedRef := "refs/smithers/fixture/seed"
	bundle := filepath.Join(t.TempDir(), "seed.bundle")
	for _, argv := range [][]string{
		{"-C", root, "update-ref", seedRef, seedHead},
		{"-C", root, "bundle", "create", bundle, seedRef},
		{"-C", store, "fetch", "--no-tags", bundle, seedRef + ":refs/smithers/branches/" + f.row.ID + "/head"},
	} {
		output, err = exec.Command("/usr/bin/git", argv...).CombinedOutput()
		require.NoError(t, err, string(output))
	}
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2,head_commit_id=$2 WHERE id=$1`, f.row.ID, seedHead)
	require.NoError(t, err)
	evidence := t.TempDir()
	t.Cleanup(func() {
		if t.Failed() {
			log, _ := os.ReadFile(filepath.Join(evidence, "machined-"+f.row.ID+".log"))
			t.Logf("installed daemon: %s", log)
		}
	})
	require.NoError(t, startRehearsalMachinedWith(t, ctx, registry, f.row.ID, root, evidence, binary, &machined.ItemBinding{}, &rehearsalRestart{Run: run}))
	// Initialization observes the ordinary tracked ignore file. Let that
	// setup burst settle before subscribing and measuring the outside edits.
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files WHERE path='.gitignore'`).Scan(&n)
		return err == nil && n == 1
	}, 20*time.Second, 100*time.Millisecond)
	var baselineBursts int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&baselineBursts))
	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s:activity"}`, f.row.ID))
	readPresenceFrame(t, socket)
	filesSocket := f.dial(t)
	sendPresenceFrame(t, filesSocket, fmt.Sprintf(`{"t":"sub","id":2,"topic":"branch:%s:files"}`, f.row.ID))
	readPresenceFrame(t, filesSocket)
	require.NoError(t, os.MkdirAll(filepath.Join(root, "node_modules", "outside-check"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(root, "node_modules", "outside-check", "ignored.ts"), []byte("ignored\n"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(root, rawPath), []byte("raw after\n"), 0600))
	for i := 0; i < 12; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(root, fmt.Sprintf("outside-%02d.ts", i)), []byte(fmt.Sprintf("outside %02d\n", i)), 0600))
	}
	var entries []struct {
		ID    string `json:"id"`
		Actor struct{ Kind string }
		Files []struct {
			Path      string
			AfterBlob string `json:"after_blob"`
		}
		Versions string
	}
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files WHERE path LIKE 'outside-%'`).Scan(&n)
		return err == nil && n == 12
	}, 20*time.Second, 100*time.Millisecond)
	// The already-open subscription receives the committed activity delta.
	delta := readPresenceFrame(t, socket)
	require.NoError(t, json.Unmarshal(delta.Data, &entries))
	require.Len(t, entries, 1)
	require.Equal(t, "outside", entries[0].Actor.Kind)
	require.Len(t, entries[0].Files, 12)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&count))
	require.Equal(t, baselineBursts+1, count)
	// A later actor-independent burst changes/deletes the same paths. The
	// first selection must keep its own end state rather than the new disk.
	require.NoError(t, os.WriteFile(filepath.Join(root, "outside-00.ts"), []byte("later\n"), 0600))
	require.NoError(t, os.Remove(filepath.Join(root, "outside-01.ts")))
	require.NoError(t, os.WriteFile(filepath.Join(root, "outside-02.ts"), []byte{0, 'b', 'i', 'n'}, 0600))
	require.Eventually(t, func() bool {
		var n int
		err := f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.burst'`).Scan(&n)
		return err == nil && n == baselineBursts+2
	}, 20*time.Second, 100*time.Millisecond)
	var laterEntry string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT data->>'id' FROM product_job_events WHERE event_type='branch.burst' ORDER BY sequence DESC LIMIT 1`).Scan(&laterEntry))
	require.NotEqual(t, entries[0].ID, laterEntry)
	// Capture crosses the production RPC/outbox/bundle/transaction boundary.
	// Read the independent text oracle directly from the retained tree.
	// This does not qualify native capture of non-UTF-8 names (C-COL-05).
	var capture machined.CaptureResult
	require.Eventually(t, func() bool {
		capture, err = registry.Capture(ctx, f.row.ID)
		// Another capture can observe a watcher event while this RPC drains;
		// the production client refuses that idle receipt and requires retry.
		if errors.Is(err, machined.ErrNotReady) {
			return false
		}
		require.NoError(t, err)
		return true
	}, 15*time.Second, 100*time.Millisecond)
	capturedText, err := exec.Command("/usr/bin/git", "-C", store, "show", capture.Head+":outside-00.ts").CombinedOutput()
	require.NoError(t, err, string(capturedText))
	require.Equal(t, []byte("later\n"), capturedText)
	capturedNames, err := exec.Command("/usr/bin/git", "-C", store, "ls-tree", "-r", "-z", "--name-only", capture.Head).CombinedOutput()
	require.NoError(t, err, string(capturedNames))
	require.NotContains(t, string(capturedNames), "node_modules/")
	var hiddenRows int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM burst_files WHERE path NOT LIKE 'outside-%' AND path<>'.gitignore'`).Scan(&hiddenRows))
	require.Zero(t, hiddenRows, "ignored and non-UTF-8 paths cannot become public edits")
	// Every file hint delivered before the ordered durable activity belongs to
	// a public path. Capture has drained all previous watcher work at this point.
	sendPresenceFrame(t, filesSocket, fmt.Sprintf(`{"t":"sub","id":3,"topic":"branch:%s:files"}`, f.row.ID))
	hints := 0
	for {
		frame := readPresenceFrame(t, filesSocket)
		require.NotContains(t, string(frame.Data), "node_modules")
		require.NotContains(t, string(frame.Data), "invalid-")
		if frame.ID == 3 {
			require.Equal(t, "snap", frame.T)
			break
		}
		if frame.ID == 2 && (frame.T == "delta" || frame.T == "snap") && strings.Contains(string(frame.Data), "outside-") {
			hints++
		}
	}
	require.Positive(t, hints, "the open File-card subscription must receive real write hints")
	// Join notes to committed facts rather than deriving expected file names
	// from a note or codec. Each real burst must have one atomic durable signal;
	// ignored and byte paths must never leak into the agent's notification.
	rows, err := f.pool.Query(ctx, `SELECT e.data->>'id',r.payload FROM product_job_events e LEFT JOIN product_job_requests r ON r.request_id='outside-change:' || $1 || ':' || (e.data->>'id') WHERE e.event_type='branch.burst' ORDER BY e.sequence`, f.row.ID)
	require.NoError(t, err)
	noteCount := 0
	for rows.Next() {
		var burst string
		var raw []byte
		require.NoError(t, rows.Scan(&burst, &raw))
		var saved struct {
			Target  flowruntime.Target `json:"target"`
			RunID   string             `json:"runId"`
			Payload struct {
				ID    string `json:"id"`
				Kind  string `json:"kind"`
				Actor struct {
					Kind string `json:"kind"`
				} `json:"actor"`
				Files []string `json:"files"`
			} `json:"payload"`
		}
		require.NoError(t, json.Unmarshal(raw, &saved))
		require.Equal(t, "pinned-notes-run", saved.RunID)
		require.Equal(t, item, saved.Target.BindingID)
		require.Equal(t, f.row.ID, saved.Target.WorkspaceID)
		require.Equal(t, burst, saved.Payload.ID)
		require.Equal(t, "outside_change", saved.Payload.Kind)
		require.Equal(t, "outside", saved.Payload.Actor.Kind)
		expected := []string{".gitignore"}
		if burst == entries[0].ID {
			expected = nil
			for i := 0; i < 12; i++ {
				expected = append(expected, fmt.Sprintf("outside-%02d.ts", i))
			}
		} else if burst == laterEntry {
			expected = []string{"outside-00.ts", "outside-01.ts", "outside-02.ts"}
		}
		require.ElementsMatch(t, expected, saved.Payload.Files)
		noteCount++
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Equal(t, baselineBursts+2, noteCount)
	var signalCount int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationSignal).Scan(&signalCount))
	require.Equal(t, noteCount, signalCount)

	require.NoError(t, registry.Close()) // retained objects require no live machine
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
	readDiff := func(branch, selector, cookie string, status int) services.BranchDiff {
		t.Helper()
		req := httptest.NewRequest("GET", f.origin+"/api/branches/"+branch+"/diff"+selector, nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		req.RemoteAddr = "127.0.0.1:61000"
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, status, rec.Code, rec.Body.String())
		var diff services.BranchDiff
		if status == 200 {
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &diff))
		}
		return diff
	}
	diff := readDiff(f.row.ID, "?entry="+entries[0].ID, f.cookie, 200)
	require.Len(t, diff.Files, 12)
	for i, file := range diff.Files {
		require.Equal(t, fmt.Sprintf("outside-%02d.ts", i), file.Path)
		require.Equal(t, "burst", file.Against.Kind)
		require.JSONEq(t, `{"kind":"outside","color_index":7}`, string(file.Against.Actor))
		require.Equal(t, entries[0].Versions, file.Version)
		require.Equal(t, []services.BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "+", Text: fmt.Sprintf("outside %02d", i)}}}}, file.Hunks)
	}
	laterDiff := readDiff(f.row.ID, "?entry="+laterEntry, f.cookie, 200)
	require.Len(t, laterDiff.Files, 3)
	require.Equal(t, "modified", laterDiff.Files[0].Change)
	require.Equal(t, []services.BranchDiffLine{{Op: "-", Text: "outside 00"}, {Op: "+", Text: "later"}}, laterDiff.Files[0].Hunks[0].Lines)
	require.Equal(t, "deleted", laterDiff.Files[1].Change)
	require.Equal(t, "absent", laterDiff.Files[1].PostDigest)
	require.Equal(t, []services.BranchDiffLine{{Op: "-", Text: "outside 01"}}, laterDiff.Files[1].Hunks[0].Lines)
	require.Equal(t, &services.BranchDiffBinary{BeforeBytes: 11, AfterBytes: 4}, laterDiff.Files[2].Binary)
	require.Empty(t, laterDiff.Files[2].Hunks)
	readDiff(f.row.ID, "?entry="+entries[0].ID, "", 401)
	readDiff(f.row.ID, "?entry="+entries[0].ID+"&at="+strings.Repeat("a", 40), f.cookie, 400)
	readDiff(f.row.ID, "?entry=invalid", f.cookie, 400)
	readDiff(f.row.ID, "?entry=00000000-0000-0000-0000-000000000001", f.cookie, 404)
	readDiff("00000000-0000-0000-0000-000000000001", "?entry="+entries[0].ID, f.cookie, 404)

	refs, err := exec.Command("/usr/bin/git", "-C", store, "for-each-ref", "--format=%(objectname)", "refs/smithers/branches/"+f.row.ID+"/bursts/").CombinedOutput()
	require.NoError(t, err, string(refs))
	require.Contains(t, string(refs), entries[0].Versions+"\n")
	require.Len(t, strings.Fields(string(refs)), baselineBursts+2)
	for i, file := range entries[0].Files {
		require.Equal(t, fmt.Sprintf("outside-%02d.ts", i), file.Path)
		bytes := []byte(fmt.Sprintf("outside %02d\n", i))
		sum := sha256.Sum256(bytes)
		var digest string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT post_digest FROM burst_files WHERE path=$1 AND post_digest=$2`, file.Path, hex.EncodeToString(sum[:])).Scan(&digest))
		require.Equal(t, hex.EncodeToString(sum[:]), digest)
		got, err := exec.Command("/usr/bin/git", "-C", store, "cat-file", "blob", file.AfterBlob).CombinedOutput()
		require.NoError(t, err, string(got))
		require.Equal(t, bytes, got)
	}
}
