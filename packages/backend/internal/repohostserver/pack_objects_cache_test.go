package repohostserver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPackObjectsCacheable(t *testing.T) {
	want := strings.Repeat("a", 40)
	have := strings.Repeat("b", 40)
	for _, tc := range []struct {
		name  string
		input string
		want  bool
	}{
		{"clone", want + "\n--not\n\n", true},
		{"shallow clone", "--shallow " + have + "\n" + want + "\n--not\n\n", true},
		{"no --not section", want + "\n", true},
		{"fetch with haves", want + "\n--not\n" + have + "\n\n", false},
		{"negated want", want + "\n^" + have + "\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, packObjectsCacheable([]byte(tc.input)))
		})
	}
}

func TestPackObjectsKeySeparatesRepositoryArgumentsAndRevisions(t *testing.T) {
	base := packObjectsKey("/repos/a", []string{"git", "pack-objects", "--thin"}, []byte("x\n"))
	require.Equal(t, base, packObjectsKey("/repos/a", []string{"git", "pack-objects", "--thin"}, []byte("x\n")))
	require.NotEqual(t, base, packObjectsKey("/repos/b", []string{"git", "pack-objects", "--thin"}, []byte("x\n")))
	require.NotEqual(t, base, packObjectsKey("/repos/a", []string{"git", "pack-objects", "--shallow"}, []byte("x\n")))
	require.NotEqual(t, base, packObjectsKey("/repos/a", []string{"git", "pack-objects", "--thin"}, []byte("y\n")))
	// Argument boundaries are part of the key.
	require.NotEqual(t,
		packObjectsKey("/r", []string{"ab", "c"}, nil),
		packObjectsKey("/r", []string{"a", "bc"}, nil))
}

func TestIsPackObjectsHookInvocation(t *testing.T) {
	require.True(t, isPackObjectsHookInvocation([]string{"git", "--shallow-file", "", "pack-objects", "--revs"}))
	require.True(t, isPackObjectsHookInvocation([]string{"git", "pack-objects"}))
	require.False(t, isPackObjectsHookInvocation(nil))
	require.False(t, isPackObjectsHookInvocation([]string{"git"}))
	require.False(t, isPackObjectsHookInvocation([]string{"-test.run", "pack-objects"}))
	require.False(t, isPackObjectsHookInvocation([]string{"git", "upload-pack"}))
}

func TestPackObjectsChildEnvDropsHookMarkers(t *testing.T) {
	env := packObjectsChildEnv([]string{
		"PATH=/bin",
		packObjectsCacheDirEnv + "=/c",
		packObjectsCacheMaxBytesEnv + "=1",
		packObjectsCacheTTLEnv + "=1s",
		packObjectsGitEnv + "=/bin/git",
		"GIT_CONFIG_COUNT=1",
	})
	require.Equal(t, []string{"PATH=/bin", "GIT_CONFIG_COUNT=1"}, env)
}

// countingRun is a pack-objects stand-in that counts builds and writes body.
func countingRun(builds *atomic.Int32, body string, code int) func(io.Writer) int {
	return func(out io.Writer) int {
		builds.Add(1)
		_, _ = io.WriteString(out, body)
		return code
	}
}

func TestPackObjectsCacheServesARepeatFromDisk(t *testing.T) {
	c := packObjectsHookCache{dir: t.TempDir(), maxBytes: 1 << 20, ttl: time.Minute}
	var builds atomic.Int32
	for i := 0; i < 3; i++ {
		var out bytes.Buffer
		require.Equal(t, 0, c.serve("k", &out, countingRun(&builds, "PACK", 0)))
		require.Equal(t, "PACK", out.String())
	}
	require.EqualValues(t, 1, builds.Load())
	require.FileExists(t, filepath.Join(c.dir, "k.pack"))
}

func TestPackObjectsCacheRebuildsAfterTTL(t *testing.T) {
	now := time.Now()
	c := packObjectsHookCache{dir: t.TempDir(), maxBytes: 1 << 20, ttl: time.Minute, now: func() time.Time { return now }}
	var builds atomic.Int32
	var out bytes.Buffer
	require.Equal(t, 0, c.serve("k", &out, countingRun(&builds, "old", 0)))
	now = now.Add(2 * time.Minute)
	out.Reset()
	require.Equal(t, 0, c.serve("k", &out, countingRun(&builds, "new", 0)))
	require.Equal(t, "new", out.String())
	require.EqualValues(t, 2, builds.Load())
}

