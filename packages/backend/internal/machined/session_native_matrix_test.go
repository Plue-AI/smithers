package machined

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// Send malformed control bodies on the actual authenticated connection. Calling
// Link.Request would reject these in the host codec and prove nothing about the
// installed daemon. Keep the production reader and correlation dispatcher.
func (h *nativeSessionHarness) rawSessionRequest(method byte, args ...[]byte) map[byte][]byte {
	h.t.Helper()
	l := h.link
	l.mu.Lock()
	id := l.next
	l.next++
	reply := make(chan wire.Frame, 1)
	l.pending[id] = reply
	l.mu.Unlock()
	defer func() { l.mu.Lock(); delete(l.pending, id); l.mu.Unlock() }()
	payload := wire.Union(1, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(method, args...)))
	packet := make([]byte, 9, 9+len(payload))
	binary.BigEndian.PutUint32(packet, uint32(len(payload)))
	packet[4] = 1 // ADR control, stream zero
	packet = append(packet, payload...)
	l.writeMu.Lock()
	err := l.stream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err == nil {
		_, err = io.Copy(l.stream, bytes.NewReader(packet))
	}
	l.writeMu.Unlock()
	require.NoError(h.t, err)
	select {
	case frame := <-reply:
		fields, err := wire.Fields("response", frame.Payload[1:])
		require.NoError(h.t, err)
		require.Equal(h.t, byte(255), fields[2][0], "hostile RPC was accepted")
		failure, err := wire.Fields("error", fields[2][1:])
		require.NoError(h.t, err)
		return failure
	case <-l.Done():
		h.t.Fatal("daemon lost authenticated connection instead of correlated refusal")
	case <-time.After(5 * time.Second):
		h.t.Fatal("daemon did not refuse hostile RPC within five seconds")
	case <-h.ctx.Done():
		h.t.Fatal(h.ctx.Err())
	}
	return nil
}

func TestSessionProductionExpiredReattach(t *testing.T) {
	h := nativeSessions(t)
	e, err := h.sessions.OpenExec(h.ctx, nativeBen, []string{"/bin/sh", "-c", "cat /proc/self/cgroup; exec sleep 120"})
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = h.registry.Sessions(h.config.Branch).CallSession(ctx, SessionCall{Method: "kill_sessions", Session: e.ID()})
	})
	line, err := bufio.NewReader(e.Stdout()).ReadString('\n')
	require.NoError(t, err)
	group := strings.TrimSpace(strings.TrimPrefix(line, "0::"))
	require.Regexp(t, `^/smithers/sessions/s[1-9][0-9]*$`, group)
	require.NoError(t, h.link.Close())
	select {
	case <-time.After(31 * time.Second):
	case <-h.ctx.Done():
		t.Fatal(h.ctx.Err())
	}
	h.connect()
	h.sessions = NewSessions(h.link.Connection, h.config.Branch, h.registry.Sessions(h.config.Branch)).WithActor(h.sessions.actor, "")
	// Reconnect authentication does not refresh a session's expired grace.
	for attempt := 0; attempt < 2; attempt++ {
		failure := h.rawSessionRequest(15, wire.Field(1, wire.U32(e.ID())), wire.Field(2, wire.U64(0)))
		require.Equal(t, []byte{1}, failure[1])
	}
	// Expiry closes input; it must retain attribution for any lingering sleep.
	// Explicit kill must still find and drain that owned cgroup.
	_, err = h.sessions.KillSession(h.ctx, e.ID())
	require.NoError(t, err)
	require.Equal(t, "empty\n", h.output(nativeAlice, fmt.Sprintf("test ! -d /sys/fs/cgroup%s || grep -qx 'populated 0' /sys/fs/cgroup%s/cgroup.events; test $? = 0 && echo empty", group, group)))
}

