package repohostserver

import (
	"bytes"
	"context"
	"crypto/sha1"
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
	"sync"
	"sync/atomic"
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

// taggedBlobCount is how many loose blobs writeTaggedBlobs writes. git
// estimates loose objects from objects/17 alone: gc --auto runs once that
// directory holds more than gc.auto/256 (27 for the default 6700). pack-refs
// --auto packs at 16 loose refs while packed-refs is small.
const taggedBlobCount = 40

// writeTaggedBlobs writes taggedBlobCount loose blobs, each tagged, so they
// are reachable, all under objects/17: past both of git's thresholds with a
// few dozen files rather than the ten thousand a uniform spread would need,
// which took minutes on a contended filesystem (#2883).
func writeTaggedBlobs(t *testing.T, gitDir string) {
	t.Helper()
	blobs := t.TempDir()
	var paths strings.Builder
	for i, written := 0, 0; written < taggedBlobCount; i++ {
		content := fmt.Sprintf("blob %d\n", i)
		if sum := sha1.Sum([]byte(fmt.Sprintf("blob %d\x00%s", len(content), content))); sum[0] != 0x17 {
			continue
		}
		path := filepath.Join(blobs, fmt.Sprint(written))
		require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
		paths.WriteString(path + "\n")
		written++
	}
	hash := exec.Command("git", "--git-dir", gitDir, "hash-object", "-w", "--stdin-paths")
	hash.Stdin = strings.NewReader(paths.String())
	out, err := hash.Output()
	require.NoError(t, err)
	oids := strings.Fields(string(out))
	require.Len(t, oids, taggedBlobCount)
	var refs strings.Builder
	for i, oid := range oids {
		require.True(t, strings.HasPrefix(oid, "17"), oid)
		fmt.Fprintf(&refs, "create refs/tags/b%d %s\n", i, oid)
	}
	update := exec.Command("git", "--git-dir", gitDir, "update-ref", "--stdin")
	update.Stdin = strings.NewReader(refs.String())
	require.NoError(t, update.Run())
}

// countObjects is git count-objects -v of gitDir, by field.
func countObjects(t *testing.T, gitDir string) map[string]int {
	t.Helper()
	counts := map[string]int{}
	for _, line := range strings.Split(gitOut(t, gitDir, "count-objects", "-v"), "\n") {
		name, value, ok := strings.Cut(line, ": ")
		require.True(t, ok, line)
		n, err := strconv.Atoi(value)
		require.NoError(t, err, line)
		counts[name] = n
	}
	return counts
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
	before := countObjects(t, gitDir)
	require.Zero(t, before["packs"])
	require.GreaterOrEqual(t, before["count"], taggedBlobCount)

	srv.maintainRepository(context.Background(), repoPath, nil)
	after := countObjects(t, gitDir)
	require.Zero(t, after["count"], after)
	require.Equal(t, before["count"], after["in-pack"], after)
	require.NotZero(t, after["packs"], after)
	loose, err := filepath.Glob(filepath.Join(gitDir, "refs", "tags", "b*"))
	require.NoError(t, err)
	require.Empty(t, loose)
	packed, err := os.ReadFile(filepath.Join(gitDir, "packed-refs"))
	require.NoError(t, err)
	require.Contains(t, string(packed), fmt.Sprintf("refs/tags/b%d\n", taggedBlobCount-1))
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
		unlock, err := srv.lockRepo(context.Background(), repoPath)
		if err == nil {
			unlock()
		}
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

// A repo-host that crashed mid-maintenance leaves its git running, in its own
// process group and holding no repository lock. The next repo-host terminates
// that group, and removes the git locks it held however fresh, before it
// exists to accept a write.
func TestStartupTerminatesOrphanedMaintenanceBeforeWrites(t *testing.T) {
	requireNativeLaneTools(t)
	storage := t.TempDir()
	cfg := Config{StoragePath: storage, AuthToken: testAuthToken}
	gitDir := jjInit(t, cfg.RepoPath("alice", "demo"))
	lock := filepath.Join(gitDir, "packed-refs.lock")
	childPid := filepath.Join(t.TempDir(), "child.pid")
	maintenanceCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		// gc holding packed-refs.lock, and a child that ignores SIGTERM.
		return exec.CommandContext(ctx, "sh", "-c", `echo $$ >&3; : > `+lock+`; sh -c 'trap "" TERM; sleep 60' & echo $! > `+childPid+`; wait`)
	}
	maintenanceWaitDelay = 200 * time.Millisecond
	t.Cleanup(func() { maintenanceCommandContext, maintenanceWaitDelay = exec.CommandContext, 10*time.Second })

	// The crashed repo-host's maintenance, still running: nothing cancels it.
	orphan := make(chan error, 1)
	go func() { orphan <- runMaintenanceGit(context.Background(), gitDir, gcArgs) }()
	require.Eventually(t, func() bool {
		raw, err := os.ReadFile(childPid)
		return err == nil && strings.TrimSpace(string(raw)) != ""
	}, 5*time.Second, 10*time.Millisecond)
	raw, err := os.ReadFile(childPid)
	require.NoError(t, err)
	child, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	require.NoError(t, err)
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	require.FileExists(t, lock)

	srv, err := NewWithFFI(cfg, &mockFFI{})
	require.NoError(t, err)
	pidFile, err := os.Open(filepath.Join(gitDir, maintenancePidFile))
	require.NoError(t, err)
	defer pidFile.Close()
	require.NoError(t, syscall.Flock(int(pidFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB), "orphaned maintenance outlived startup")
	require.Error(t, <-orphan)
	require.NoFileExists(t, lock)

	unlock, err := srv.lockRepo(context.Background(), cfg.RepoPath("alice", "demo"))
	require.NoError(t, err)
	gitOut(t, gitDir, "pack-refs", "--all")
	unlock()
}

// A pidfile whose lock nobody holds is one maintenance released: startup
// leaves the process it names alone, whatever now has that pid.
func TestStartupLeavesReleasedMaintenancePidfilesAlone(t *testing.T) {
	storage := t.TempDir()
	cfg := Config{StoragePath: storage, AuthToken: testAuthToken}
	gitDir := repoGitDir(cfg.RepoPath("alice", "demo"))
	require.NoError(t, os.MkdirAll(gitDir, 0o755))
	bystander := exec.Command("sleep", "60")
	bystander.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, bystander.Start())
	t.Cleanup(func() { _ = bystander.Process.Kill(); _ = bystander.Wait() })
	require.NoError(t, os.WriteFile(filepath.Join(gitDir, maintenancePidFile), []byte(strconv.Itoa(bystander.Process.Pid)+"\n"), 0o644))

	_, err := NewWithFFI(cfg, &mockFFI{})
	require.NoError(t, err)
	require.NoError(t, syscall.Kill(bystander.Process.Pid, 0))
}

var (
	standInOnce sync.Once
	standInDir  string
	standInErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if standInDir != "" {
		_ = os.RemoveAll(standInDir)
	}
	os.Exit(code)
}

// standIn builds, once per test binary, a program named name that sleeps
// until it is killed, whatever its arguments: the kernel names a process
// after the binary it runs, symlinks resolved.
func standIn(t *testing.T, name string) string {
	t.Helper()
	standInOnce.Do(func() {
		standInDir, standInErr = os.MkdirTemp("", "repohost-stand-in")
		if standInErr != nil {
			return
		}
		source := filepath.Join(standInDir, "main.go")
		standInErr = os.WriteFile(source, []byte("package main\n\nimport \"time\"\n\nfunc main() { time.Sleep(time.Hour) }\n"), 0o644)
		if standInErr != nil {
			return
		}
		out, err := exec.Command("go", "build", "-o", filepath.Join(standInDir, "sleeper"), source).CombinedOutput()
		if err != nil {
			standInErr = fmt.Errorf("go build: %w: %s", err, out)
		}
	})
	require.NoError(t, standInErr)
	path := filepath.Join(t.TempDir(), name)
	raw, err := os.ReadFile(filepath.Join(standInDir, "sleeper"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, raw, 0o755))
	return path
}

// startNamed starts, in its own group and in dir, a process named name with
// the arguments args, as git's gc would run. The channel closes when it
// exits.
func startNamed(t *testing.T, name, dir string, args ...string) (*exec.Cmd, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command(standIn(t, name), args...)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, cmd.Start())
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); <-exited })
	require.Eventually(t, func() bool {
		got, err := processName(cmd.Process.Pid)
		return err == nil && got == name
	}, 5*time.Second, 10*time.Millisecond)
	return cmd, exited
}

