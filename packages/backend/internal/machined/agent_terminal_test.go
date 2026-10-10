package machined

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// agentIdentities is the host's durable spawn receipts: only sessions the
// host opened itself have one.
type agentIdentities struct {
	mu     sync.Mutex
	opened map[uint32]SessionUser
}

func (a *agentIdentities) Record(_ context.Context, _ string, _ [16]byte, id uint32, user SessionUser, _ string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.opened[id] = user
	return nil
}
func (a *agentIdentities) Lookup(_ context.Context, _ string, _ [16]byte, id uint32) (SessionUser, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if user, ok := a.opened[id]; ok {
		return user, nil
	}
	return SessionUser{}, ErrNotReady
}
func (a *agentIdentities) Attribution(context.Context, string, [16]byte, uint32) (json.RawMessage, error) {
	return nil, ErrNotReady
}

// daemonFrames reads everything the host sends, so the synchronous pipe never
// blocks the host's credit writes.
func daemonFrames(t *testing.T, peer net.Conn) <-chan wire.Frame {
	t.Helper()
	frames := make(chan wire.Frame, 64)
	go func() {
		defer close(frames)
		for {
			f, err := wire.Read(peer)
			if err != nil {
				return
			}
			frames <- f
		}
	}()
	return frames
}

func nextFrame(t *testing.T, frames <-chan wire.Frame) wire.Frame {
	t.Helper()
	select {
	case f, ok := <-frames:
		require.True(t, ok, "host link closed")
		return f
	case <-time.After(3 * time.Second):
		t.Fatal("host sent nothing")
		return wire.Frame{}
	}
}

func reply(t *testing.T, peer net.Conn, request wire.Frame, method wire.Method, fields ...[]byte) {
	t.Helper()
	id, m, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(method), m)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}))
}

type agentFixture struct {
	r      *Registry
	l      *Link
	peer   net.Conn
	frames <-chan wire.Frame
}

// A link whose coding host (session 5) is registered as run-1, as
// microsandbox's native host leaves it.
func agentTerminalFixture(t *testing.T) agentFixture {
	t.Helper()
	r := new(Registry)
	r.BindSessionIdentities(&agentIdentities{opened: map[uint32]SessionUser{}})
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	l, peer := connectTest(t, r, "a", authority)
	require.NoError(t, l.Reconciled())
	frames := daemonFrames(t, peer)
	done := make(chan error, 1)
	go func() {
		_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Actor: []byte("actor-reference1"), Method: "open_session", User: &SessionUser{"agent", 19999}, Kind: SessionExec, Argv: []string{"node"}, Run: "run-1", Via: "agent:run-1"})
		done <- err
	}()
	reply(t, peer, nextFrame(t, frames), wire.OpenSession, wire.Field(1, wire.U32(5)))
	require.NoError(t, <-done)
	return agentFixture{r, l, peer, frames}
}

func (f agentFixture) observe(t *testing.T, id uint32) *SessionStream {
	t.Helper()
	type result struct {
		s   *SessionStream
		err error
	}
	done := make(chan result, 1)
	go func() {
		s, err := f.l.ObserveAgentTerminal(t.Context(), "a", id, "run-1")
		done <- result{s, err}
	}()
	request := nextFrame(t, f.frames)
	_, method, fields, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.AttachSession), method)
	args, err := wire.Fields("args15", fields)
	require.NoError(t, err)
	require.Equal(t, id, binary.BigEndian.Uint32(args[1]))
	require.Equal(t, uint64(0), binary.BigEndian.Uint64(args[2]), "a watcher starts at the command's first byte")
	reply(t, f.peer, request, wire.AttachSession, wire.Field(1, wire.U64(0)))
	got := <-done
	require.NoError(t, got.err)
	return got.s
}

func (f agentFixture) send(t *testing.T, id uint32, p []byte) {
	t.Helper()
	require.NoError(t, wire.Write(f.peer, wire.Frame{Kind: wire.Sessions, Stream: id, Payload: p}))
}