func TestSessionProductionRunDrainIsolation(t *testing.T) {
	h := nativeSessions(t)
	first, second := *h, *h
	first.sessions = h.sessions.WithActor(h.sessions.actor, "146a4710-20a6-4815-bd2b-7033a3b60701")
	second.sessions = h.sessions.WithActor(h.sessions.actor, "146a4710-20a6-4815-bd2b-7033a3b60702")
	agent := SessionUser{"agent", 19999}
	a, aout, aerr := first.exec(agent, "/bin/sh", "-c", "nohup sleep 120 >/dev/null 2>&1 </dev/null & exec cat")
	b, bout, berr := second.exec(agent, "/bin/cat")
	member, mout, merr := h.exec(nativeBen, "/bin/cat")
	require.NoError(t, first.sessions.RegisterRun(h.ctx, first.sessions.run, a.ID()))
	require.NoError(t, second.sessions.RegisterRun(h.ctx, second.sessions.run, b.ID()))
	require.Equal(t, "ready\n", h.output(nativeAlice, fmt.Sprintf(`for i in $(seq 1 100); do test "$(wc -l < /sys/fs/cgroup/smithers/sessions/s%d/cgroup.procs)" -ge 2 && { echo ready; exit; }; sleep .01; done; exit 1`, a.ID())))
	// Registration can only confirm admission; it cannot move a live cgroup to
	// a different run. The foreign run must remain unaffected by a later kill.
	failure := h.rawSessionRequest(10, wire.Field(1, wire.String(second.sessions.run)), wire.Field(2, wire.U32(a.ID())))
	require.Equal(t, []byte{1}, failure[1])
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	started := time.Now()
	killed, err := first.sessions.KillRun(ctx, first.sessions.run)
	require.NoError(t, err)
	require.Equal(t, uint16(1), killed)
	require.Less(t, time.Since(started), 5*time.Second)
	require.Error(t, a.Wait(), "killed session cannot finish successfully")
	require.Empty(t, <-aout)
	require.Empty(t, <-aerr)
	require.Equal(t, "empty\n", h.output(nativeAlice, fmt.Sprintf(`p=/sys/fs/cgroup/smithers/sessions/s%d; { test ! -d "$p" || grep -qx 'populated 0' "$p/cgroup.events"; } && echo empty`, a.ID())))
	for _, cell := range []struct {
		process     *Exec
		out, stderr <-chan []byte
		text        string
	}{{b, bout, berr, "other-run-survived\n"}, {member, mout, merr, "member-survived\n"}} {
		_, err := cell.process.Write([]byte(cell.text))
		require.NoError(t, err)
		require.NoError(t, cell.process.CloseWrite())
		require.NoError(t, cell.process.Wait())
		require.Equal(t, cell.text, string(<-cell.out))
		require.Empty(t, <-cell.stderr)
	}
	killed, err = first.sessions.KillRun(h.ctx, first.sessions.run)
	require.NoError(t, err)
	require.Zero(t, killed)
}