// writeGCPid writes gitDir's gc.pid, naming pid on this host, as git does.
func writeGCPid(t *testing.T, gitDir string, pid int) {
	t.Helper()
	host, err := os.Hostname()
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(gitDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(gitDir, "gc.pid"), []byte(fmt.Sprintf("%d %s", pid, host)), 0o644))
}

// A gc git's gc.pid names as running on this repository, from a repo-host
// that predates maintenance pidfiles (--git-dir) or git's own detached gc (in
// the git directory), is terminated at startup. Storage paths may hold spaces,
// as the desktop app's (Application Support) does.
func TestStartupTerminatesLiveGitGCFromGCPid(t *testing.T) {
	maintenanceWaitDelay = 200 * time.Millisecond
	t.Cleanup(func() { maintenanceWaitDelay = 10 * time.Second })
	cfg := Config{StoragePath: filepath.Join(t.TempDir(), "Application Support"), AuthToken: testAuthToken}
	byArg := repoGitDir(cfg.RepoPath("alice", "arg"))
	inDir := repoGitDir(cfg.RepoPath("alice", "cwd"))
	require.NoError(t, os.MkdirAll(inDir, 0o755))
	argGC, argExited := startNamed(t, "git", "", "--git-dir", byArg, "gc", "--auto")
	cwdGC, cwdExited := startNamed(t, "git", inDir, "gc", "--auto", "--quiet")
	writeGCPid(t, byArg, argGC.Process.Pid)
	writeGCPid(t, inDir, cwdGC.Process.Pid)

	srv, err := NewWithFFI(cfg, &mockFFI{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	for _, exited := range []<-chan struct{}{argExited, cwdExited} {
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			t.Fatal("the gc outlived startup")
		}
	}
	require.NoFileExists(t, filepath.Join(byArg, "gc.pid"))
	require.NoFileExists(t, filepath.Join(inDir, "gc.pid"))
	require.False(t, srv.locks.Held(cfg.RepoPath("alice", "arg")))
}

// A gc.pid survives its gc's SIGKILL, and its pid may be reused within
// gcPidMaxAge by another process, a git even. Startup signals none of them and
// removes a gc.pid that is established stale: its process is gone, is not
// git, runs gc on another repository, or started well after the file.
func TestStartupLeavesProcessesThatReusedAGCPidAlone(t *testing.T) {
	maintenanceWaitDelay = 200 * time.Millisecond
	t.Cleanup(func() { maintenanceWaitDelay = 10 * time.Second })
	cfg := Config{StoragePath: t.TempDir(), AuthToken: testAuthToken}
	later := repoGitDir(cfg.RepoPath("alice", "later"))
	other := repoGitDir(cfg.RepoPath("alice", "other"))
	notGit := repoGitDir(cfg.RepoPath("alice", "notgit"))
	gone := repoGitDir(cfg.RepoPath("alice", "gone"))

	// A git gc of this very repository that started after gc.pid was written.
	reused, _ := startNamed(t, "git", "", "--git-dir", later, "gc")
	writeGCPid(t, later, reused.Process.Pid)
	old := time.Now().Add(-2 * gcStartSlack)
	require.NoError(t, os.Chtimes(filepath.Join(later, "gc.pid"), old, old))
	// A git gc of another repository, a program that is not git, and a
	// process that exited.
	otherGC, _ := startNamed(t, "git", t.TempDir(), "gc", "--auto")
	notGitGC, _ := startNamed(t, "postgres", "", "--git-dir", notGit, "gc")
	exited := exec.Command("true")
	require.NoError(t, exited.Run())
	writeGCPid(t, other, otherGC.Process.Pid)
	writeGCPid(t, notGit, notGitGC.Process.Pid)
	writeGCPid(t, gone, exited.Process.Pid)

	srv, err := NewWithFFI(cfg, &mockFFI{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	for _, cmd := range []*exec.Cmd{reused, otherGC, notGitGC} {
		require.NoError(t, syscall.Kill(cmd.Process.Pid, 0), "startup signalled %v", cmd.Args)
	}
	for _, dir := range []string{later, other, notGit, gone} {
		require.NoFileExists(t, filepath.Join(dir, "gc.pid"))
		require.False(t, srv.locks.Held(repositoryPathOf(dir)))
	}
}

// Maintenance git killed on cancellation leaves no gc.pid of its own behind.
func TestCancelledMaintenanceRemovesGCPid(t *testing.T) {
	gitDir := t.TempDir()
	maintenanceCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "sh", "-c", `echo "$$ host" > `+filepath.Join(gitDir, "gc.pid")+`; sleep 60`)
	}
	maintenanceWaitDelay = 100 * time.Millisecond
	t.Cleanup(func() { maintenanceCommandContext, maintenanceWaitDelay = exec.CommandContext, 10*time.Second })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { done <- runMaintenanceGit(ctx, gitDir, gcArgs) }()
	require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(gitDir, "gc.pid")); return err == nil }, 5*time.Second, 10*time.Millisecond)
	cancel()
	require.Error(t, <-done)
	require.NoFileExists(t, filepath.Join(gitDir, "gc.pid"))
}

