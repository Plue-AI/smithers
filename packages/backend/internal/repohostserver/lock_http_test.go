package repohostserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// serve runs one request against srv with ctx.
func serve(srv *Server, ctx context.Context, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body)).WithContext(ctx)
	req.Header.Set("Authorization", validAuth())
	if strings.Contains(path, "/git/") {
		req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	} else {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// A write to a held repository is answered 503 at once, with a Retry-After:
// JSON with its code over the API, plain text git shows over smart HTTP.
// Reads of it and writes to other repositories proceed, and once the hold is
// released its writes do too.
func TestHeldRepositoryFailsWritesFastOverHTTP(t *testing.T) {
	cfg, held, free := holdFixture(t)
	survivor, err := os.Create(filepath.Join(repoGitDir(held), maintenancePidFile))
	require.NoError(t, err)
	defer survivor.Close()
	require.NoError(t, syscall.Flock(int(survivor.Fd()), syscall.LOCK_EX|syscall.LOCK_NB))
	srv := newHoldServer(t, cfg)
	ctx := context.Background()
	bookmark := `{"name":"feature","target_change_id":"abc"}`

	start := time.Now()
	rec := serve(srv, ctx, http.MethodPost, "/repos/alice:held/bookmarks", bookmark)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	require.Equal(t, "1", rec.Header().Get("Retry-After"))
	var envelope errorEnvelope
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
	require.Equal(t, repositoryHeldCode, envelope.Code)

	// A write that locks several repositories fails too.
	rec = serve(srv, ctx, http.MethodPost, "/repos/fork", `{"src_owner":"alice","src_repo":"free","dst_owner":"alice","dst_repo":"held"}`)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())

	rec = serve(srv, ctx, http.MethodPost, "/repos/alice/held/git/receive-pack", "0000")
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	require.Equal(t, "1", rec.Header().Get("Retry-After"))
	require.Equal(t, repositoryHeldCode, rec.Header().Get("X-Smithers-Error-Code"))
	require.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	require.Contains(t, rec.Body.String(), "repository maintenance is finishing")
	// A push is refused at discovery already, where git shows the message.
	rec = serve(srv, ctx, http.MethodGet, "/repos/alice/held/git/info-refs?service=git-receive-pack", "")
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	require.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	require.Contains(t, rec.Body.String(), "repository maintenance is finishing")
	require.Less(t, time.Since(start), time.Second, "held writes waited")

	rec = serve(srv, ctx, http.MethodGet, "/repos/alice:held/bookmarks", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = serve(srv, ctx, http.MethodPost, "/repos/alice:free/bookmarks", bookmark)
	require.NotEqual(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())

	require.NoError(t, survivor.Close())
	require.Eventually(t, func() bool { return !srv.locks.Held(held) }, 5*time.Second, 10*time.Millisecond)
	rec = serve(srv, ctx, http.MethodPost, "/repos/alice:held/bookmarks", bookmark)
	require.NotEqual(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	_ = free
}

// A write waiting for a repository lock, over the JSON API or git, stops
// waiting when its request ends, and its goroutines are freed.
func TestWaitingWritesAreFreedWithTheirRequest(t *testing.T) {
	srv := newTestServer(t)
	repoPath := srv.config.RepoPath("alice", "demo")
	require.NoError(t, os.MkdirAll(repoGitDir(repoPath), 0o755))
	unlock, err := srv.locks.Lock(context.Background(), repoPath)
	require.NoError(t, err)
	defer unlock()
	refs := func() int {
		srv.locks.mu.Lock()
		defer srv.locks.mu.Unlock()
		return srv.locks.locks[repoPath].refs
	}

	const waiters = 20
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(context.Background())
	codes := make(chan int, waiters)
	for i := range waiters {
		path, body := "/repos/alice:demo/bookmarks", `{"name":"x","target_change_id":"abc"}`
		if i%2 == 1 {
			path, body = "/repos/alice/demo/git/receive-pack", "0000"
		}
		go func() { codes <- serve(srv, ctx, http.MethodPost, path, body).Code }()
	}
	require.Eventually(t, func() bool { return refs() == waiters+1 }, 5*time.Second, time.Millisecond)
	require.GreaterOrEqual(t, runtime.NumGoroutine(), before+waiters)
	cancel()
	for range waiters {
		select {
		case code := <-codes:
			require.Equal(t, http.StatusGatewayTimeout, code)
		case <-time.After(5 * time.Second):
			t.Fatal("a cancelled request kept waiting for the lock")
		}
	}
	require.Equal(t, 1, refs())
	require.Eventually(t, func() bool { return runtime.NumGoroutine() < before+waiters/2 }, 5*time.Second, 10*time.Millisecond)
}