func TestPackObjectsCacheDoesNotKeepAFailedBuild(t *testing.T) {
	c := packObjectsHookCache{dir: t.TempDir(), maxBytes: 1 << 20, ttl: time.Minute}
	var builds atomic.Int32
	var out bytes.Buffer
	require.Equal(t, 7, c.serve("k", &out, countingRun(&builds, "partial", 7)))
	require.Empty(t, out.String(), "a failed build must not send its partial pack")
	entries, err := os.ReadDir(c.dir)
	require.NoError(t, err)
	for _, entry := range entries {
		require.False(t, strings.HasSuffix(entry.Name(), ".pack") || strings.HasSuffix(entry.Name(), ".tmp"), entry.Name())
	}
	require.Equal(t, 0, c.serve("k", &out, countingRun(&builds, "PACK", 0)))
	require.EqualValues(t, 2, builds.Load())
}

func TestPackObjectsCacheServesButDropsAPackOverTheBudget(t *testing.T) {
	c := packObjectsHookCache{dir: t.TempDir(), maxBytes: 3, ttl: time.Minute}
	var builds atomic.Int32
	for i := 0; i < 2; i++ {
		var out bytes.Buffer
		require.Equal(t, 0, c.serve("k", &out, countingRun(&builds, "TOO BIG", 0)))
		require.Equal(t, "TOO BIG", out.String())
	}
	require.EqualValues(t, 2, builds.Load())
	require.NoFileExists(t, filepath.Join(c.dir, "k.pack"))
}

func TestPackObjectsCacheBuildsOnceForConcurrentRequests(t *testing.T) {
	c := packObjectsHookCache{dir: t.TempDir(), maxBytes: 1 << 20, ttl: time.Minute}
	var builds atomic.Int32
	release := make(chan struct{})
	slowRun := func(out io.Writer) int {
		builds.Add(1)
		<-release
		_, _ = io.WriteString(out, "PACK")
		return 0
	}
	var wg sync.WaitGroup
	outs := make([]bytes.Buffer, 8)
	for i := range outs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			require.Equal(t, 0, c.serve("k", &outs[i], slowRun))
		}(i)
	}
	require.Eventually(t, func() bool { return builds.Load() == 1 }, 5*time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	require.EqualValues(t, 1, builds.Load())
	for i := range outs {
		require.Equal(t, "PACK", outs[i].String())
	}
}

func TestPackObjectsCacheEvictsLeastRecentlyServedOverBudget(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	c := packObjectsHookCache{dir: dir, maxBytes: 10, ttl: time.Hour, now: func() time.Time { return now }}
	write := func(name string, size int, age time.Duration) {
		path := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0o600))
		require.NoError(t, os.Chtimes(path, now.Add(-age), now.Add(-age)))
	}
	write("old.pack", 6, 3*time.Minute)
	write("mid.pack", 4, 2*time.Minute)
	write("new.pack", 4, time.Minute)
	write("expired.pack", 1, 2*time.Hour)
	write("dead.1.tmp", 1, 2*time.Hour)
	write("idle.lock", 0, 2*time.Hour)
	write("live.lock", 0, time.Minute)
	c.evict(filepath.Join(dir, "new.pack"))
	for _, gone := range []string{"old.pack", "expired.pack", "dead.1.tmp"} {
		require.NoFileExists(t, filepath.Join(dir, gone))
	}
	for _, kept := range []string{"mid.pack", "new.pack", "live.lock", "idle.lock"} {
		require.FileExists(t, filepath.Join(dir, kept))
	}
}

func TestNewPackObjectsCache(t *testing.T) {
	cache, err := newPackObjectsCache(Config{})
	require.NoError(t, err)
	require.Nil(t, cache, "an empty directory disables the cache")
	require.Nil(t, cache.hookConfig())
	require.Nil(t, cache.hookEnv())

	dir := filepath.Join(t.TempDir(), "cache")
	cache, err = newPackObjectsCache(Config{PackObjectsCacheDir: dir})
	require.NoError(t, err)
	require.DirExists(t, dir)
	require.Equal(t, defaultPackObjectsCacheMaxBytes, cache.maxBytes)
	require.Equal(t, defaultPackObjectsCacheTTL, cache.ttl)
	exe, err := os.Executable()
	require.NoError(t, err)
	require.Equal(t, []string{"uploadpack.packObjectsHook", shellQuoteArg(exe)}, cache.hookConfig())
	require.Contains(t, cache.hookEnv(), packObjectsCacheDirEnv+"="+dir)
}