// requireHeld checks that a write to repoPath fails at once with 503.
func requireHeld(t *testing.T, srv *Server, repoPath string) {
	t.Helper()
	require.True(t, srv.locks.Held(repoPath))
	start := time.Now()
	_, err := srv.locks.Lock(context.Background(), repoPath)
	require.Less(t, time.Since(start), time.Second)
	var appErr *appError
	require.ErrorAs(t, err, &appErr)
	require.Equal(t, http.StatusServiceUnavailable, appErr.StatusCode)
	require.Equal(t, repositoryHeldCode, appErr.Code)
}

// requireWritable checks that a write to repoPath goes through.
func requireWritable(t *testing.T, srv *Server, repoPath string) {
	t.Helper()
	require.False(t, srv.locks.Held(repoPath))
	unlock, err := srv.locks.Lock(context.Background(), repoPath)
	require.NoError(t, err)
	unlock()
}

// requireReleased waits for writes to a held repository to go through.
func requireReleased(t *testing.T, srv *Server, repoPath string) {
	t.Helper()
	require.Eventually(t, func() bool { return !srv.locks.Held(repoPath) }, 5*time.Second, 10*time.Millisecond, "the held repository was never released")
	requireWritable(t, srv, repoPath)
}

// holdFixture is storage with a repository to hold and one to write.
func holdFixture(t *testing.T) (cfg Config, held, free string) {
	t.Helper()
	maintenanceWaitDelay, holdPollInterval = 100*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { maintenanceWaitDelay, holdPollInterval = 10*time.Second, 5*time.Second })
	cfg = Config{StoragePath: t.TempDir(), AuthToken: testAuthToken}
	held, free = cfg.RepoPath("alice", "held"), cfg.RepoPath("alice", "free")
	for _, repoPath := range []string{held, free} {
		require.NoError(t, os.MkdirAll(repoGitDir(repoPath), 0o755))
	}
	return cfg, held, free
}

