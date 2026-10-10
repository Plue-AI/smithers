package machined

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func execFixture(t *testing.T, via string) (*Exec, net.Conn) {
	t.Helper()
	r := new(Registry)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, peer := connectTest(t, r, "a", authority)
	require.NoError(t, link.Reconciled())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	done := make(chan *Exec, 1)
	go func() {
		process, err := NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "").WithPresenceVia(via).OpenExec(ctx, SessionUser{"alice", 20001}, []string{"/bin/sh", "-c", "exec server --stdio"})
		if err != nil {
			t.Error(err)
		}
		done <- process
	}()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenSession), method)
	fields, err := wire.Fields("args6", args)
	require.NoError(t, err)
	require.Equal(t, byte(2), fields[2][0], "language servers run as broker exec sessions")
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(17)))))}))
	process := <-done
	require.NotNil(t, process)
	require.Equal(t, uint32(17), process.ID())
	cancel()
	return process, peer
}

func TestExecSeparatesStdoutAndStderrAndReturnsCreditAfterReads(t *testing.T) {
	process, peer := execFixture(t, "lsp")
	sendSession(t, peer, []byte{1, 2, 'w', 'a', 'r', 'n'})
	sendSession(t, peer, []byte{1, 1, 'r', 'e', 'a', 'd', 'y'})
	stderr := make([]byte, 4)
	_, err := io.ReadFull(process.Stderr(), stderr)
	require.NoError(t, err)
	require.Equal(t, "warn", string(stderr))
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 4}, frame.Payload, "stderr credit after the consumer read it")
	stdout := make([]byte, 5)
	_, err = io.ReadFull(process.Stdout(), stdout)
	require.NoError(t, err)
	require.Equal(t, "ready", string(stdout))
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 5}, frame.Payload)

	written := make(chan error, 1)
	go func() { _, err := process.Write([]byte("Content-Length: 2\r\n\r\n{}")); written <- err }()
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, append([]byte{1, 0}, "Content-Length: 2\r\n\r\n{}"...), frame.Payload)
	require.NoError(t, <-written)
	go func() { written <- process.CloseWrite() }()
	frame, err = wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{2, 0}, frame.Payload)
	require.NoError(t, <-written)

	sendSession(t, peer, []byte{2, 1})
	sendSession(t, peer, []byte{2, 2})
	sendSession(t, peer, []byte{5, 0, 0, 0, 0, 3})
	rest, err := io.ReadAll(process.Stdout())
	require.NoError(t, err)
	require.Empty(t, rest)
	var exit *ExitError
	require.ErrorAs(t, process.Wait(), &exit)
	require.Equal(t, 3, exit.ExitStatus())
}

func TestExecCleanExitAndSignal(t *testing.T) {
	process, peer := execFixture(t, "lsp")
	sendSession(t, peer, []byte{5, 0, 0, 0, 0, 0})
	require.NoError(t, process.Wait())

	process, peer = execFixture(t, "lsp")
	sendSession(t, peer, []byte{5, 1, 4, 0})
	var exit *ExitError
	require.ErrorAs(t, process.Wait(), &exit)
	require.Equal(t, byte(4), exit.Signal, "wire signal 4 is KILL")
}

// The broker sends an exec's exit after both output EOFs and then nothing: it
// never closes an owner's stream (crates/smithers-machined/tests/
// session_dispatch.rs exit_follows_both_outputs_and_marks_registry_once). Wait
// must return at that exit, with the session still open for Kill (#3761).
func TestExecWaitReturnsAtTheBrokersExitWithoutAClose(t *testing.T) {
	process, peer := execFixture(t, "lsp")
	stdout := make(chan string, 1)
	go func() {
		read, _ := io.ReadAll(process.Stdout())
		stdout <- string(read)
	}()
	sendSession(t, peer, []byte{1, 1, 'o', 'k'})
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, []byte{6, 0, 0, 0, 2}, frame.Payload)
	sendSession(t, peer, []byte{2, 1})
	sendSession(t, peer, []byte{2, 2})
	sendSession(t, peer, []byte{5, 0, 0, 0, 0, 9})
	waited := make(chan error, 1)
	go func() { waited <- process.Wait() }()
	select {
	case err := <-waited:
		var exit *ExitError
		require.ErrorAs(t, err, &exit)
		require.Equal(t, 9, exit.ExitStatus())
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return at the exit frame")
	}
	require.Equal(t, "ok", <-stdout)
	stderr, err := io.ReadAll(process.Stderr())
	require.NoError(t, err)
	require.Empty(t, stderr)
}

func TestExecCloseWithoutExitIsATransportFailure(t *testing.T) {
	process, peer := execFixture(t, "lsp")
	sendSession(t, peer, []byte{7})
	require.ErrorIs(t, process.Wait(), io.ErrUnexpectedEOF)
}

func TestExecKillEmptiesTheSessionThenCloses(t *testing.T) {
	process, peer := execFixture(t, "lsp")
	killed := make(chan error, 1)
	go func() { killed <- process.Kill(t.Context()) }()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.KillSessions), method)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.KillSessions), wire.Field(1, wire.U16(1)))))}))
	// The confirmed kill retires the stream; no separate close_session follows.
	require.NoError(t, <-killed)
	_, err = process.Stdout().Read(make([]byte, 1))
	require.Error(t, err)
	require.Error(t, process.Wait(), "a killed session never reports a clean exit")
}

func TestSessionsRefuseUnknownPresenceVia(t *testing.T) {
	r := new(Registry)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, "a", authority)
	require.NoError(t, link.Reconciled())
	_, err = NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "").WithPresenceVia("browser").OpenExec(t.Context(), SessionUser{"alice", 20001}, []string{"/bin/true"})
	var refusal *SessionError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "unauthorized", refusal.Code)
}