func TestPackObjectsCacheFromEnv(t *testing.T) {
	storage := t.TempDir()
	for _, tc := range []struct {
		name, dir, max, ttl string
		wantDir             string
		wantErr             string
	}{
		{name: "default", wantDir: filepath.Join(storage, packObjectsCacheDirName)},
		{name: "off", dir: "off", wantDir: ""},
		{name: "custom", dir: "/var/cache/packs", max: "1024", ttl: "1m", wantDir: "/var/cache/packs"},
		{name: "bad max", max: "-1", wantErr: "MAX_BYTES"},
		{name: "bad ttl", ttl: "soon", wantErr: "TTL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SMITHERS_REPO_HOST_PACK_CACHE_DIR", tc.dir)
			t.Setenv("SMITHERS_REPO_HOST_PACK_CACHE_MAX_BYTES", tc.max)
			t.Setenv("SMITHERS_REPO_HOST_PACK_CACHE_TTL", tc.ttl)
			cfg := Config{StoragePath: storage}
			err := packObjectsCacheFromEnv(&cfg)
			if tc.wantErr != "" {
				require.ErrorContains(t, err, tc.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.wantDir, cfg.PackObjectsCacheDir)
			if tc.max != "" {
				require.EqualValues(t, 1024, cfg.PackObjectsCacheMaxBytes)
				require.Equal(t, time.Minute, cfg.PackObjectsCacheTTL)
			}
		})
	}
}

// TestUploadPackCloneSharesOnePack runs real git end to end: clients fetch
// over smart HTTP from streamGitRPCCached, git runs this test binary as its
// pack-objects hook (see init), and the backend's git counts the real pack-objects
// runs.
func TestUploadPackCloneSharesOnePack(t *testing.T) {
	realGit, err := exec.LookPath("git")
	require.NoError(t, err)
	gitDir, commits := packCacheFixtureRepo(t, realGit)

	// The backend's git (hostexec) is a wrapper that records each real
	// pack-objects the hook runs through it, then runs git.
	trace := filepath.Join(t.TempDir(), "builds.log")
	wrapper := filepath.Join(t.TempDir(), "git")
	require.NoError(t, os.WriteFile(wrapper, []byte("#!/bin/sh\ncase \" $* \" in *\" pack-objects \"*) echo build >> '"+trace+"' ;; esac\nexec '"+realGit+"' \"$@\"\n"), 0o755))
	useGitProgram(t, wrapper)
	builds := func() int {
		raw, _ := os.ReadFile(trace)
		return strings.Count(string(raw), "build")
	}

	cache, err := newPackObjectsCache(Config{PackObjectsCacheDir: filepath.Join(t.TempDir(), "cache")})
	require.NoError(t, err)
	server := httptest.NewServer(packCacheSmartHTTP(t, gitDir, cache))
	t.Cleanup(server.Close)
	remote := server.URL + "/repo.git"

	fetch := func(depth string, rev string) string {
		dir := t.TempDir()
		runGit(t, realGit, "", "init", "--quiet", dir)
		args := []string{"-C", dir, "-c", "protocol.version=0", "fetch", "--quiet", "--no-tags"}
		if depth != "" {
			args = append(args, "--depth", depth)
		}
		runGit(t, realGit, "", append(args, remote, rev)...)
		runGit(t, realGit, "", "-C", dir, "checkout", "--quiet", "--detach", "FETCH_HEAD")
		return dir
	}

	// Identical shallow clones share one pack, including concurrent ones.
	var wg sync.WaitGroup
	dirs := make([]string, 4)
	for i := range dirs {
		wg.Add(1)
		go func(i int) { defer wg.Done(); dirs[i] = fetch("2", commits[2]) }(i)
	}
	wg.Wait()
	require.Equal(t, 1, builds(), "four identical clones build one pack")
	for _, dir := range dirs {
		require.Equal(t, commits[2], strings.TrimSpace(runGit(t, realGit, "", "-C", dir, "rev-parse", "HEAD")))
		require.Equal(t, "2", strings.TrimSpace(runGit(t, realGit, "", "-C", dir, "rev-list", "--count", "HEAD")))
		require.Equal(t, "true", strings.TrimSpace(runGit(t, realGit, "", "-C", dir, "rev-parse", "--is-shallow-repository")))
		runGit(t, realGit, "", "-C", dir, "fsck", "--no-dangling")
	}

	// A different depth or revision is a different pack.
	full := fetch("", commits[2])
	require.Equal(t, 2, builds())
	require.Equal(t, "3", strings.TrimSpace(runGit(t, realGit, "", "-C", full, "rev-list", "--count", "HEAD")))
	fetch("2", commits[1])
	require.Equal(t, 3, builds())

	// An incremental fetch with haves bypasses the cache. Haves come from
	// the client's refs.
	runGit(t, realGit, "", "-C", full, "update-ref", "refs/heads/main", "HEAD")
	runGit(t, realGit, "", "-C", full, "-c", "protocol.version=0", "fetch", "--quiet", "--no-tags", remote, commits[3])
	require.Equal(t, 4, builds())
	packs, err := filepath.Glob(filepath.Join(cache.dir, "*.pack"))
	require.NoError(t, err)
	require.Len(t, packs, 3)
}