func testSessionNativeRPCMatrix(t *testing.T, h *nativeSessionHarness) {
	t.Helper()
	// A held real process must survive every hostile selector. Its final echo
	// proves the original process/stream remained usable, not merely a new spawn.
	control, out, stderr := h.exec(nativeBen, "/bin/cat")
	user := wire.Field(1, wire.Struct(wire.Field(1, wire.String("ben")), wire.Field(2, wire.U32(20001))))
	actor := wire.Field(5, h.sessions.actor)
	argv := wire.Field(3, append(wire.U16(1), wire.String("/usr/bin/id")...))
	for _, cell := range []struct {
		name   string
		method byte
		args   [][]byte
		code   byte
	}{
		{"unknown method", 99, nil, 1},
		{"unknown field", 6, [][]byte{user, wire.Field(2, []byte{2}), argv, actor, wire.Field(99, []byte{1})}, 1},
		{"missing user", 6, [][]byte{wire.Field(2, []byte{2}), argv, actor}, 1},
		{"unknown kind", 6, [][]byte{user, wire.Field(2, []byte{99}), argv, actor}, 1},
		{"empty exec", 6, [][]byte{user, wire.Field(2, []byte{2}), actor}, 1},
		{"sftp executable override", 6, [][]byte{user, wire.Field(2, []byte{3}), argv, actor}, 1},
		{"zero columns", 6, [][]byte{user, wire.Field(2, []byte{1}), wire.Field(4, wire.Struct(wire.Field(1, wire.U16(0)), wire.Field(2, wire.U16(24)))), actor}, 1},
		{"exec dimensions", 6, [][]byte{user, wire.Field(2, []byte{2}), argv, wire.Field(4, wire.Struct(wire.Field(1, wire.U16(80)), wire.Field(2, wire.U16(24)))), actor}, 1},
		{"NUL executable", 6, [][]byte{user, wire.Field(2, []byte{2}), wire.Field(3, append(wire.U16(1), wire.String("/usr/bin/id\x00")...)), actor}, 1},
		{"invalid UTF8 executable", 6, [][]byte{user, wire.Field(2, []byte{2}), wire.Field(3, append(wire.U16(1), wire.String("\xff")...)), actor}, 1},
		{"oversized executable", 6, [][]byte{user, wire.Field(2, []byte{2}), wire.Field(3, append(wire.U16(1), wire.String(string(bytes.Repeat([]byte{'x'}, 4097)))...)), actor}, 1},
		{"zero port", 7, [][]byte{wire.Field(1, wire.U16(0)), wire.Field(2, h.sessions.actor)}, 1},
		{"zero close selector", 8, [][]byte{wire.Field(1, wire.U32(0))}, 1},
		{"cgroup path field", 8, [][]byte{wire.Field(1, wire.U32(control.ID())), wire.Field(2, wire.String("../../"))}, 1},
		{"zero kill selector", 9, [][]byte{wire.Field(1, wire.Union(3, wire.Field(1, wire.U32(0))))}, 1},
		{"empty kill run", 9, [][]byte{wire.Field(1, wire.Union(2, wire.Field(1, wire.String(""))))}, 1},
		{"member run registration", 10, [][]byte{wire.Field(1, wire.String("foreign-run")), wire.Field(2, wire.U32(control.ID()))}, 1},
		{"empty run registration", 10, [][]byte{wire.Field(1, wire.String("")), wire.Field(2, wire.U32(control.ID()))}, 1},
		{"future replay offset", 15, [][]byte{wire.Field(1, wire.U32(control.ID())), wire.Field(2, wire.U64(^uint64(0)))}, 1},
	} {
		t.Run(cell.name, func(t *testing.T) {
			copy := *h
			copy.t = t
			failure := copy.rawSessionRequest(cell.method, cell.args...)
			require.Equal(t, []byte{cell.code}, failure[1])
		})
	}
	_, err := control.Write([]byte("original-control-survived\n"))
	require.NoError(t, err)
	require.NoError(t, control.CloseWrite())
	require.NoError(t, control.Wait())
	require.Equal(t, "original-control-survived\n", string(<-out))
	require.Empty(t, <-stderr)
	// A killed ID cannot be revived or rebound; retrying kill is idempotent.
	_, err = h.sessions.KillSession(h.ctx, control.ID())
	require.NoError(t, err)
	for _, method := range []byte{8, 10, 15} {
		t.Run(fmt.Sprintf("drained selector/%d", method), func(t *testing.T) {
			copy := *h
			copy.t = t
			args := [][]byte{wire.Field(1, wire.U32(control.ID()))}
			if method == 10 {
				args = [][]byte{wire.Field(1, wire.String("foreign-run")), wire.Field(2, wire.U32(control.ID()))}
			} else if method == 15 {
				args = append(args, wire.Field(2, wire.U64(0)))
			}
			failure := copy.rawSessionRequest(method, args...)
			require.Equal(t, []byte{1}, failure[1])
		})
	}
	killed, err := h.sessions.KillSession(h.ctx, control.ID())
	require.NoError(t, err)
	require.Zero(t, killed)
}
