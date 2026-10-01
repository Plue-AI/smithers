package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A burst of clones must not build more packs at once than the bound: each
// git pack-objects for a large repository holds hundreds of megabytes, and
// more than a dozen at once exceeded the pod's memory (smithersai/smithers#3070).
// A clone past the bound waits for a slot without starting git, and gives up
// when its request ends.
func TestUploadPacksPastTheBoundWaitForASlot(t *testing.T) {
	dir := t.TempDir()
	starts := filepath.Join(dir, "starts")
	release := filepath.Join(dir, "release")
	// Each upload-pack records its start, then builds its pack until released.
	installGitStub(t, `#!/bin/sh
[ "$1" = upload-pack ] || exit 1
cat >/dev/null
echo started >> '`+starts+`'
while [ ! -e '`+release+`' ]; do sleep 0.02; done
printf PACK
`)
	srv, err := NewWithFFI(Config{StoragePath: t.TempDir(), AuthToken: testAuthToken, MaxConcurrentUploadPacks: 1}, &mockFFI{})
	require.NoError(t, err)
	// Two repositories, so the only thing their fetches share is the bound.
	for _, repo := range []string{"demo", "other"} {
		require.NoError(t, os.MkdirAll(srv.config.GitBackendPath("alice", repo), 0o755))
	}
	handler := srv.Handler()
	fetch := func(ctx context.Context, repo string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/repos/alice/"+repo+"/git/upload-pack", strings.NewReader("want"))
		req.Header.Set("Authorization", validAuth())
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	startCount := func() int {
		raw, err := os.ReadFile(starts)
		if errors.Is(err, os.ErrNotExist) {
			return 0
		}
		require.NoError(t, err)
		return strings.Count(string(raw), "started")
	}

	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- fetch(context.Background(), "demo") }()
	require.Eventually(t, func() bool { return startCount() == 1 }, 10*time.Second, 10*time.Millisecond)

	waiting, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	second := fetch(waiting, "other")
	require.Equal(t, http.StatusServiceUnavailable, second.Code, second.Body.String())
	require.Contains(t, second.Body.String(), "waiting to build a pack")
	require.Equal(t, 1, startCount(), "a clone past the bound must not start git")

	require.NoError(t, os.WriteFile(release, nil, 0o644))
	got := <-first
	require.Equal(t, http.StatusOK, got.Code)
	require.Equal(t, "PACK", got.Body.String())

	third := fetch(context.Background(), "other")
	require.Equal(t, http.StatusOK, third.Code, third.Body.String())
	require.Equal(t, 2, startCount())
}

// Ending a git RPC ends every process git started: git upload-pack builds the
// pack in a pack-objects child, and killing git alone left that child
// building for minutes and holding its memory (smithersai/smithers#3070).
func TestGitRPCLeavesNoChildRunning(t *testing.T) {
	// A child holding git's stderr holds the RPC for one idle interval.
	previous := gitRPCIdleTimeout
	gitRPCIdleTimeout = 300 * time.Millisecond
	t.Cleanup(func() { gitRPCIdleTimeout = previous })
	for _, tc := range []struct {
		name string
		// child starts git's child, which keeps running.
		child string
		// exit is how git ends while its child still runs.
		exit string
		// cancel ends the request while git runs.
		cancel bool
	}{
		{name: "request cancelled", child: "sleep 300 </dev/null >/dev/null 2>&1 &", exit: "wait", cancel: true},
		{name: "git exited first", child: "sleep 300 </dev/null >/dev/null 2>&1 &", exit: "exit 1"},
		// As a push's index-pack inherits receive-pack's stderr.
		{name: "git exited first, child holds stderr", child: "sleep 300 </dev/null >/dev/null &", exit: "exit 0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pidFile := filepath.Join(t.TempDir(), "child.pid")
			installGitStub(t, `#!/bin/sh
cat >/dev/null
`+tc.child+`
echo $! > '`+pidFile+`'
`+tc.exit+`
`)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- streamGitRPC(ctx, t.TempDir(), "upload-pack", bytes.NewBufferString("want"), io.Discard)
			}()
			var pid int
			require.Eventually(t, func() bool {
				raw, err := os.ReadFile(pidFile)
				if err != nil || !strings.HasSuffix(string(raw), "\n") {
					return false
				}
				pid, err = strconv.Atoi(strings.TrimSpace(string(raw)))
				return err == nil
			}, 10*time.Second, 10*time.Millisecond)
			if tc.cancel {
				cancel()
			}
			select {
			case err := <-done:
				require.Error(t, err)
			case <-time.After(10 * time.Second):
				t.Fatal("the git RPC did not end")
			}
			require.Eventually(t, func() bool { return !processRunning(pid) }, 10*time.Second, 20*time.Millisecond, "git's child %d is still running", pid)
		})
	}
}

// processRunning reports whether pid is a live process. An exited child that
// nothing reaped yet (a zombie, where the test's pid 1 does not reap) is not.
func processRunning(pid int) bool {
	if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
		return false
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	// The state follows the parenthesized command name.
	fields := strings.Fields(string(stat[bytes.LastIndexByte(stat, ')')+1:]))
	return len(fields) == 0 || fields[0] != "Z"
}