func packCacheFixtureRepo(t *testing.T, realGit string) (string, []string) {
	t.Helper()
	work := t.TempDir()
	runGit(t, realGit, "", "init", "--quiet", "-b", "main", work)
	var commits []string
	for i := 0; i < 4; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(work, "f.txt"), []byte(fmt.Sprintf("v%d\n", i)), 0o644))
		runGit(t, realGit, work, "add", "f.txt")
		runGit(t, realGit, work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", fmt.Sprint(i))
		commits = append(commits, strings.TrimSpace(runGit(t, realGit, work, "rev-parse", "HEAD")))
	}
	bare := filepath.Join(t.TempDir(), "repo.git")
	runGit(t, realGit, "", "clone", "--quiet", "--bare", work, bare)
	return bare, commits
}

func packCacheSmartHTTP(t *testing.T, gitDir string, cache *packObjectsCache) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/info/refs"):
			cmd := exec.Command("git", "upload-pack", "--stateless-rpc", "--advertise-refs", gitDir)
			cmd.Env = gitServiceEnv("upload-pack", maxDecompressedGitRequestSize, 0, true)
			out, err := cmd.Output()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
			_, _ = io.WriteString(w, "001e# service=git-upload-pack\n0000")
			_, _ = w.Write(out)
		case strings.HasSuffix(r.URL.Path, "/git-upload-pack"):
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			if err := streamGitRPCCached(context.Background(), gitDir, "upload-pack", r.Body, w, maxDecompressedGitRequestSize, 0, cache); err != nil {
				t.Errorf("upload-pack: %v", err)
			}
		default:
			http.NotFound(w, r)
		}
	})
}

func runGit(t *testing.T, git, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(git, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "HOME="+t.TempDir())
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %s: %s", strings.Join(args, " "), out)
	return string(out)
}

// runPackObjectsHook is the hook process body; a stand-in for git, named by
// the absolute path upload-pack's environment carries, runs pack-objects so
// each branch is observable.
func TestRunPackObjectsHook(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(t.TempDir())
	t.Setenv(packObjectsCacheMaxBytesEnv, "1048576")
	t.Setenv(packObjectsCacheTTLEnv, "1m")
	counter := filepath.Join(t.TempDir(), "runs")
	standIn := func(body string) string {
		path := filepath.Join(t.TempDir(), "git")
		require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755))
		return path
	}
	// The stand-in echoes its revision list so the served bytes prove which
	// input produced them.
	t.Setenv(packObjectsGitEnv, standIn("echo run >> "+shellQuoteArg(counter)+"; cat"))
	args := []string{"git", "pack-objects", "--revs"}
	runs := func() int {
		raw, _ := os.ReadFile(counter)
		return strings.Count(string(raw), "run")
	}
	clone := strings.Repeat("a", 40) + "\n--not\n\n"
	for i := 0; i < 2; i++ {
		var out, errOut bytes.Buffer
		require.Equal(t, 0, runPackObjectsHook(args, dir, strings.NewReader(clone), &out, &errOut), errOut.String())
		require.Equal(t, clone, out.String())
	}
	require.Equal(t, 1, runs(), "the repeat clone is served from the cache")

	fetch := strings.Repeat("a", 40) + "\n--not\n" + strings.Repeat("b", 40) + "\n\n"
	for i := 0; i < 2; i++ {
		var out bytes.Buffer
		require.Equal(t, 0, runPackObjectsHook(args, dir, strings.NewReader(fetch), &out, io.Discard))
		require.Equal(t, fetch, out.String())
	}
	require.Equal(t, 3, runs(), "a fetch with haves always runs pack-objects")

	var errOut bytes.Buffer
	t.Setenv(packObjectsGitEnv, standIn("exit 3"))
	require.Equal(t, 3, runPackObjectsHook(args, dir, strings.NewReader(fetch), io.Discard, &errOut))
	t.Setenv(packObjectsGitEnv, filepath.Join(t.TempDir(), "missing"))
	require.Equal(t, 128, runPackObjectsHook(args, dir, strings.NewReader(fetch), io.Discard, &errOut))
	require.Contains(t, errOut.String(), "run pack-objects")

	// Ruling §17.3 (c): pack-objects runs only by the absolute path the
	// backend named; never a relative one or a name looked up through PATH.
	for _, git := range []string{"", "git", "bin/git"} {
		errOut.Reset()
		t.Setenv(packObjectsGitEnv, git)
		require.Equal(t, 128, runPackObjectsHook(args, dir, strings.NewReader(fetch), io.Discard, &errOut), git)
		require.Contains(t, errOut.String(), "no git named by an absolute path")
	}
}

