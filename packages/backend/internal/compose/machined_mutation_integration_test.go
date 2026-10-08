package compose

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
func TestMachinedMutationQueuedHTTPWrites(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if os.Getenv("SMITHERS_MACHINED_MUTATION_DEBUG") != "1" {
		t.Skip("debug rehearsal daemon with killpoints required")
	}
	require.NotEmpty(t, binary)
	server, provider, pool, branch, cookie := workspaceFileInstallFixture(t, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
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
	require.NoError(t, os.WriteFile(filepath.Join(state, "qualification-frozen.arm"), nil, 0600))
	rewrite := make(chan error, 1)
	go func() { _, err := registry.Rebase(ctx, branch, actor, onto); rewrite <- err }()
	require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(state, "qualification-frozen.hit")); return err == nil }, 10*time.Second, 5*time.Millisecond)
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
	for i, w := range writes {
		res := <-done[i]
		require.NoError(t, res.err)
		require.Equal(t, w.status, res.status, "%s", res.body)
		if w.status == 409 {
			require.Contains(t, string(res.body), `"code":"stale"`)
			require.Contains(t, string(res.body), "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7")
		}
	}
	for path, want := range map[string]string{"README.md": "world", "queued.txt": "queued bytes", "item.txt": "item bytes\n"} {
		res := request("GET", path, "")
		require.NoError(t, res.err)
		require.Equal(t, 200, res.status, "%s", res.body)
		var file struct{ Content string }
		require.NoError(t, json.Unmarshal(res.body, &file))
		require.Equal(t, want, file.Content)
	}
	after, err := registry.Capture(ctx, branch)
	require.NoError(t, err)
	for path, want := range map[string]string{"README.md": "world", "queued.txt": "queued bytes", "item.txt": "item bytes\n"} {
		require.Equal(t, []byte(want), git("-C", store, "show", after.Head+":"+path), path)
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
