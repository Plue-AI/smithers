package machined

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// lspConfinementLink is an admitted host link whose guest end the test reads:
// a refusal must leave it silent, so nothing reached the root broker.
func lspConfinementLink(t *testing.T) (*Sessions, net.Conn) {
	t.Helper()
	r := new(Registry)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, guest := connectTest(t, r, "a", authority)
	require.NoError(t, link.Reconciled())
	return NewSessions(link.Connection, "a", r.Sessions("a")).WithActor([]byte("actor-reference1"), "").WithPresenceVia("lsp"), guest
}

func requireGuestSilent(t *testing.T, guest net.Conn) {
	t.Helper()
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(50*time.Millisecond)))
	n, err := guest.Read(make([]byte, 1))
	var timeout net.Error
	require.Zero(t, n, "a refused control input reached the guest")
	require.True(t, errors.As(err, &timeout) && timeout.Timeout(), "guest link ended instead of staying silent: %v", err)
	require.NoError(t, guest.SetReadDeadline(time.Time{}))
}

// TestLspRootInputsValidatedBeforeUse is C-COL-04's code-intelligence row at
// the host: every identity and session-control input the language-server
// door hands the root broker is validated before a frame leaves the host.
// The guest half (member uid/gid/groups before repository code loads, hostile
// PATH/LD_PRELOAD/PYTHONPATH, cgroup traversal, retained-machine symlinks and
// root sentinels) needs real users and cgroups: the reference-host microVM.
func TestLspRootInputsValidatedBeforeUse(t *testing.T) {
	argv := []string{"/bin/sh", "-c", "exec typescript-language-server --stdio"}
	for _, tc := range []struct {
		name string
		user SessionUser
		argv []string
		code string
	}{
		{"root login", SessionUser{"root", 20001}, argv, "unauthorized"},
		{"uid 0", SessionUser{"maya", 0}, argv, "unauthorized"},
		{"daemon account", SessionUser{"machined", 20001}, argv, "unauthorized"},
		{"agent login on a member uid", SessionUser{"agent", 20001}, argv, "unauthorized"},
		{"member login on the agent uid", SessionUser{"maya", 19999}, argv, "unauthorized"},
		{"system uid", SessionUser{"maya", 1000}, argv, "unauthorized"},
		{"uid past the member range", SessionUser{"maya", 0x80000000}, argv, "unauthorized"},
		{"login traversal", SessionUser{"../x", 20001}, argv, "unauthorized"},
		{"cgroup path in login", SessionUser{"a/b", 20001}, argv, "unauthorized"},
		{"overlong login", SessionUser{"abcdefghijklmnopqrstuvwxyz0123456", 20001}, argv, "unauthorized"},
		{"empty argv", SessionUser{"maya", 20001}, nil, "malformed"},
		{"NUL in argv", SessionUser{"maya", 20001}, []string{"/bin/sh", "-c", "exec x\x00--stdio"}, "malformed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sessions, guest := lspConfinementLink(t)
			_, err := sessions.OpenExec(t.Context(), tc.user, tc.argv)
			var refusal *SessionError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, tc.code, refusal.Code)
			requireGuestSilent(t, guest)
		})
	}
	for _, id := range []uint32{0, 0x80000000, 0xffffffff} {
		sessions, guest := lspConfinementLink(t)
		var refusal *SessionError
		_, err := sessions.KillSession(t.Context(), id)
		require.ErrorAs(t, err, &refusal, "kill %d", id)
		require.Equal(t, "malformed", refusal.Code)
		require.ErrorAs(t, sessions.CloseSession(t.Context(), id), &refusal, "close %d", id)
		_, err = sessions.AttachSession(t.Context(), id, 0)
		require.ErrorAs(t, err, &refusal, "attach %d", id)
		_, err = sessions.Stream(t.Context(), id)
		require.ErrorAs(t, err, &refusal, "stream %d", id)
		requireGuestSilent(t, guest)
	}
	t.Run("unattributed launch", func(t *testing.T) {
		sessions, guest := lspConfinementLink(t)
		_, err := sessions.WithActor(nil, "").OpenExec(t.Context(), SessionUser{"maya", 20001}, argv)
		var refusal *SessionError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, "unauthorized", refusal.Code)
		requireGuestSilent(t, guest)
	})
	t.Run("valid member session", func(t *testing.T) {
		sessions, guest := lspConfinementLink(t)
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		opened := make(chan error, 1)
		go func() {
			process, err := sessions.OpenExec(ctx, SessionUser{"maya", 20001}, argv)
			if err == nil {
				_ = process.Close()
			}
			opened <- err
		}()
		request, err := wire.Read(guest)
		require.NoError(t, err)
		id, method, args, err := request.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.OpenSession), method)
		fields, err := wire.Fields("args6", args)
		require.NoError(t, err)
		require.Equal(t, []byte{2}, fields[2], "an exec session, never a PTY")
		user, err := wire.Fields("user", fields[1])
		require.NoError(t, err)
		require.Equal(t, append(wire.U16(4), "maya"...), user[1])
		require.Equal(t, wire.U32(20001), user[2])
		require.Equal(t, append(append(append(wire.U16(3), append(wire.U16(7), "/bin/sh"...)...), append(wire.U16(2), "-c"...)...), append(wire.U16(39), "exec typescript-language-server --stdio"...)...), fields[3], "argv crosses verbatim; the broker applies it after the uid drop")
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.OpenSession), wire.Field(1, wire.U32(17)))))}))
		go func() {
			// Answer the stream close the test's cleanup sends.
			if request, err := wire.Read(guest); err == nil {
				if id, _, _, err := request.Request(); err == nil {
					_ = wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.CloseSession))))})
				}
			}
		}()
		require.NoError(t, <-opened)
	})
}
