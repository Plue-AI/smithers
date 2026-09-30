package repohost

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// lockedHost stands in for repo-host's receive-pack: it answers 102 once it
// "holds the lock", then reads the pack, recording what it saw.
type lockedHost struct {
	verified   *atomic.Bool
	read       atomic.Int64
	readBefore atomic.Bool // a pack byte arrived before VerifyLocked passed
	started    atomic.Bool // StartedHeader was sent
	refuse     int         // answer this status without the lock instead
}

func (h *lockedHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.started.Store(r.Header.Get(StartedHeader) == "1")
	if h.started.Load() {
		// As repo-host does: an answer before the 102 must not wait on the
		// server draining a pack the client is holding.
		_ = http.NewResponseController(w).EnableFullDuplex()
	}
	if h.refuse != 0 {
		http.Error(w, "repository not found", h.refuse)
		return
	}
	if h.started.Load() {
		w.WriteHeader(http.StatusProcessing)
	}
	buf := make([]byte, 1)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			if h.read.Add(int64(n)) == int64(n) && !h.verified.Load() {
				h.readBefore.Store(true)
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				http.Error(w, "malformed receive-pack command list", http.StatusBadRequest)
				return
			}
			break
		}
	}
	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	_, _ = io.WriteString(w, "ok")
}

func verifyingMeta(verified *atomic.Bool, calls *atomic.Int32, err error) ReceivePackMetadata {
	return ReceivePackMetadata{RepositoryID: 7, VerifyLocked: func(context.Context) error {
		calls.Add(1)
		if err == nil {
			verified.Store(true)
		}
		return err
	}}
}

func TestProxyReceivePackVerifyLocked(t *testing.T) {
	transports := map[string]func(http.Handler) *Client{
		"network": func(handler http.Handler) *Client {
			server := httptest.NewServer(handler)
			t.Cleanup(server.Close)
			return NewClient(&StaticStorageSetResolver{URL: server.URL}, "token")
		},
		"in-process": func(handler http.Handler) *Client { return NewLocalClient(handler, "token") },
	}
	for name, client := range transports {
		t.Run(name+"/verified push reaches repo-host only after the check", func(t *testing.T) {
			var verified atomic.Bool
			var calls atomic.Int32
			host := &lockedHost{verified: &verified}
			var started atomic.Bool
			ctx := WithPushStarted(context.Background(), func() {
				// The caller's started signal follows a passed check.
				assert.True(t, verified.Load())
				started.Store(true)
			})
			var out bytes.Buffer
			err := client(host).ProxyReceivePack(ctx, "alice", "demo", strings.NewReader("0000PACK"), &out,
				verifyingMeta(&verified, &calls, nil))
			require.NoError(t, err)
			assert.Equal(t, "ok", out.String())
			assert.True(t, host.started.Load(), "a verified push must ask repo-host to report the lock")
			assert.EqualValues(t, 1, calls.Load())
			assert.EqualValues(t, len("0000PACK"), host.read.Load())
			assert.False(t, host.readBefore.Load(), "a pack byte reached repo-host before the check")
			assert.True(t, started.Load())
		})

		t.Run(name+"/refused push sends no pack byte", func(t *testing.T) {
			var verified atomic.Bool
			var calls atomic.Int32
			host := &lockedHost{verified: &verified}
			var started atomic.Bool
			ctx := WithPushStarted(context.Background(), func() { started.Store(true) })
			err := client(host).ProxyReceivePack(ctx, "alice", "demo", strings.NewReader("0000PACK"), io.Discard,
				verifyingMeta(&verified, &calls, ErrRepositoryReplaced))
			require.ErrorIs(t, err, ErrRepositoryReplaced)
			_, isStatus := IsStatusError(err)
			assert.False(t, isStatus, "the refusal, not repo-host's answer to the aborted body, is the error")
			assert.EqualValues(t, 1, calls.Load())
			assert.Zero(t, host.read.Load())
			assert.False(t, started.Load(), "a refused push never started")
		})

		t.Run(name+"/transient check failure refuses with its own error", func(t *testing.T) {
			var verified atomic.Bool
			var calls atomic.Int32
			host := &lockedHost{verified: &verified}
			lookup := errors.New("database unavailable")
			err := client(host).ProxyReceivePack(context.Background(), "alice", "demo", strings.NewReader("0000PACK"), io.Discard,
				verifyingMeta(&verified, &calls, lookup))
			require.ErrorIs(t, err, lookup)
			assert.NotErrorIs(t, err, ErrRepositoryReplaced)
			assert.Zero(t, host.read.Load())
		})

		t.Run(name+"/an answer without the lock does not hold the push", func(t *testing.T) {
			var verified atomic.Bool
			var calls atomic.Int32
			host := &lockedHost{verified: &verified, refuse: http.StatusNotFound}
			done := make(chan error, 1)
			go func() {
				done <- client(host).ProxyReceivePack(context.Background(), "alice", "demo", strings.NewReader("0000PACK"), io.Discard,
					verifyingMeta(&verified, &calls, nil))
			}()
			select {
			case err := <-done:
				status, ok := IsStatusError(err)
				require.True(t, ok, "%v", err)
				assert.Equal(t, http.StatusNotFound, status.StatusCode)
			case <-time.After(10 * time.Second):
				t.Fatal("a push repo-host answered without the lock never returned")
			}
			assert.Zero(t, calls.Load(), "no lock, no check")
			assert.Zero(t, host.read.Load())
		})
	}

	t.Run("cancellation while waiting for the lock ends the push", func(t *testing.T) {
		held := make(chan struct{})
		release := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(held)
			<-release
		}))
		t.Cleanup(func() {
			close(release)
			server.Close()
		})
		var verified atomic.Bool
		var calls atomic.Int32
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			done <- NewClient(&StaticStorageSetResolver{URL: server.URL}, "token").ProxyReceivePack(ctx, "alice", "demo",
				strings.NewReader("0000PACK"), io.Discard, verifyingMeta(&verified, &calls, nil))
		}()
		<-held
		cancel()
		select {
		case err := <-done:
			require.ErrorIs(t, err, context.Canceled)
		case <-time.After(10 * time.Second):
			t.Fatal("a cancelled push waiting for the lock never returned")
		}
		assert.Zero(t, calls.Load())
	})

	t.Run("a push without a check keeps its behaviour", func(t *testing.T) {
		var verified atomic.Bool
		host := &lockedHost{verified: &verified}
		server := httptest.NewServer(host)
		t.Cleanup(server.Close)
		err := NewClient(&StaticStorageSetResolver{URL: server.URL}, "token").ProxyReceivePack(context.Background(), "alice", "demo",
			strings.NewReader("0000PACK"), io.Discard, ReceivePackMetadata{RepositoryID: 7})
		require.NoError(t, err)
		assert.False(t, host.started.Load(), "without a check or a started callback the lock is not reported")
		assert.EqualValues(t, len("0000PACK"), host.read.Load())
	})
}
