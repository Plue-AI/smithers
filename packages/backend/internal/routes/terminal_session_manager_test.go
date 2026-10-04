package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestReattachReplaysRingBuffer(t *testing.T) {
	fake := newFakeTerminalSSH()
	var dials atomic.Int32
	manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
		dials.Add(1)
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Minute
	manager.keepaliveInterval = 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, Subprotocols: []string{"terminal"}})
		require.NoError(t, err)
		defer ws.CloseNow()

		sess, _, err := manager.getOrCreate(r.Context(), "sess-1", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
		require.NoError(t, err)
		sink, err := sess.addSink(r.Context(), ws, func() {}, revocation.Principal{})
		require.NoError(t, err)
		defer sess.removeSink(sink)
		<-r.Context().Done()
	}))
	defer srv.Close()
	defer manager.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws1, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], &websocket.DialOptions{
		Subprotocols: []string{"terminal"},
	})
	require.NoError(t, err)
	msgType, msg, err := ws1.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, websocket.MessageText, msgType)
	assert.JSONEq(t, `{"type":"replay-complete"}`, string(msg))

	_, err = fake.stdoutW.Write([]byte("hello durable\n"))
	require.NoError(t, err)
	msgType, msg, err = ws1.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, websocket.MessageBinary, msgType)
	assert.Equal(t, []byte("hello durable\n"), msg)
	ws1.CloseNow()

	ws2, _, err := websocket.Dial(ctx, "ws"+srv.URL[len("http"):], &websocket.DialOptions{
		Subprotocols: []string{"terminal"},
	})
	require.NoError(t, err)
	defer ws2.CloseNow()

	msgType, msg, err = ws2.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, websocket.MessageBinary, msgType)
	assert.Equal(t, []byte("hello durable\n"), msg)
	msgType, msg, err = ws2.Read(ctx)
	require.NoError(t, err)
	assert.Equal(t, websocket.MessageText, msgType)
	assert.JSONEq(t, `{"type":"replay-complete"}`, string(msg))
	assert.Equal(t, int32(1), dials.Load())
}

// TestSlowSinkDoesNotBlockHealthySink proves the head-of-line-blocking fix: a
// stalled client (one that never reads its socket) must not stall the PTY pump
// or the other attached clients. Before the fix, drain() held the session mutex
// across a per-sink websocket write with a 10s timeout, so one slow sink wedged
// everyone for up to 10s.
//
// The test paces the producer to the HEALTHY client: it writes a chunk, then
// waits for the healthy client to actually receive a chunk before writing the
// next. That pacing is itself the assertion — if the slow peer were
// head-of-line blocking the pump, the healthy client would stop receiving and
// the wait would time out. Meanwhile the never-reading slow client's bounded
// queue fills monotonically until it is evicted. Both conditions must hold with
// no deadlock.
func TestSlowSinkDoesNotBlockHealthySink(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Minute
	manager.keepaliveInterval = 0
	defer manager.Close()

	sess, _, err := manager.getOrCreate(context.Background(), "sess-slow", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
	require.NoError(t, err)

	accept := func(ready chan<- *websocket.Conn) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, acceptErr := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, Subprotocols: []string{"terminal"}})
			require.NoError(t, acceptErr)
			ready <- ws
			<-r.Context().Done()
		}))
	}

	slowReady := make(chan *websocket.Conn, 1)
	slowSrv := accept(slowReady)
	defer slowSrv.Close()
	healthyReady := make(chan *websocket.Conn, 1)
	healthySrv := accept(healthyReady)
	defer healthySrv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// The sink wraps the SERVER side of each connection (as in the real handler);
	// the test controls the CLIENT side. The slow client is never read, so its
	// receive buffer — and therefore the server-side send buffer and finally the
	// sink's bounded queue — fills up.
	slowClient, _, err := websocket.Dial(ctx, "ws"+slowSrv.URL[len("http"):], &websocket.DialOptions{Subprotocols: []string{"terminal"}})
	require.NoError(t, err)
	defer slowClient.CloseNow()
	slowServerWS := <-slowReady

	healthyClient, _, err := websocket.Dial(ctx, "ws"+healthySrv.URL[len("http"):], &websocket.DialOptions{Subprotocols: []string{"terminal"}})
	require.NoError(t, err)
	defer healthyClient.CloseNow()
	healthyServerWS := <-healthyReady

	slowSink, err := sess.addSink(ctx, slowServerWS, func() {}, revocation.Principal{})
	require.NoError(t, err)
	_, err = sess.addSink(ctx, healthyServerWS, func() {}, revocation.Principal{})
	require.NoError(t, err)

	// Background reader: drains the healthy client and reports each frame it
	// receives. Includes the initial replay-complete handshake.
	healthyRx := make(chan int, 1<<16)
	go func() {
		for {
			_, b, rerr := healthyClient.Read(ctx)
			if rerr != nil {
				return
			}
			select {
			case healthyRx <- len(b):
			default:
			}
		}
	}()

	chunk := make([]byte, 4096)
	for i := range chunk {
		chunk[i] = 'z'
	}
	evicted := false
	for i := 0; i < 4000 && !evicted; i++ {
		if _, werr := fake.stdoutW.Write(chunk); werr != nil {
			t.Fatalf("stdout write failed: %v", werr)
		}
		// Pace to the healthy client. If the slow peer were blocking the pump,
		// this receive would time out — that timeout IS the regression signal.
		select {
		case <-healthyRx:
		case <-time.After(3 * time.Second):
			t.Fatalf("healthy client stalled after %d chunks — a stalled peer head-of-line blocked the pump", i)
		}
		sess.mu.Lock()
		_, present := sess.sinks[slowSink]
		sess.mu.Unlock()
		evicted = !present
	}
	require.True(t, evicted, "the stalled sink should have been evicted once its bounded queue overflowed")
}

