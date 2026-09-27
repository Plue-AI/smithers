package repohostserver

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
)

// A repo-host killed while git held ref locks leaves packed-refs.lock and a
// loose ref's .lock behind, and git refuses every update they cover. The next
// write under the repository lock removes lock files old enough that their
// writer is gone; a fresh one, whose writer may still run, stays.
func TestStaleGitLocksFromACrashAreRecovered(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	gitDir := f.repo.gitDir
	old := time.Now().Add(-2 * staleGitLockAge)
	stale := []string{filepath.Join(gitDir, "packed-refs.lock"), filepath.Join(gitDir, "refs", "heads", "main.lock")}
	for _, path := range stale {
		require.NoError(t, os.WriteFile(path, []byte("crashed\n"), 0o644))
		require.NoError(t, os.Chtimes(path, old, old))
	}
	fresh := filepath.Join(gitDir, "refs", "heads", "other.lock")
	require.NoError(t, os.WriteFile(fresh, nil, 0o644))

	tip := f.commit("after the crash", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "crash.txt"), []byte("ok\n"), 0o644))
	})
	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"))
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "ok refs/heads/main")
	require.Equal(t, tip, f.repo.refs()["refs/heads/main"])
	for _, path := range stale {
		require.NoFileExists(t, path)
	}
	require.FileExists(t, fresh, "a lock whose writer may still run was removed")
	require.Equal(t, float64(2), testutil.ToFloat64(f.srv.metrics.staleGitLocks))
}

// HEAD.lock is recovered like a ref lock; refs/jj/ is never walked.
func TestStaleGitLockRecoveryCoversHEADAndSkipsJJPins(t *testing.T) {
	srv := newTestServer(t)
	gitDir := t.TempDir()
	old := time.Now().Add(-2 * staleGitLockAge)
	head := filepath.Join(gitDir, "HEAD.lock")
	pin := filepath.Join(gitDir, "refs", "jj", "keep", "abc.lock")
	require.NoError(t, os.MkdirAll(filepath.Dir(pin), 0o755))
	for _, path := range []string{head, pin} {
		require.NoError(t, os.WriteFile(path, nil, 0o644))
		require.NoError(t, os.Chtimes(path, old, old))
	}
	srv.recoverStaleGitLocks(gitDir)
	require.NoFileExists(t, head)
	require.FileExists(t, pin)
}
