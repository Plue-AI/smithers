package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// jjInit creates a real jj repository with a git backend at repoPath, as the
// FFI's init does.
func jjInit(t *testing.T, repoPath string) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(repoPath), 0o755))
	if out, err := exec.Command("jj", "git", "init", "--no-colocate", repoPath).CombinedOutput(); err != nil {
		t.Fatalf("jj git init: %v: %s", err, out)
	}
	return repoGitDir(repoPath)
}

func gitOut(t *testing.T, gitDir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...).CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

func requireAutoMaintenanceOff(t *testing.T, gitDir string) {
	t.Helper()
	for _, setting := range autoMaintenanceOff {
		require.Equal(t, setting[1], gitOut(t, gitDir, "config", "--get", setting[0]), "%s in %s", setting[0], gitDir)
	}
}

func postJSON(t *testing.T, srv *Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// Repositories repo-host creates, inits, forks and wiki/docs stores, have
// git's automatic maintenance off from birth.
func TestNewRepositoriesHaveAutoMaintenanceOff(t *testing.T) {
	requireNativeLaneTools(t)
	mock := &mockFFI{
		initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
			jjInit(t, storePath)
			return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
		},
		initWikiRepoFn: func(storePath string) (bool, error) {
			jjInit(t, storePath)
			return true, nil
		},
	}
	srv := newTestServerWithMock(t, mock)

	rec := postJSON(t, srv, "/repos/init", `{"owner":"alice","repo":"demo"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	requireAutoMaintenanceOff(t, srv.config.GitBackendPath("alice", "demo"))

	// A fork of a repository that predates the setting still gets it.
	src := jjInit(t, srv.config.RepoPath("alice", "old"))
	rec = postJSON(t, srv, "/repos/fork", `{"src_owner":"alice","src_repo":"old","dst_owner":"bob","dst_repo":"copy"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	requireAutoMaintenanceOff(t, srv.config.GitBackendPath("bob", "copy"))
	_, err := exec.Command("git", "--git-dir", src, "config", "--get", "receive.autogc").Output()
	require.Error(t, err, "forking configured the source")

	wiki := srv.config.WikiRepoPath("alice", "demo")
	req := httptest.NewRequest(http.MethodPut, "/repos/alice:demo/wiki", nil)
	req.Header.Set("Authorization", validAuth())
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	requireAutoMaintenanceOff(t, repoGitDir(wiki))
}

// The startup sweep turns automatic maintenance off in repositories that
// predate the setting, sidecars included.
func TestStartupSweepDisablesAutoMaintenanceInExistingRepositories(t *testing.T) {
	requireNativeLaneTools(t)
	srv := newTestServer(t)
	repo := jjInit(t, srv.config.RepoPath("alice", "demo"))
	wiki := jjInit(t, srv.config.WikiRepoPath("alice", "demo"))
	srv.sweepAllRepositories(context.Background())
	requireAutoMaintenanceOff(t, repo)
	requireAutoMaintenanceOff(t, wiki)
}

// receive-pack starts no gc of its own: past git's thresholds, with gc in the
// foreground so one would finish before the push returns, the pushed objects
// stay loose, and the repository is queued for repo-host's pass instead.
func TestReceivePackRunsNoAutoGCAndQueuesMaintenance(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	gitDir := f.repo.gitDir
	gitOut(t, gitDir, "config", "gc.autoDetach", "false")
	require.NoError(t, disableAutoMaintenance(context.Background(), gitDir))
	writeTaggedBlobs(t, gitDir)
	_ = f.srv.takeMaintenanceDue()

	tip := f.commit("queued", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "q.txt"), []byte("q\n"), 0o644))
	})
	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"))
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Equal(t, tip, f.repo.refs()["refs/heads/main"])
	counts := gitOut(t, gitDir, "count-objects", "-v")
	require.Contains(t, counts, "packs: 0", counts)
	require.Equal(t, []string{f.srv.config.RepoPath("alice", "demo")}, f.srv.takeMaintenanceDue())
}

// writeTaggedBlobs writes 10000 loose blobs, each tagged, so they are
// reachable. They exceed gc.auto's default of 6700 (git estimates from
// objects/17, so the margin keeps the estimate above it).
func writeTaggedBlobs(t *testing.T, gitDir string) {
	t.Helper()
	blobs := t.TempDir()
	var paths strings.Builder
	for i := range 10000 {
		path := filepath.Join(blobs, fmt.Sprint(i))
		require.NoError(t, os.WriteFile(path, []byte(fmt.Sprintf("blob %d\n", i)), 0o644))
		paths.WriteString(path + "\n")
	}
	hash := exec.Command("git", "--git-dir", gitDir, "hash-object", "-w", "--stdin-paths")
	hash.Stdin = strings.NewReader(paths.String())
	out, err := hash.Output()
	require.NoError(t, err)
	oids := strings.Fields(string(out))
	var refs strings.Builder
	for i, oid := range oids {
		fmt.Fprintf(&refs, "create refs/tags/b%d %s\n", i, oid)
	}
	update := exec.Command("git", "--git-dir", gitDir, "update-ref", "--stdin")
	update.Stdin = strings.NewReader(refs.String())
	require.NoError(t, update.Run())
}