func TestRunPackObjectsHookRefusesAnOversizedRevisionList(t *testing.T) {
	var errOut bytes.Buffer
	huge := io.LimitReader(zeroReader{}, maxPackObjectsInput+1)
	require.Equal(t, 128, runPackObjectsHook([]string{"true"}, t.TempDir(), huge, io.Discard, &errOut))
	require.Contains(t, errOut.String(), "too large")
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestPackObjectsHookEnvFallbacks(t *testing.T) {
	t.Setenv(packObjectsCacheMaxBytesEnv, "nope")
	t.Setenv(packObjectsCacheTTLEnv, "-1s")
	require.Equal(t, int64(7), envInt64(packObjectsCacheMaxBytesEnv, 7))
	require.Equal(t, time.Second, envDuration(packObjectsCacheTTLEnv, time.Second))
	t.Setenv(packObjectsCacheMaxBytesEnv, "9")
	t.Setenv(packObjectsCacheTTLEnv, "2s")
	require.Equal(t, int64(9), envInt64(packObjectsCacheMaxBytesEnv, 7))
	require.Equal(t, 2*time.Second, envDuration(packObjectsCacheTTLEnv, time.Second))
}

func TestPackObjectsCacheFallsBackWhenTheDirectoryIsUnusable(t *testing.T) {
	c := packObjectsHookCache{dir: filepath.Join(t.TempDir(), "missing"), maxBytes: 1 << 20, ttl: time.Minute}
	var builds atomic.Int32
	var out bytes.Buffer
	require.Equal(t, 0, c.serve("k", &out, countingRun(&builds, "PACK", 0)))
	require.Equal(t, "PACK", out.String())
	require.EqualValues(t, 1, builds.Load())
}

func TestPackObjectsCacheEvictionPreservesActiveBuilder(t *testing.T) {
	c := packObjectsHookCache{dir: t.TempDir(), maxBytes: 1 << 20, ttl: time.Minute}
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan int, 1)
	var out bytes.Buffer
	go func() {
		done <- c.serve("active", &out, func(w io.Writer) int {
			close(started)
			<-release
			_, _ = io.WriteString(w, "PACK")
			return 0
		})
	}()
	<-started
	defer func() { close(release); require.Equal(t, 0, <-done); require.Equal(t, "PACK", out.String()) }()
	temps, err := filepath.Glob(filepath.Join(c.dir, "active.*.tmp"))
	require.NoError(t, err)
	require.Len(t, temps, 1)
	lockPath := filepath.Join(c.dir, "active.lock")
	before, err := os.Stat(lockPath)
	require.NoError(t, err)
	old := time.Now().Add(-2 * time.Minute)
	for _, path := range []string{lockPath, temps[0]} {
		require.NoError(t, os.Chtimes(path, old, old))
	}
	c.evict("")
	require.FileExists(t, temps[0], "eviction must not unlink the active builder's output")
	after, err := os.Stat(lockPath)
	require.NoError(t, err)
	require.True(t, os.SameFile(before, after), "waiters and new requests must use the same lock inode")
	lock, err := os.OpenFile(lockPath, os.O_RDWR, 0)
	require.NoError(t, err)
	defer lock.Close()
	require.Error(t, syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB), "another request must still be blocked by the builder")
}
