package machined

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// These host receipts enter the production admitted RPC adapter and observe
// the guest transport directly. Broker/kernel checks are in session_dispatch.rs;
// real users/cgroups use the installed production harness below; no authority
// configuration means that subtest skips rather than claiming native evidence.
func TestSessionRootInputsValidated(t *testing.T) {
	t.Run("installed production broker", TestSessionRootInputsValidatedNative)
	for _, user := range []SessionUser{{"root", 0}, {"ben", 0}, {"machined", 20001}, {"ben", 19999}, {"agent", 20001}, {"../ben", 20001}, {"ben/../../s1", 20001}, {"BEN", 20001}, {strings.Repeat("b", 33), 20001}, {"ben", 0x80000000}} {
		t.Run(fmt.Sprintf("%s/%d", user.Login, user.UID), func(t *testing.T) {
			sessions, guest := lspConfinementLink(t)
			_, err := sessions.WithPresenceVia("terminal").OpenSession(t.Context(), user, SessionPTY, nil, &SessionSize{80, 24})
			errorCode(t, err, "unauthorized")
			requireGuestSilent(t, guest)
		})
	}
	for _, cell := range []struct {
		name string
		kind SessionKind
		argv []string
		size *SessionSize
	}{
		{"unknown kind", 0, nil, nil}, {"empty exec", SessionExec, nil, nil}, {"too many arguments", SessionPTY, make([]string, 65536), nil}, {"zero columns", SessionPTY, nil, &SessionSize{0, 24}}, {"zero rows", SessionPTY, nil, &SessionSize{80, 0}},
		{"exec dimensions", SessionExec, []string{"/bin/sh"}, &SessionSize{80, 24}}, {"sftp argv", SessionSFTP, []string{"/workspace/root-canary"}, nil},
		{"empty executable", SessionPTY, []string{""}, nil},
		{"NUL argv", SessionPTY, []string{"/bin/sh\x00"}, nil}, {"invalid UTF8", SessionPTY, []string{"\xff"}, nil}, {"oversize argv", SessionPTY, []string{strings.Repeat("x", 4097)}, nil},
	} {
		t.Run(cell.name, func(t *testing.T) {
			sessions, guest := lspConfinementLink(t)
			_, err := sessions.WithPresenceVia("terminal").OpenSession(t.Context(), SessionUser{"ben", 20001}, cell.kind, cell.argv, cell.size)
			errorCode(t, err, "malformed")
			requireGuestSilent(t, guest)
		})
	}
	for _, id := range []uint32{0, 0x80000000, 0xffffffff} {
		sessions, guest := lspConfinementLink(t)
		errorCode(t, sessions.CloseSession(t.Context(), id), "malformed")
		_, err := sessions.KillSession(t.Context(), id)
		errorCode(t, err, "malformed")
		_, err = sessions.AttachSession(t.Context(), id, 0)
		errorCode(t, err, "malformed")
		errorCode(t, sessions.RegisterRun(t.Context(), "run", id), "malformed")
		stream, err := sessions.Stream(t.Context(), id)
		errorCode(t, err, "malformed")
		require.Nil(t, stream)
		requireGuestSilent(t, guest)
	}
	// Lifecycle selectors cross the same privileged dispatch boundary as open.
	// A malformed run must neither kill a live run nor bind another session.
	for _, run := range []string{"", "run\x00foreign", "\xff", strings.Repeat("r", 4097)} {
		t.Run(fmt.Sprintf("run/%q", run), func(t *testing.T) {
			sessions, guest := lspConfinementLink(t)
			_, err := sessions.KillRun(t.Context(), run)
			errorCode(t, err, "malformed")
			errorCode(t, sessions.RegisterRun(t.Context(), run, 1), "malformed")
			requireGuestSilent(t, guest)
		})
	}
	for _, user := range []SessionUser{{"root", 0}, {"../ben", 20001}, {"ben", 19999}, {"agent", 20001}, {"ben", 0x80000000}} {
		t.Run(fmt.Sprintf("kill/%s/%d", user.Login, user.UID), func(t *testing.T) {
			sessions, guest := lspConfinementLink(t)
			_, err := sessions.KillUser(t.Context(), user)
			errorCode(t, err, "unauthorized")
			requireGuestSilent(t, guest)
		})
	}
	t.Run("zero loopback port", func(t *testing.T) {
		sessions, guest := lspConfinementLink(t)
		_, err := sessions.TCPConnect(t.Context(), 0)
		errorCode(t, err, "malformed")
		requireGuestSilent(t, guest)
	})

}