func TestStartWorkspaceShellUsesWorkdirWhenPresent(t *testing.T) {
	fake := newFakeTerminalSSH()

	err := startWorkspaceShell(fake.session, "/home/developer/workspace")
	require.NoError(t, err)
	assert.False(t, fake.session.shellCalled.Load())
	assert.Equal(t, "if [ -d '/home/developer/workspace' ]; then cd '/home/developer/workspace'; fi; for s in \"$SHELL\" /bin/bash /bin/sh; do if [ -n \"$s\" ] && [ -x \"$s\" ]; then exec \"$s\" -l; fi; done; exec sh -l", fake.session.startedCommand)
}

func TestStartWorkspaceShellUsesLoginShellWithoutWorkdir(t *testing.T) {
	fake := newFakeTerminalSSH()

	err := startWorkspaceShell(fake.session, "")
	require.NoError(t, err)
	assert.False(t, fake.session.shellCalled.Load())
	assert.Equal(t, "for s in \"$SHELL\" /bin/bash /bin/sh; do if [ -n \"$s\" ] && [ -x \"$s\" ]; then exec \"$s\" -l; fi; done; exec sh -l", fake.session.startedCommand)
}

func TestTerminalSessionManagerRetriesEarlyExit127Once(t *testing.T) {
	first := newFakeTerminalSSH()
	first.session.waitImmediately = true
	first.session.waitErr = fakeTerminalExitError{status: 127}
	second := newFakeTerminalSSH()

	var dials atomic.Int32
	manager := NewTerminalSessionManager(func(context.Context, services.WorkspaceSSHConnectionInfo, int32, int32) (terminalSSHClient, terminalSSHSession, error) {
		if dials.Add(1) == 1 {
			return first.client, first.session, nil
		}
		return second.client, second.session, nil
	})
	manager.startupWatch = 10 * time.Millisecond
	manager.startupRetryDelay = time.Millisecond
	manager.keepaliveInterval = 0
	defer manager.Close()

	sess, created, err := manager.getOrCreate(context.Background(), "sess-retry-127", services.WorkspaceSSHConnectionInfo{Kind: "vm"}, 80, 24, revocation.Principal{})

	require.NoError(t, err)
	require.True(t, created)
	require.NotNil(t, sess)
	assert.Equal(t, int32(2), dials.Load())
	select {
	case <-first.session.done:
	case <-time.After(time.Second):
		t.Fatal("failed first PTY transport was not released")
	}
	assert.True(t, first.session.closed.Load(), "failed first PTY must be released")
	assert.False(t, second.session.closed.Load(), "successful retry remains live")
}