// Maintenance still reclaims space and packs refs: past git's own thresholds
// loose refs are packed and loose objects are packed away.
func TestMaintenancePacksRefsAndObjects(t *testing.T) {
	requireNativeLaneTools(t)
	srv := newTestServer(t)
	repoPath := srv.config.RepoPath("alice", "demo")
	gitDir := jjInit(t, repoPath)
	require.NoError(t, disableAutoMaintenance(context.Background(), gitDir))

	writeTaggedBlobs(t, gitDir)
	// git's own automatic gc stays off.
	gitOut(t, gitDir, "gc", "--auto", "--quiet")
	require.Contains(t, gitOut(t, gitDir, "count-objects", "-v"), "packs: 0")

	srv.maintainRepository(context.Background(), repoPath, nil)
	counts := gitOut(t, gitDir, "count-objects", "-v")
	require.Contains(t, counts, "in-pack: 10", counts)
	require.NotContains(t, counts, "packs: 0", counts)
	loose, err := filepath.Glob(filepath.Join(gitDir, "refs", "tags", "b*"))
	require.NoError(t, err)
	require.Empty(t, loose)
	packed, err := os.ReadFile(filepath.Join(gitDir, "packed-refs"))
	require.NoError(t, err)
	require.Contains(t, string(packed), "refs/tags/b9999")
	require.NoFileExists(t, filepath.Join(gitDir, "gc.pid"))
}

// Maintenance holds the repository lock for its whole run, so a writer's
// stale lock recovery waits for it and never removes the lock maintenance
// holds, however old.
func TestStaleLockRecoveryNeverRemovesMaintenanceLocks(t *testing.T) {
	requireNativeLaneTools(t)
	srv := newTestServer(t)
	repoPath := srv.config.RepoPath("alice", "demo")
	gitDir := jjInit(t, repoPath)
	lock := filepath.Join(gitDir, "packed-refs.lock")

	started, release := make(chan struct{}), make(chan struct{})
	var hookErr error
	lockSurvived := false
	maintenanceCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if slices.Contains(args, "gc") {
			// Maintenance's gc holds packed-refs.lock past staleGitLockAge.
			old := time.Now().Add(-2 * staleGitLockAge)
			hookErr = errors.Join(os.WriteFile(lock, nil, 0o644), os.Chtimes(lock, old, old))
			close(started)
			<-release
			_, statErr := os.Stat(lock)
			lockSurvived = statErr == nil
			hookErr = errors.Join(hookErr, os.Remove(lock))
		}
		return exec.CommandContext(ctx, name, args...)
	}
	t.Cleanup(func() { maintenanceCommandContext = exec.CommandContext })

	maintained := make(chan struct{})
	go func() {
		srv.maintainRepository(context.Background(), repoPath, nil)
		close(maintained)
	}()
	<-started
	written := make(chan struct{})
	go func() {
		unlock := srv.lockRepo(repoPath)
		unlock()
		close(written)
	}()
	select {
	case <-written:
		t.Fatal("a writer took the repository lock during maintenance")
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	<-maintained
	<-written
	require.NoError(t, hookErr)
	require.True(t, lockSurvived, "a writer removed maintenance's lock")
	require.Zero(t, testutil.ToFloat64(srv.metrics.staleGitLocks))
}

// Cancelled maintenance (Shutdown, timeout) leaves no process behind the lock:
// git's children get the signal and whatever remains is killed.
func TestCancelledMaintenanceLeavesNoProcess(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	maintenanceCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		// A child that ignores SIGTERM, like one a signal does not reach.
		return exec.CommandContext(ctx, "sh", "-c", `sh -c 'trap "" TERM; sleep 60' & echo $! > `+pidFile+`; wait`)
	}
	maintenanceWaitDelay = 100 * time.Millisecond
	t.Cleanup(func() { maintenanceCommandContext, maintenanceWaitDelay = exec.CommandContext, 10*time.Second })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { done <- runMaintenanceGit(ctx, t.TempDir(), gcArgs) }()
	require.Eventually(t, func() bool { _, err := os.Stat(pidFile); return err == nil }, 5*time.Second, 10*time.Millisecond)
	cancel()
	require.Error(t, <-done)
	raw, err := os.ReadFile(pidFile)
	require.NoError(t, err)
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	require.NoError(t, err)
	require.Eventually(t, func() bool { return syscall.Kill(pid, 0) != nil }, 5*time.Second, 10*time.Millisecond, "maintenance child outlived its lock")
}
