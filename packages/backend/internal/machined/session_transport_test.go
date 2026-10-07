package machined

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func sessionFixture(t *testing.T) (*Registry, *Link, net.Conn, *SessionStream, BootAuthority) {
	t.Helper()
	r := new(Registry)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	l, peer := connectTest(t, r, "a", authority)
	require.NoError(t, l.Reconciled())
	result := make(chan error, 1)
	go func() {
		_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Method: "open_session", User: &SessionUser{"alice", 20001}, Kind: SessionExec, Argv: []string{"wc", "-c"}})
		result <- err
	}()
	answer(t, peer, wire.OpenSession, wire.Field(1, wire.U32(17)))
	require.NoError(t, <-result)
	stream, err := r.Sessions("a").(SessionTransport).Stream(t.Context(), 17)
	require.NoError(t, err)
	return r, l, peer, stream, authority
}
func sendSession(t *testing.T, peer net.Conn, p []byte) {
	t.Helper()
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Sessions, Stream: 17, Payload: p}))
}
func sendInput(t *testing.T, peer net.Conn, s *SessionStream, p []byte) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- s.Send(t.Context(), p) }()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, wire.Sessions, frame.Kind)
	require.Equal(t, uint32(17), frame.Stream)
	require.Equal(t, p, frame.Payload)
	require.NoError(t, <-done)
}
func TestSessionTransportAuthenticatedPumpAndConsumerCredit(t *testing.T) {
	_, l, peer, s, _ := sessionFixture(t)
	sendSession(t, peer, []byte{1, 1, 'o', 'u', 't'})
	p, err := s.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{1, 1, 'o', 'u', 't'}, p)
	require.ErrorIs(t, s.Send(t.Context(), []byte{6, 0, 0, 0, 4}), wire.BadValue, "cannot acknowledge undelivered data")
	sendInput(t, peer, s, []byte{6, 0, 0, 0, 3})
	sendInput(t, peer, s, []byte{1, 0, 'i', 'n'})
	sendSession(t, peer, []byte{6, 0, 0, 0, 2})
	p, err = s.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 2}, p)
	sendInput(t, peer, s, []byte{2, 0})
	require.ErrorIs(t, s.Send(t.Context(), []byte{1, 0, 'x'}), io.ErrClosedPipe)
	for _, want := range [][]byte{{2, 1}, {2, 2}, {5, 0, 0, 0, 0, 7}} {
		sendSession(t, peer, want)
		p, err = s.Receive(t.Context())
		require.NoError(t, err)
		require.Equal(t, want, p)
	}
	require.NoError(t, l.RequireReady("a"))
}
func TestSessionTransportFullCreditStallsAndWindowResumesWithoutBlockingRPC(t *testing.T) {
	_, l, peer, s, _ := sessionFixture(t)
	for range 4 {
		sendInput(t, peer, s, append([]byte{1, 0}, bytes.Repeat([]byte{'x'}, 65536)...))
	}
	waiting := make(chan error, 1)
	go func() { waiting <- s.Send(t.Context(), []byte{1, 0, 'e', 'n', 'd'}) }()
	select {
	case err := <-waiting:
		t.Fatalf("sent beyond credit: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	// An unrelated control exchange still completes while stdin is blocked.
	status := make(chan error, 1)
	go func() { _, err := l.Request(t.Context(), "a", wire.Status); status <- err }()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.Status), method)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(255, wire.Field(1, []byte{2}))))}))
	require.NoError(t, <-status)
	sendSession(t, peer, []byte{6, 0, 0, 0, 3})
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 0, 'e', 'n', 'd'}, frame.Payload)
	require.NoError(t, <-waiting)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	require.ErrorIs(t, s.Send(ctx, []byte{1, 0, 'x'}), context.DeadlineExceeded)
	require.NoError(t, l.RequireReady("a"), "credit wait cancellation does not cancel the link")
}
func TestSessionTransportRejectsUnsolicitedDirectionAndOverCredit(t *testing.T) {
	for _, bad := range [][]byte{{1, 0, 'x'}, {2, 0}, {6, 0, 0, 0, 1}, {3, 0, 80, 0, 24}} {
		t.Run(string([]byte{bad[0], bad[1]}), func(t *testing.T) {
			_, l, peer, _, _ := sessionFixture(t)
			sendSession(t, peer, bad)
			select {
			case <-l.done:
			case <-time.After(time.Second):
				t.Fatal("invalid input kept link open")
			}
		})
	}
	t.Run("output over credit", func(t *testing.T) {
		_, l, peer, _, _ := sessionFixture(t)
		for range 4 {
			sendSession(t, peer, append([]byte{1, 1}, bytes.Repeat([]byte{'x'}, 65536)...))
		}
		sendSession(t, peer, []byte{1, 1, 'x'})
		select {
		case <-l.done:
		case <-time.After(time.Second):
			t.Fatal("over-credit output accepted")
		}
	})
}
func TestSessionTransportReattachesOnlyMissingInputAndOutput(t *testing.T) {
	r, old, peer, s, a := sessionFixture(t)
	sendInput(t, peer, s, []byte{1, 0, 'a', 'b', 'c', 'd', 'e', 'f'})
	sendSession(t, peer, []byte{6, 0, 0, 0, 2})
	_, err := s.Receive(t.Context())
	require.NoError(t, err)
	sendSession(t, peer, []byte{1, 1, 'o', 'l', 'd'})
	_, err = s.Receive(t.Context())
	require.NoError(t, err)
	// This output is received by the pump but not delivered to the caller.
	sendSession(t, peer, []byte{1, 2, 'n', 'e', 'w'})
	replacement, nextPeer := connectTest(t, r, "a", a)
	require.NoError(t, replacement.Reconciled())
	require.Error(t, old.RequireReady("a"))
	attached := make(chan error, 1)
	go func() {
		n, err := s.Reattach(t.Context())
		if err == nil && n != 4 {
			err = wire.BadValue
		}
		attached <- err
	}()
	f, err := wire.Read(nextPeer)
	require.NoError(t, err)
	id, method, args, err := f.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.AttachSession), method)
	fields, err := wire.Fields("args15", args)
	require.NoError(t, err)
	require.Equal(t, uint64(3), binary.BigEndian.Uint64(fields[2]), "queued bytes must replay")
	require.NoError(t, wire.Write(nextPeer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(15, wire.Field(1, wire.U64(4)))))}))
	replay, err := wire.Read(nextPeer)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 0, 'e', 'f'}, replay.Payload)
	require.NoError(t, <-attached)
	sendSession(t, nextPeer, []byte{1, 2, 'n', 'e', 'w'})
	p, err := s.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{1, 2, 'n', 'e', 'w'}, p)
	sendSession(t, nextPeer, []byte{6, 0, 0, 0, 2})
	_, err = s.Receive(t.Context())
	require.NoError(t, err)
	s.mu.Lock()
	require.Empty(t, s.retained)
	require.Equal(t, uint64(6), s.received)
	s.mu.Unlock()
}
func TestSessionTransportCloseAndKillWakeReaders(t *testing.T) {
	for _, kill := range []bool{false, true} {
		t.Run(map[bool]string{false: "close", true: "kill"}[kill], func(t *testing.T) {
			r, _, peer, s, _ := sessionFixture(t)
			waiting := make(chan error, 1)
			go func() { _, err := s.Receive(t.Context()); waiting <- err }()
			closed := make(chan error, 1)
			if kill {
				go func() {
					_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Method: "kill_sessions", User: &SessionUser{"alice", 20001}})
					closed <- err
				}()
				answer(t, peer, wire.KillSessions, wire.Field(1, wire.U16(1)))
			} else {
				go func() { closed <- s.Close() }()
				answer(t, peer, wire.CloseSession)
			}
			require.NoError(t, <-closed)
			require.ErrorIs(t, <-waiting, io.EOF)
		})
	}
}
func TestSessionTransportRejectsForeignBootAndInvalidOutgoingControls(t *testing.T) {
	r, l, _, s, _ := sessionFixture(t)
	for _, p := range [][]byte{{1, 1, 'x'}, {2, 2}, {5, 0, 0, 0, 0, 1}, {3, 0, 0, 0, 24}, {4, 0}, {6, 0, 0, 0, 1}} {
		require.Error(t, s.Send(t.Context(), p))
	}
	require.NoError(t, l.RequireReady("a"))
	_, err := s.Reattach(t.Context())
	require.ErrorIs(t, err, ErrUnauthorized)
	a, err := r.MintBoot("a", "new-vm")
	require.NoError(t, err)
	next, _ := connectTest(t, r, "a", a)
	require.NoError(t, next.Reconciled())
	_, err = s.Reattach(t.Context())
	require.ErrorIs(t, err, ErrUnauthorized)
}