// newHoldServer starts a server on cfg, stopped when the test ends.
func newHoldServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	srv, err := NewWithFFI(cfg, &mockFFI{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	return srv
}

// A maintenance group that outlives SIGKILL holds writes to its repository,
// and keeps its git locks, until it exits; other repositories stay writable.
func TestStartupHoldsARepositoryWhoseMaintenanceSurvives(t *testing.T) {
	cfg, held, free := holdFixture(t)
	gitDir := repoGitDir(held)
	lock := filepath.Join(gitDir, "packed-refs.lock")
	require.NoError(t, os.WriteFile(lock, nil, 0o644))
	// This process holds the pidfile lock, as a process SIGKILL cannot reach
	// would; the file names no group.
	survivor, err := os.Create(filepath.Join(gitDir, maintenancePidFile))
	require.NoError(t, err)
	require.NoError(t, syscall.Flock(int(survivor.Fd()), syscall.LOCK_EX|syscall.LOCK_NB))

	srv := newHoldServer(t, cfg)
	requireHeld(t, srv, held)
	requireWritable(t, srv, free)
	require.FileExists(t, lock)
	// Reads proceed, a writer waiting or not.
	read := make(chan struct{})
	go func() {
		unlock, err := srv.locks.RLock(context.Background(), held)
		if err == nil {
			unlock()
			close(read)
		}
	}()
	select {
	case <-read:
	case <-time.After(5 * time.Second):
		t.Fatal("a read of the held repository waited")
	}
	require.NoError(t, srv.syncGitRefs(context.Background(), held, gitDir))

	require.NoError(t, survivor.Close())
	requireReleased(t, srv, held)
	require.NoFileExists(t, lock)
	require.False(t, srv.locks.Held(held))
}

// A gc.pid naming a live git that runs gc on the repository but cannot be
// placed before the file (it started within gcStartSlack after it) is neither
// signalled nor removed: it holds writes to its repository until it exits.
func TestStartupHoldsARepositoryWhoseGCCannotBeIdentified(t *testing.T) {
	cfg, held, free := holdFixture(t)
	gitDir := repoGitDir(held)
	gc, gcExited := startNamed(t, "git", "", "--git-dir", gitDir, "gc")
	writeGCPid(t, gitDir, gc.Process.Pid)
	old := time.Now().Add(-time.Minute)
	require.NoError(t, os.Chtimes(filepath.Join(gitDir, "gc.pid"), old, old))

	srv := newHoldServer(t, cfg)
	requireHeld(t, srv, held)
	requireWritable(t, srv, free)
	require.NoError(t, syscall.Kill(gc.Process.Pid, 0), "startup signalled an unidentified process")
	require.FileExists(t, filepath.Join(gitDir, "gc.pid"))

	require.NoError(t, syscall.Kill(-gc.Process.Pid, syscall.SIGKILL))
	<-gcExited
	requireReleased(t, srv, held)
	require.NoFileExists(t, filepath.Join(gitDir, "gc.pid"))
}

// A live git whose arguments cannot be read holds its repository too.
func TestStartupHoldsARepositoryWhoseGCArgumentsCannotBeRead(t *testing.T) {
	cfg, held, free := holdFixture(t)
	gitDir := repoGitDir(held)
	gc, _ := startNamed(t, "git", "", "--git-dir", gitDir, "gc")
	writeGCPid(t, gitDir, gc.Process.Pid)
	var unreadable atomic.Bool
	unreadable.Store(true)
	lookupProcessArgs = func(pid int) ([]string, error) {
		if unreadable.Load() {
			return nil, errors.New("unreadable")
		}
		return processArgs(pid)
	}
	t.Cleanup(func() { lookupProcessArgs = processArgs })

	srv := newHoldServer(t, cfg)
	requireHeld(t, srv, held)
	requireWritable(t, srv, free)
	require.NoError(t, syscall.Kill(gc.Process.Pid, 0), "startup signalled an unidentified process")
	require.FileExists(t, filepath.Join(gitDir, "gc.pid"))

	// Once it can be identified, the gc is terminated and the hold released.
	unreadable.Store(false)
	requireReleased(t, srv, held)
	require.NoFileExists(t, filepath.Join(gitDir, "gc.pid"))
}

// Shutdown keeps a hold: nothing writes to the repository while its
// maintenance may still run.
func TestShutdownKeepsAHold(t *testing.T) {
	cfg, held, _ := holdFixture(t)
	survivor, err := os.Create(filepath.Join(repoGitDir(held), maintenancePidFile))
	require.NoError(t, err)
	defer survivor.Close()
	require.NoError(t, syscall.Flock(int(survivor.Fd()), syscall.LOCK_EX|syscall.LOCK_NB))

	srv := newHoldServer(t, cfg)
	require.True(t, srv.locks.Held(held))
	require.NoError(t, srv.Shutdown(context.Background()))
	require.NoError(t, survivor.Close())
	time.Sleep(5 * holdPollInterval)
	require.True(t, srv.locks.Held(held))
}
