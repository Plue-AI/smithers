package machined

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func terminalFixture(t *testing.T) (*Terminal, func([]byte), func() wire.Frame) {
	t.Helper()
	r := new(Registry)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, peer := connectTest(t, r, "a", authority)
	require.NoError(t, link.Reconciled())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	done := make(chan *Terminal, 1)
	go func() {
		terminal, err := NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "").OpenTerminal(ctx, SessionUser{"alice", 20001}, []string{"/bin/bash", "-l"}, &SessionSize{Cols: 80, Rows: 24})
		if err != nil {
			t.Error(err)
		}
		done <- terminal
	}()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	_, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	fields, err := wire.Fields("args6", args)
	require.NoError(t, err)
	require.Equal(t, byte(1), fields[2][0], "member terminal is a broker PTY")
	id, _, _, err := request.Request()
	require.NoError(t, err)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(17)))))}))
	terminal := <-done
	require.NotNil(t, terminal)
	return terminal, func(p []byte) { sendSession(t, peer, p) }, func() wire.Frame { f, err := wire.Read(peer); require.NoError(t, err); return f }
}

func TestTerminalConsumerReturnsCreditOnlyForReadBytes(t *testing.T) {
	terminal, send, receive := terminalFixture(t)
	send([]byte{1, 1, 'a', 'b', 'c'})
	for _, want := range []string{"ab", "c"} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			buf := make([]byte, 2)
			n, err := terminal.Read(buf)
			require.NoError(t, err)
			require.Equal(t, want, string(buf[:n]))
		}()
		f := receive()
		require.Equal(t, []byte{6, 0, 0, 0, byte(len(want))}, f.Payload)
		<-done
	}
	send([]byte{2, 1})
	send([]byte{2, 2})
	send([]byte{5, 0, 0, 0, 0, 7})
	_, err := terminal.Read(make([]byte, 1))
	var exit *ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, int32(7), exit.Code)
	_, err = terminal.Read(make([]byte, 1))
	require.ErrorAs(t, err, &exit)
}

func TestTerminalConsumerControlsAndHalfClose(t *testing.T) {
	terminal, send, receive := terminalFixture(t)
	run := func(action func() error, payload []byte) {
		done := make(chan error, 1)
		go func() { done <- action() }()
		require.Equal(t, payload, receive().Payload)
		require.NoError(t, <-done)
	}
	run(func() error { n, err := terminal.Write([]byte("hello")); require.Equal(t, 5, n); return err }, []byte{1, 0, 'h', 'e', 'l', 'l', 'o'})
	run(func() error { return terminal.Resize(t.Context(), 90, 30) }, []byte{3, 0, 90, 0, 30})
	require.ErrorIs(t, terminal.Resize(t.Context(), 0, 30), wire.BadValue)
	run(func() error { return terminal.CloseWrite(t.Context()) }, []byte{2, 0})
	_, err := terminal.Write([]byte("after EOF"))
	require.ErrorIs(t, err, io.ErrClosedPipe)
	send([]byte{1, 1, 'o', 'k'})
	run(func() error {
		buf := make([]byte, 2)
		n, err := terminal.Read(buf)
		require.Equal(t, "ok", string(buf[:n]))
		return err
	}, []byte{6, 0, 0, 0, 2})
	send([]byte{2, 1})
	send([]byte{2, 2})
	send([]byte{5, 0, 0, 0, 0, 0})
	_, err = terminal.Read(make([]byte, 1))
	require.ErrorIs(t, err, io.EOF)
}

func TestTerminalConsumerCancellationAndSignalExit(t *testing.T) {
	terminal, send, _ := terminalFixture(t)
	send([]byte{2, 1})
	send([]byte{2, 2})
	send([]byte{5, 1, 2, 0})
	_, err := terminal.Read(make([]byte, 1))
	var exit *ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, byte(2), exit.Signal)
	require.False(t, exit.Core)
	terminal, _, _ = terminalFixture(t)
	terminal.cancel()
	_, err = terminal.Read(make([]byte, 1))
	require.True(t, errors.Is(err, context.Canceled))
	_, err = terminal.Write([]byte("x"))
	require.ErrorIs(t, err, context.Canceled)
}

func TestTerminalConsumerReconnectReplaysUnreadSuffix(t *testing.T) {
	r, old, peer, stream, authority := sessionFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	terminal := &Terminal{ctx: ctx, cancel: cancel, stream: stream}
	first := make(chan string, 1)
	go func() {
		buffer := make([]byte, 2)
		n, err := terminal.Read(buffer)
		if err != nil {
			t.Error(err)
		}
		first <- string(buffer[:n])
	}()
	sendSession(t, peer, []byte{1, 1, 'a', 'b', 'c', 'd', 'e', 'f'})
	credit, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 2}, credit.Payload)
	require.Equal(t, "ab", <-first)
	require.NoError(t, old.Close())
	replacement, next := connectTest(t, r, "a", authority)
	require.NoError(t, replacement.Reconciled())
	done := make(chan error, 1)
	go func() { done <- terminal.reattach() }()
	request, err := wire.Read(next)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.AttachSession), method)
	fields, err := wire.Fields("args15", args)
	require.NoError(t, err)
	require.Equal(t, []byte{0, 0, 0, 0, 0, 0, 0, 2}, fields[2], "only bytes read count as delivered")
	require.NoError(t, wire.Write(next, wire.Frame{Kind: wire.Control, Payload: wire.Union(2,
		wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.AttachSession), wire.Field(1, wire.U64(0)))))}))
	require.NoError(t, <-done)
	remaining := make(chan string, 1)
	go func() {
		buffer := make([]byte, 4)
		n, err := terminal.Read(buffer)
		if err != nil {
			t.Error(err)
		}
		remaining <- string(buffer[:n])
	}()
	sendSession(t, next, []byte{1, 1, 'c', 'd', 'e', 'f'})
	credit, err = wire.Read(next)
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 4}, credit.Payload)
	require.Equal(t, "cdef", <-remaining)
}

func TestTerminalConsumerWriteReconnectUsesConsumedStdinOffset(t *testing.T) {
	r, old, peer, stream, authority := sessionFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	terminal := &Terminal{ctx: ctx, cancel: cancel, stream: stream}
	written := make(chan error, 1)
	go func() { _, err := terminal.Write([]byte("stdin")); written <- err }()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 0, 's', 't', 'd', 'i', 'n'}, frame.Payload)
	require.NoError(t, <-written)
	require.NoError(t, old.Close())
	replacement, next := connectTest(t, r, "a", authority)
	require.NoError(t, replacement.Reconciled())
	go func() {
		n, err := terminal.Write([]byte("new"))
		if err == nil && n != 3 {
			t.Errorf("written %d bytes, want 3", n)
		}
		written <- err
	}()
	answer(t, next, wire.AttachSession, wire.Field(1, wire.U64(2)))
	frame, err = wire.Read(next)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 0, 'd', 'i', 'n'}, frame.Payload, "consumed stdin is never replayed")
	frame, err = wire.Read(next)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 0, 'n', 'e', 'w'}, frame.Payload)
	require.NoError(t, <-written)
	go func() { written <- terminal.CloseWrite(ctx) }()
	frame, err = wire.Read(next)
	require.NoError(t, err)
	require.Equal(t, []byte{2, 0}, frame.Payload)
	require.NoError(t, <-written)
	_, err = terminal.Write([]byte("after EOF"))
	require.ErrorIs(t, err, io.ErrClosedPipe)
}