func TestSessionTransportReattachPreservesReplayOnBadOffsetAndReplaysEOF(t *testing.T) {
	for _, bad := range []bool{false, true} {
		t.Run(map[bool]string{false: "EOF", true: "bad offset"}[bad], func(t *testing.T) {
			r, _, peer, s, a := sessionFixture(t)
			sendInput(t, peer, s, []byte{1, 0, 'a', 'b'})
			sendInput(t, peer, s, []byte{2, 0})
			replacement, next := connectTest(t, r, "a", a)
			require.NoError(t, replacement.Reconciled())
			result := make(chan error, 1)
			go func() { _, err := s.Reattach(t.Context()); result <- err }()
			received := uint64(2)
			if bad {
				received = 3
			}
			answer(t, next, wire.AttachSession, wire.Field(1, wire.U64(received)))
			if bad {
				require.ErrorIs(t, <-result, wire.BadValue)
				s.mu.Lock()
				require.Equal(t, []byte("ab"), s.retained)
				s.mu.Unlock()
			} else {
				f, err := wire.Read(next)
				require.NoError(t, err)
				require.Equal(t, []byte{2, 0}, f.Payload)
				require.NoError(t, <-result)
			}
		})
	}
}
func TestSessionTransportOpenQueuesOutputBeforeCallerReceivesResult(t *testing.T) {
	r, l, peer := rpcFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Method: "tcp_connect", Port: 8080})
		done <- err
	}()
	answer(t, peer, wire.TCPConnect, wire.Field(1, wire.U32(17)))
	sendSession(t, peer, []byte{1, 1, 'x'})
	require.NoError(t, <-done)
	s, err := NewSessions(l.Connection, "a", r.Sessions("a")).Stream(t.Context(), 17)
	require.NoError(t, err)
	p, err := s.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{1, 1, 'x'}, p)
	go func() {
		_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Method: "kill_sessions", User: &SessionUser{"agent", 19999}})
		done <- err
	}()
	answer(t, peer, wire.KillSessions, wire.Field(1, wire.U16(1)))
	require.NoError(t, <-done)
	_, err = s.Receive(t.Context())
	require.ErrorIs(t, err, io.EOF)
}
