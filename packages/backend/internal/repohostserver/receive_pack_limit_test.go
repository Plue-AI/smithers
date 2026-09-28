package repohostserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// deadlineWithoutCancellation makes WithDeadline inherit an earlier parent
// deadline without starting a timer. The returned push context stays uncanceled
// even after the push's wall deadline, as can happen when a socket deadline
// fires before the context timer is delivered.
type deadlineWithoutCancellation struct {
	context.Context
	deadline time.Time
}

func (c deadlineWithoutCancellation) Deadline() (time.Time, bool) {
	return c.deadline, true
}

func TestReceivePackLimitMapsExpiredWallDeadlineBeforeContextCancellation(t *testing.T) {
	s := &Server{config: Config{ReceivePackMaxDuration: time.Nanosecond}}
	parent := deadlineWithoutCancellation{
		Context:  context.Background(),
		deadline: time.Now().Add(-time.Hour),
	}
	pushCtx, deadline, cancel, limited := s.receivePackLimit(parent)
	defer cancel()
	require.True(t, deadline.Before(time.Now()), "push wall deadline must have passed")
	require.NoError(t, pushCtx.Err(), "test must not rely on context timer delivery")

	readErr := errors.New("socket read deadline exceeded")
	for _, tc := range []struct {
		name  string
		input error
	}{
		{name: "socket read error", input: readErr},
		{name: "git returned nil", input: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, pushCtx.Err())
			var appErr *appError
			require.ErrorAs(t, limited(tc.input), &appErr)
			require.Equal(t, http.StatusRequestTimeout, appErr.StatusCode)
			require.Equal(t, repohost.PushTooSlowCode, appErr.Code)
			require.Equal(t, "push took longer than 1ns; nothing was changed", appErr.Message)
			require.Equal(t, tc.input, appErr.Cause)
		})
	}
}

func TestReceivePackLimitPreservesResultsBeforeDeadline(t *testing.T) {
	s := &Server{config: Config{ReceivePackMaxDuration: time.Hour}}
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	pushCtx, deadline, cancel, limited := s.receivePackLimit(parent)
	defer cancel()
	require.True(t, time.Now().Before(deadline))

	require.NoError(t, limited(nil), "an early successful push must stay successful")
	gitErr := errors.New("git rejected push")
	require.Same(t, gitErr, limited(gitErr), "an early git failure must keep its cause")
	tooLarge := pushTooLarge(false, 10)
	require.Equal(t, http.StatusRequestEntityTooLarge, tooLarge.StatusCode)
	require.Same(t, tooLarge, limited(tooLarge), "the counted pack-size error must remain 413")

	cancelParent()
	require.ErrorIs(t, pushCtx.Err(), context.Canceled)
	require.ErrorIs(t, limited(context.Canceled), context.Canceled,
		"a canceled parent before the push deadline must not become a timeout")
}

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