func (f agentFixture) credit(t *testing.T, id uint32) uint32 {
	t.Helper()
	frame := nextFrame(t, f.frames)
	require.Equal(t, wire.Sessions, frame.Kind)
	require.Equal(t, id, frame.Stream)
	require.Equal(t, byte(6), frame.Payload[0], "a watcher only returns output credit")
	return binary.BigEndian.Uint32(frame.Payload[1:])
}

func readAgent(t *testing.T, terminal *AgentTerminal, want string) {
	t.Helper()
	got := make([]byte, 0, len(want))
	buf := make([]byte, 64)
	for len(got) < len(want) {
		n, err := terminal.Read(buf)
		require.NoError(t, err)
		got = append(got, buf[:n]...)
	}
	require.Equal(t, want, string(got))
}

func TestObserveAgentTerminalAttachesOnlyUnknownLocalSessionsOfARegisteredRun(t *testing.T) {
	f := agentTerminalFixture(t)
	for _, test := range []struct {
		id  uint32
		run string
	}{{0, "run-1"}, {17, ""}, {17, "run\x00"}} {
		_, err := f.l.ObserveAgentTerminal(t.Context(), "a", test.id, test.run)
		require.Error(t, err)
	}
	// The coding host's own session, and any session the host opened, carry
	// a spawn receipt or a live stream: never a watcher.
	_, err := f.l.ObserveAgentTerminal(t.Context(), "a", 5, "run-1")
	require.ErrorIs(t, err, ErrUnauthorized)
	require.NoError(t, f.l.identities.Record(t.Context(), "a", f.l.BootID(), 9, SessionUser{"ben", 20001}, "terminal"))
	_, err = f.l.ObserveAgentTerminal(t.Context(), "a", 9, "run-1")
	require.ErrorIs(t, err, ErrUnauthorized)
	// A run not registered on this link cannot claim a terminal.
	_, err = f.l.ObserveAgentTerminal(t.Context(), "a", 17, "run-2")
	require.ErrorIs(t, err, ErrUnauthorized)
	_, err = f.l.ObserveAgentTerminal(t.Context(), "b", 17, "run-1")
	require.Error(t, err)
	stream := f.observe(t, 17)
	user, run, via, err := f.l.SessionPresence("a", 17)
	require.NoError(t, err)
	require.Equal(t, SessionUser{"agent", 19999}, user)
	require.Equal(t, "run-1", run)
	require.Equal(t, "agent:run-1", via, "presence skips it like the run's own host session")
	require.True(t, f.l.HasSession(17))
	_, err = f.l.ObserveAgentTerminal(t.Context(), "a", 17, "run-1")
	require.ErrorIs(t, err, ErrUnauthorized, "one watcher per command")
	// A broker refusal (not a local agent PTY) leaves nothing behind.
	done := make(chan error, 1)
	go func() { _, err := f.l.ObserveAgentTerminal(t.Context(), "a", 18, "run-1"); done <- err }()
	request := nextFrame(t, f.frames)
	id, _, _, err := request.Request()
	require.NoError(t, err)
	require.NoError(t, wire.Write(f.peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(255, wire.Field(1, []byte{11}))))}))
	require.Error(t, <-done)
	require.False(t, f.l.HasSession(18))
	require.NotNil(t, stream)
}

