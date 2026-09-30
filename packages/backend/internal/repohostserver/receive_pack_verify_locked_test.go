package repohostserver

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A push that holds its pack until repo-host holds the repository lock
// (ReceivePackMetadata.VerifyLocked, #2846) through repo-host's real handler.
func TestReceivePackVerifyLockedThroughRepoHost(t *testing.T) {
	push := func(t *testing.T, handler http.Handler, owner, repo string, body []byte, check func(context.Context) error) error {
		t.Helper()
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
		done := make(chan error, 1)
		go func() {
			done <- client.ProxyReceivePack(context.Background(), owner, repo, bytes.NewReader(body), io.Discard,
				repohost.ReceivePackMetadata{RepositoryID: 7, VerifyLocked: check})
		}()
		select {
		case err := <-done:
			return err
		case <-time.After(20 * time.Second):
			t.Fatal("the push never returned")
			return nil
		}
	}

	t.Run("the check passes and the push lands", func(t *testing.T) {
		f := newLaneHTTPFixture(t, nil)
		tip := f.commit("verified", func(dir string) {
			require.NoError(t, os.WriteFile(filepath.Join(dir, "v.txt"), []byte("v\n"), 0o644))
		})
		var calls atomic.Int32
		var locked atomic.Bool
		err := push(t, f.srv.Handler(), "alice", "demo", f.pushBody(f.base, tip, "refs/heads/main"), func(ctx context.Context) error {
			calls.Add(1)
			// The check runs while repo-host holds this push's write lock:
			// nobody else can take it.
			probe, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
			defer cancel()
			unlock, lockErr := f.srv.locks.Lock(probe, f.srv.config.RepoPath("alice", "demo"))
			if lockErr == nil {
				unlock()
			}
			locked.Store(lockErr != nil)
			return nil
		})
		require.NoError(t, err)
		require.EqualValues(t, 1, calls.Load())
		require.True(t, locked.Load(), "the check ran without the repository lock")
		require.Equal(t, tip, f.repo.refs()["refs/heads/main"])
	})

	t.Run("a refused check writes nothing", func(t *testing.T) {
		f := newLaneHTTPFixture(t, nil)
		tip := f.commit("refused", func(dir string) {
			require.NoError(t, os.WriteFile(filepath.Join(dir, "r.txt"), []byte("r\n"), 0o644))
		})
		before := f.repo.refs()
		err := push(t, f.srv.Handler(), "alice", "demo", f.pushBody(f.base, tip, "refs/heads/main"), func(context.Context) error {
			return repohost.ErrRepositoryReplaced
		})
		require.ErrorIs(t, err, repohost.ErrRepositoryReplaced)
		require.Equal(t, before, f.repo.refs())
		require.Error(t, exec.Command("git", "--git-dir", f.repo.gitDir, "cat-file", "-e", tip+"^{commit}").Run(),
			"a refused push's objects reached storage")
		f.mu.Lock()
		defer f.mu.Unlock()
		require.Empty(t, f.imports, "a refused push reached the jj import")
	})

	t.Run("a missing repository answers without the lock", func(t *testing.T) {
		srv := newTestServerWithMock(t, &mockFFI{})
		var calls atomic.Int32
		err := push(t, srv.Handler(), "alice", "missing", []byte("0000"), func(context.Context) error {
			calls.Add(1)
			return nil
		})
		status, ok := repohost.IsStatusError(err)
		require.True(t, ok, "%v", err)
		require.Equal(t, http.StatusNotFound, status.StatusCode)
		require.Zero(t, calls.Load())
	})

	t.Run("a held repository answers without the lock", func(t *testing.T) {
		srv := newTestServerWithMock(t, &mockFFI{})
		defer srv.locks.Hold(srv.config.RepoPath("alice", "busy"))()
		var calls atomic.Int32
		err := push(t, srv.Handler(), "alice", "busy", []byte("0000"), func(context.Context) error {
			calls.Add(1)
			return nil
		})
		status, ok := repohost.IsStatusError(err)
		require.True(t, ok, "%v", err)
		require.True(t, status.Held(), "%v", err)
		require.Zero(t, calls.Load())
	})
}