type fakeTerminalExitError struct{ status int }

func (e fakeTerminalExitError) Error() string   { return "exit status " + strconv.Itoa(e.status) }
func (e fakeTerminalExitError) ExitStatus() int { return e.status }

func TestShellSingleQuoteEscapesSingleQuotes(t *testing.T) {
	assert.Equal(t, "'/tmp/a'\\''b'", shellSingleQuote("/tmp/a'b"))
}

// TestIdleExpireStaleGenerationDoesNotKillReattachedSession is the issue #125
// regression: an idle-timer callback that already started running when a
// client reattached (so Timer.Stop could not cancel it) must re-check the
// generation and back off instead of destroying the live session.
func TestIdleExpireStaleGenerationDoesNotKillReattachedSession(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Hour
	manager.keepaliveInterval = 0
	defer manager.Close()

	sess, created, err := manager.getOrCreate(context.Background(), "sess-idle-gen", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
	require.NoError(t, err)
	require.True(t, created)

	// Attach and detach a sink: the detach arms the idle timer.
	sink := newTerminalSink(&websocket.Conn{}, 4, time.Millisecond)
	sess.mu.Lock()
	sess.sinks[sink] = struct{}{}
	sess.mu.Unlock()
	sess.detachSink(sink, false, 0, "")

	sess.mu.Lock()
	staleGen := sess.idleGen
	sess.mu.Unlock()

	// Reconnect before the timer fires; addSink stops the timer and bumps the
	// generation.
	serverWS, _, cleanup := terminalSessionManagerHWebsocketPair(t)
	defer cleanup()
	reattached, err := sess.addSink(context.Background(), serverWS, nil, revocation.Principal{})
	require.NoError(t, err)
	defer sess.removeSink(reattached)

	// Simulate the armed callback that lost the Stop race firing NOW.
	sess.idleExpire(staleGen)
	assert.False(t, sess.isDead(), "stale idle callback must not destroy a session with a live attachment")

	// A current-generation expiry with no sinks still destroys.
	sess.removeSink(reattached)
	sess.mu.Lock()
	currentGen := sess.idleGen
	sess.mu.Unlock()
	sess.idleExpire(currentGen)
	assert.True(t, sess.isDead())
}

// TestDestroyIfUnattached is the issue #123 regression: a session created for
// a websocket whose upgrade then failed is released immediately, while a
// session something is attached to is left alone.
func TestDestroyIfUnattached(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Hour
	manager.keepaliveInterval = 0
	defer manager.Close()

	sess, created, err := manager.getOrCreate(context.Background(), "sess-unattached", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
	require.NoError(t, err)
	require.True(t, created)

	// With a sink attached, destroyIfUnattached is a no-op.
	serverWS, _, cleanup := terminalSessionManagerHWebsocketPair(t)
	defer cleanup()
	sink, err := sess.addSink(context.Background(), serverWS, nil, revocation.Principal{})
	require.NoError(t, err)
	sess.destroyIfUnattached("websocket accept failed")
	assert.False(t, sess.isDead())

	// Without sinks it tears the session down and removes the manager entry.
	sess.removeSink(sink)
	sess.destroyIfUnattached("websocket accept failed")
	assert.True(t, sess.isDead())
	require.Eventually(t, func() bool {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		return len(manager.sessions) == 0
	}, time.Second, 10*time.Millisecond)
	select {
	case <-fake.session.done:
	case <-time.After(time.Second):
		t.Fatal("SSH session transport was not released")
	}
	assert.True(t, fake.session.closed.Load(), "SSH session must be closed on release")
}

// TestReattachUsesFreshActivityCallback is the issue #124 regression: output
// activity must reach the CURRENT attachment's touch callback, not the one
// captured by the first connection.
func TestReattachUsesFreshActivityCallback(t *testing.T) {
	fake := newFakeTerminalSSH()
	manager := NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
		return fake.client, fake.session, nil
	})
	manager.idleTimeout = time.Hour
	manager.keepaliveInterval = 0
	defer manager.Close()

	sess, _, err := manager.getOrCreate(context.Background(), "sess-touch", services.WorkspaceSSHConnectionInfo{}, 80, 24, revocation.Principal{})
	require.NoError(t, err)

	var first, second atomic.Int32

	firstWS, firstClient, firstCleanup := terminalSessionManagerHWebsocketPair(t)
	defer firstCleanup()
	firstSink, err := sess.addSink(context.Background(), firstWS, func() { first.Add(1) }, revocation.Principal{})
	require.NoError(t, err)

	// First connection drops.
	sess.removeSink(firstSink)
	_ = firstClient.CloseNow()

	// Reconnect with a new activity callback.
	secondWS, secondClient, secondCleanup := terminalSessionManagerHWebsocketPair(t)
	defer secondCleanup()
	secondSink, err := sess.addSink(context.Background(), secondWS, func() { second.Add(1) }, revocation.Principal{})
	require.NoError(t, err)
	defer sess.removeSink(secondSink)

	// PTY output while the user only watches: activity must be attributed to
	// the live (second) connection.
	_, err = fake.stdoutW.Write([]byte("output\n"))
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Drain the replay-complete marker and the output frame on the client side.
	for i := 0; i < 2; i++ {
		_, _, err := secondClient.Read(ctx)
		require.NoError(t, err)
	}

	require.Eventually(t, func() bool { return second.Load() > 0 }, time.Second, 10*time.Millisecond,
		"live attachment's touch callback must fire on output")
	assert.Equal(t, int32(0), first.Load(), "detached connection's callback must not fire")
}