func TestAgentTerminalJoinsARunsCommandsReadOnlyAndForgetsEachAfterItsClose(t *testing.T) {
	f := agentTerminalFixture(t)
	var live atomic.Bool
	live.Store(true)
	terminal := NewAgentTerminal(live.Load)
	terminal.poll = 10 * time.Millisecond
	require.True(t, terminal.Append(f.observe(t, 17)))
	f.send(t, 17, []byte("\x01\x01$ pnpm test\r\nAGENT_TERMINAL_FIRST"))
	readAgent(t, terminal, "$ pnpm test\r\nAGENT_TERMINAL_FIRST")
	require.Equal(t, uint32(len("$ pnpm test\r\nAGENT_TERMINAL_FIRST")), f.credit(t, 17))
	f.send(t, 17, []byte{2, 1})
	f.send(t, 17, []byte{5, 0, 0, 0, 0, 7})
	f.send(t, 17, []byte{7})
	require.True(t, terminal.Append(f.observe(t, 19)))
	f.send(t, 19, []byte("\x01\x01$ printf AGENT_TERMINAL_SECOND\r\nAGENT_TERMINAL_SECOND"))
	// The first command ended mid-line: the next echo starts its own row.
	readAgent(t, terminal, "\r\n$ printf AGENT_TERMINAL_SECOND\r\nAGENT_TERMINAL_SECOND")
	f.credit(t, 19)
	require.False(t, f.l.HasSession(17), "a closed command's stream is forgotten")
	n, err := terminal.Write([]byte("echo injected\n"))
	require.Zero(t, n)
	require.ErrorIs(t, err, ErrAgentTerminalReadOnly)
	require.NoError(t, terminal.Resize(t.Context(), 80, 24))
	f.send(t, 19, []byte{7})
	live.Store(false)
	_, err = terminal.Read(make([]byte, 8))
	require.ErrorIs(t, err, io.EOF, "the run ended with no command running")
	select {
	case <-terminal.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("terminal did not end with its run")
	}
	require.False(t, terminal.Append(&SessionStream{}))
	require.False(t, f.l.HasSession(19))
}

func TestClosedAgentTerminalDrainsTheRunningCommandUntilTheBrokerClosesIt(t *testing.T) {
	f := agentTerminalFixture(t)
	terminal := NewAgentTerminal(func() bool { return true })
	require.True(t, terminal.Append(f.observe(t, 17)))
	f.send(t, 17, []byte("\x01\x01first"))
	readAgent(t, terminal, "first")
	f.credit(t, 17)
	queued := f.observe(t, 21)
	require.True(t, terminal.Append(queued))
	require.NoError(t, terminal.Close())
	// Nobody displays it now, yet every byte still returns its credit and the
	// stream stays known until the broker's close: the link survives.
	f.send(t, 17, []byte("\x01\x01more"))
	require.Equal(t, uint32(4), f.credit(t, 17))
	require.True(t, f.l.HasSession(17))
	f.send(t, 17, []byte{7})
	f.send(t, 21, []byte("\x01\x01queued"))
	require.Equal(t, uint32(6), f.credit(t, 21))
	f.send(t, 21, []byte{7})
	require.Eventually(t, func() bool { return !f.l.HasSession(17) && !f.l.HasSession(21) }, 3*time.Second, 10*time.Millisecond)
	require.NoError(t, f.l.RequireReady("a"))
	_, err := terminal.Read(make([]byte, 8))
	require.ErrorIs(t, err, io.EOF)
}

func TestAgentTerminalEndsAWatchKilledWithItsRun(t *testing.T) {
	f := agentTerminalFixture(t)
	terminal := NewAgentTerminal(func() bool { return true })
	require.True(t, terminal.Append(f.observe(t, 17)))
	done := make(chan error, 1)
	go func() {
		_, err := NewSessions(f.l.Connection, "a", f.r.Sessions("a")).KillRun(t.Context(), "run-1")
		done <- err
	}()
	reply(t, f.peer, nextFrame(t, f.frames), wire.KillSessions, wire.Field(1, wire.U16(2)))
	require.NoError(t, <-done)
	require.False(t, f.l.HasSession(17), "kill_sessions(run) ends the watch with the run")
	read := make(chan error, 1)
	go func() { _, err := terminal.Read(make([]byte, 8)); read <- err }()
	require.NoError(t, terminal.Close())
	require.ErrorIs(t, <-read, io.EOF)
}