func TestSessionAdmissionFailsClosed(t *testing.T) {
	t.Run("installed production broker", TestSessionAdmissionFailsClosedNative)
	for _, mode := range []string{"nil sessions", "no provider", "no authenticated connection", "no registry", "no boot", "unreconciled", "wrong branch", "closed boot", "missing actor", "zero actor", "short actor", "long actor", "member with run", "invalid via", "cancelled", "unregistered agent"} {
		t.Run(mode, func(t *testing.T) {
			sessions, guest := lspConfinementLink(t)
			sessions = sessions.WithPresenceVia("terminal")
			user := SessionUser{"ben", 20001}
			ctx := context.Background()
			switch mode {
			case "nil sessions":
				sessions = nil
			case "no registry":
				sessions.connection = &Connection{boot: sessions.connection.boot}
			case "no boot":
				sessions.connection = &Connection{registry: sessions.connection.registry}
			case "no provider":
				sessions.rpc = nil
			case "no authenticated connection":
				sessions.connection = nil
			case "unreconciled":
				sessions.connection.registry.mu.Lock()
				sessions.connection.ready = false
				sessions.connection.registry.mu.Unlock()
			case "wrong branch":
				sessions.branch = "foreign"
			case "closed boot":
				require.NoError(t, sessions.connection.Close())
			case "missing actor":
				sessions = sessions.WithActor(nil, "")
			case "zero actor":
				sessions = sessions.WithActor(make([]byte, 16), "")
			case "short actor":
				sessions = sessions.WithActor([]byte{7}, "")
			case "long actor":
				sessions = sessions.WithActor([]byte(strings.Repeat("7", 17)), "")
			case "member with run":
				sessions = sessions.WithActor([]byte(strings.Repeat("7", 16)), "forged-run")
			case "invalid via":
				sessions = sessions.WithPresenceVia("agent:../../root")
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "unregistered agent":
				user = SessionUser{"agent", 19999}
			}
			_, err := sessions.OpenSession(ctx, user, SessionPTY, nil, nil)
			require.Error(t, err)
			// TCP shares admission, even though it has no explicit member selector.
			if mode != "unregistered agent" && mode != "member with run" {
				_, err = sessions.TCPConnect(ctx, 8080)
				require.Error(t, err)
			}
			// A connection losing admission must fence every session door, not
			// only new launches. Valid selectors ensure refusal is admission,
			// rather than malformed input hiding an unavailable provider.
			switch mode {
			case "nil sessions", "no provider", "no authenticated connection", "no registry", "no boot", "unreconciled", "wrong branch", "closed boot", "cancelled":
				for name, call := range map[string]func() error{
					"close":        func() error { return sessions.CloseSession(ctx, 1) },
					"kill session": func() error { _, err := sessions.KillSession(ctx, 1); return err },
					"kill member":  func() error { _, err := sessions.KillUser(ctx, SessionUser{"ben", 20001}); return err },
					"kill run":     func() error { _, err := sessions.KillRun(ctx, "registered-run"); return err },
					"register run": func() error { return sessions.RegisterRun(ctx, "registered-run", 1) },
					"attach":       func() error { _, err := sessions.AttachSession(ctx, 1, 0); return err },
					"stream":       func() error { _, err := sessions.Stream(ctx, 1); return err },
				} {
					t.Run(name, func(t *testing.T) { require.Error(t, call()) })
				}
			}
			if mode != "closed boot" {
				requireGuestSilent(t, guest)
			}
		})
	}
}

func TestTerminalRootInputsValidatedBeforeUse(t *testing.T) {
	// The production terminal adapter uses the same OpenSession admission and
	// selector validation; exercise it explicitly rather than a helper validator.
	for _, cell := range []struct {
		user SessionUser
		size *SessionSize
		argv []string
	}{
		{SessionUser{"root", 0}, &SessionSize{80, 24}, []string{"/workspace/root-canary"}},
		{SessionUser{"../ben", 20001}, &SessionSize{80, 24}, nil},
		{SessionUser{"ben", 20001}, &SessionSize{0, 24}, nil},
		{SessionUser{"ben", 20001}, &SessionSize{80, 24}, []string{"/bin/sh\x00"}},
	} {
		sessions, guest := lspConfinementLink(t)
		terminal, err := sessions.WithPresenceVia("terminal").OpenTerminal(t.Context(), cell.user, cell.argv, cell.size)
		require.Error(t, err)
		require.Nil(t, terminal)
		requireGuestSilent(t, guest)
	}
}
