package repohostserver

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A push that trickles in is stopped at the push limit: it answers 408, no
// ref moves, and the repository's write lock is free again.
func TestTricklingPushIsStoppedAtThePushLimit(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	f.srv.config.ReceivePackMaxDuration = 500 * time.Millisecond
	server := httptest.NewServer(f.srv.Handler())
	t.Cleanup(server.Close)
	tip := f.commit("trickled", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "t.txt"), []byte("t\n"), 0o644))
	})
	push := f.pushBody(f.base, tip, "refs/heads/main")

	body, writer := io.Pipe()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		// The command list, then one byte of the pack every 100ms: never done.
		_, _ = writer.Write(push[:len(push)-len(push)/2])
		for i := len(push) - len(push)/2; ; i = (i + 1) % len(push) {
			select {
			case <-stop:
				_ = writer.Close()
				return
			case <-time.After(100 * time.Millisecond):
			}
			if _, err := writer.Write(push[i : i+1]); err != nil {
				return
			}
		}
	}()
	req, err := http.NewRequest(http.MethodPost, server.URL+"/repos/alice/demo/git/receive-pack", body)
	require.NoError(t, err)
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	require.Equal(t, http.StatusRequestTimeout, resp.StatusCode, string(text))
	require.Contains(t, string(text), "push took longer than 500ms")
	require.Less(t, time.Since(start), 5*time.Second)
	require.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "a trickled push moved the branch")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	unlock, err := f.srv.locks.Lock(ctx, f.srv.config.RepoPath("alice", "demo"))
	require.NoError(t, err, "the write lock outlived the push limit")
	unlock()
}