type fakeTerminalSSH struct {
	client  *fakeTerminalSSHClient
	session *fakeTerminalSSHSession
	stdoutW *io.PipeWriter
}

func newFakeTerminalSSH() *fakeTerminalSSH {
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	stdinR, stdinW := io.Pipe()
	sess := &fakeTerminalSSHSession{
		stdinR:  stdinR,
		stdinW:  stdinW,
		stdoutR: stdoutR,
		stdoutW: stdoutW,
		stderrR: stderrR,
		stderrW: stderrW,
		done:    make(chan struct{}),
	}
	return &fakeTerminalSSH{client: &fakeTerminalSSHClient{}, session: sess, stdoutW: stdoutW}
}

type fakeTerminalSSHClient struct{}

func (f *fakeTerminalSSHClient) NewSession() (*gossh.Session, error) { return nil, nil }
func (f *fakeTerminalSSHClient) SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error) {
	return true, nil, nil
}
func (f *fakeTerminalSSHClient) Close() error { return nil }

type fakeTerminalSSHSession struct {
	stdinR          *io.PipeReader
	stdinW          *io.PipeWriter
	stdoutR         *io.PipeReader
	stdoutW         *io.PipeWriter
	stderrR         *io.PipeReader
	stderrW         *io.PipeWriter
	done            chan struct{}
	closed          atomic.Bool
	shellCalled     atomic.Bool
	startedCommand  string
	waitErr         error
	waitImmediately bool
}

func (f *fakeTerminalSSHSession) StdinPipe() (io.WriteCloser, error) { return f.stdinW, nil }
func (f *fakeTerminalSSHSession) StdoutPipe() (io.Reader, error)     { return f.stdoutR, nil }
func (f *fakeTerminalSSHSession) StderrPipe() (io.Reader, error)     { return f.stderrR, nil }
func (f *fakeTerminalSSHSession) RequestPty(term string, h, w int, modes gossh.TerminalModes) error {
	return nil
}
func (f *fakeTerminalSSHSession) Shell() error                { f.shellCalled.Store(true); return nil }
func (f *fakeTerminalSSHSession) Start(cmd string) error      { f.startedCommand = cmd; return nil }
func (f *fakeTerminalSSHSession) WindowChange(h, w int) error { return nil }
func (f *fakeTerminalSSHSession) Wait() error {
	if f.waitImmediately {
		return f.waitErr
	}
	<-f.done
	return f.waitErr
}
func (f *fakeTerminalSSHSession) Close() error {
	if f.closed.CompareAndSwap(false, true) {
		close(f.done)
		_ = f.stdinR.Close()
		_ = f.stdinW.Close()
		_ = f.stdoutR.Close()
		_ = f.stdoutW.Close()
		_ = f.stderrR.Close()
		_ = f.stderrW.Close()
	}
	return nil
}
