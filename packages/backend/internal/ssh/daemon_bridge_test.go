package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	gossh "golang.org/x/crypto/ssh"
	"io"
	"sync"
	"testing"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

type daemonFixture struct {
	mu       sync.Mutex
	sent     [][]byte
	received chan []byte
	opened   int
	kind     machined.SessionKind
	argv     []string
	user     machined.SessionUser
	port     uint16
	closed   int
}

func (f *daemonFixture) Send(_ context.Context, p []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, append([]byte(nil), p...))
	return nil
}
func (f *daemonFixture) Receive(ctx context.Context) ([]byte, error) {
	select {
	case p := <-f.received:
		return p, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (f *daemonFixture) Stream(context.Context, uint32) (DaemonStream, error) { return f, nil }
func (f *daemonFixture) OpenSession(_ context.Context, u machined.SessionUser, k machined.SessionKind, a []string, _ *machined.SessionSize) (uint32, error) {
	f.opened++
	f.kind = k
	f.argv = a
	f.user = u
	return 17, nil
}
func (f *daemonFixture) TCPConnect(_ context.Context, p uint16) (uint32, error) {
	f.port = p
	return 17, nil
}
func (f *daemonFixture) CloseSession(context.Context, uint32) error { f.closed++; return nil }
func daemonBridgeFixture(f *daemonFixture) *DaemonBridge {
	return &DaemonBridge{
		Ready: func(context.Context, WorkspaceAccess) error { return nil },
		Admit: func(context.Context, WorkspaceAccess, microsandbox.AdmissionRequest, io.Writer) (DaemonClient, func(), error) {
			return f, func() {}, nil
		},
		Track: func(context.Context, WorkspaceAccess, uint32) (func(), error) { return func() {}, nil },
	}
}

var daemonAccess = WorkspaceAccess{SandboxID: "machine-1", MemberID: 7, User: "alice", UID: 20001}

// Supplemental channel mapping only: the member image and privileged broker
// require the reference-host C-J3-06 receipt before install activation.
func TestDaemonBridgeUnavailableProviders(t *testing.T) {
	for _, missing := range []string{"ready", "admission", "tracking"} {
		t.Run(missing, func(t *testing.T) {
			f := &daemonFixture{}
			b := daemonBridgeFixture(f)
			switch missing {
			case "ready":
				b.Ready = nil
			case "admission":
				b.Admit = nil
			case "tracking":
				b.Track = nil
			}
			require.ErrorIs(t, b.Validate(t.Context(), daemonAccess), ErrWorkspaceUnavailable)
			code, err := b.Serve(newTestSession("id", ""), daemonAccess)
			require.Equal(t, 1, code)
			require.Error(t, err)
			require.Zero(t, f.opened)
		})
	}
}
func TestDaemonBridgeShellExecSFTP(t *testing.T) {
	for _, tc := range []struct {
		name, command, subsystem string
		kind                     machined.SessionKind
		argv                     []string
	}{
		{"shell", "", "", machined.SessionPTY, nil},
		{"exec", "printf '%s' '$HOME'", "", machined.SessionExec, []string{"/bin/sh", "-c", "printf '%s' '$HOME'"}},
		{"sftp", "", "sftp", machined.SessionSFTP, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &daemonFixture{received: make(chan []byte, 4)}
			f.received <- []byte{1, 1, 'o', 'k'}
			f.received <- []byte{1, 2, 'e'}
			f.received <- []byte{6, 0, 0, 0, 1}
			f.received <- []byte{5, 0, 0, 0, 0, 7}
			s := newTestSession(tc.command, "")
			s.subsystem = tc.subsystem
			code, err := daemonBridgeFixture(f).Serve(s, daemonAccess)
			require.NoError(t, err)
			require.Equal(t, 7, code)
			require.Equal(t, tc.kind, f.kind)
			require.Equal(t, tc.argv, f.argv)
			require.Equal(t, machined.SessionUser{Login: "alice", UID: 20001}, f.user)
			require.Equal(t, "ok", s.stdout.String())
			require.Equal(t, "e", s.stderr.String())
			require.Equal(t, 1, f.closed)
		})
	}
}
func TestDaemonBridgeQueuedRevocation(t *testing.T) {
	f := &daemonFixture{}
	b := daemonBridgeFixture(f)
	active := true
	b.Ready = func(context.Context, WorkspaceAccess) error {
		if !active {
			return ErrWorkspaceAccessDenied
		}
		return nil
	}
	b.Admit = func(context.Context, WorkspaceAccess, microsandbox.AdmissionRequest, io.Writer) (DaemonClient, func(), error) {
		active = false
		return f, func() {}, nil
	}
	_, err := b.Serve(newTestSession("id", ""), daemonAccess)
	require.ErrorIs(t, err, ErrWorkspaceAccessDenied)
	require.Zero(t, f.opened)
}
func TestDaemonBridgeSignalsLiteral(t *testing.T) {
	for _, tc := range []struct {
		signal gliderssh.Signal
		value  byte
	}{{gliderssh.SIGINT, 1}, {gliderssh.SIGTERM, 2}, {gliderssh.SIGHUP, 3}, {gliderssh.SIGKILL, 4}, {gliderssh.SIGQUIT, 5}, {gliderssh.SIGUSR1, 6}, {gliderssh.SIGUSR2, 7}} {
		require.Equal(t, tc.value, daemonSignal(tc.signal))
		require.Equal(t, tc.signal, daemonSignalName(tc.value))
	}
	require.Zero(t, daemonSignal("BAD"))
}
func TestDaemonTCPHalfCloseAndCredit(t *testing.T) {
	f := &daemonFixture{received: make(chan []byte, 3)}
	b := daemonBridgeFixture(f)
	conn, err := b.ConnectTCP(t.Context(), daemonAccess, 3000)
	require.NoError(t, err)
	defer conn.Close()
	require.Equal(t, uint16(3000), f.port)
	n, err := conn.Write([]byte("in"))
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.NoError(t, conn.CloseWrite())
	require.NoError(t, conn.CloseWrite())
	_, err = conn.Write([]byte("late"))
	require.ErrorIs(t, err, io.ErrClosedPipe)
	f.received <- []byte{1, 1, 'o', 'u', 't'}
	f.received <- []byte{2, 1}
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	bytes, err := io.ReadAll(conn)
	require.NoError(t, err)
	require.Equal(t, "out", string(bytes))
	require.NoError(t, conn.Close())
	require.NoError(t, conn.Close())
	require.Equal(t, 1, f.closed)
	f.mu.Lock()
	defer f.mu.Unlock()
	require.Equal(t, [][]byte{{1, 0, 'i', 'n'}, {2, 0}, {6, 0, 0, 0, 3}}, f.sent)
}

func TestDaemonBridgeGatewayExecSupplemental(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	f := &daemonFixture{received: make(chan []byte, 2)}
	f.received <- []byte{1, 1, 'o', 'k'}
	f.received <- []byte{5, 0, 0, 0, 0, 7}
	_, client := gatewayFixture(t, daemonBridgeFixture(f), func(s *Server, c *gossh.ClientConfig) {
		s.BranchLogins = true
		s.Queries = knownUserQuerier(gossh.FingerprintSHA256(signer.PublicKey()))
		s.BranchResolver = branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) { return daemonAccess, nil })
		c.User = "retry"
		c.Auth = []gossh.AuthMethod{gossh.PublicKeys(signer)}
	})
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	output, err := session.CombinedOutput("exit 7")
	var exit *gossh.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, 7, exit.ExitStatus())
	require.Equal(t, "ok", string(output))
	require.Equal(t, []string{"/bin/sh", "-c", "exit 7"}, f.argv)
}

func TestDaemonBridgeTrackingRefusesBeforeAdmission(t *testing.T) {
	f := &daemonFixture{}
	b := daemonBridgeFixture(f)
	b.Track = func(context.Context, WorkspaceAccess, uint32) (func(), error) { return nil, ErrWorkspaceUnavailable }
	b.Admit = func(context.Context, WorkspaceAccess, microsandbox.AdmissionRequest, io.Writer) (DaemonClient, func(), error) {
		t.Fatal("unavailable tracking must not admit")
		return nil, nil, nil
	}
	_, err := b.Serve(newTestSession("id", ""), daemonAccess)
	require.ErrorIs(t, err, ErrWorkspaceUnavailable)
	_, err = b.ConnectTCP(t.Context(), daemonAccess, 3000)
	require.ErrorIs(t, err, ErrWorkspaceUnavailable)
	require.Zero(t, f.opened)
}
func TestDaemonBridgeRejectsMalformedOutput(t *testing.T) {
	for _, payload := range [][]byte{nil, {1}, {1, 0}, {2}, {5, 2}, {5, 1, 0, 0}, {6}, {7}, {255}} {
		f := &daemonFixture{received: make(chan []byte, 1)}
		f.received <- payload
		code, err := daemonBridgeFixture(f).Serve(newTestSession("id", ""), daemonAccess)
		require.Error(t, err)
		require.Equal(t, 1, code)
	}
}

func TestDaemonBridgeGatewaySignalSupplemental(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	f := &daemonFixture{received: make(chan []byte, 1)}
	f.received <- []byte{5, 1, 2, 0}
	_, client := gatewayFixture(t, daemonBridgeFixture(f), func(s *Server, c *gossh.ClientConfig) {
		s.BranchLogins = true
		s.Queries = knownUserQuerier(gossh.FingerprintSHA256(signer.PublicKey()))
		s.BranchResolver = branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) { return daemonAccess, nil })
		c.User = "retry"
		c.Auth = []gossh.AuthMethod{gossh.PublicKeys(signer)}
	})
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	_, err = session.CombinedOutput("kill -TERM $$")
	var exit *gossh.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, "TERM", exit.Signal())
	require.Equal(t, 143, exit.ExitStatus())
}

func TestDaemonBridgeGatewayForwardSupplemental(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	f := &daemonFixture{received: make(chan []byte, 2)}
	f.received <- []byte{1, 1, 'r', 'e', 'p', 'l', 'y'}
	f.received <- []byte{2, 1}
	_, client := gatewayFixture(t, daemonBridgeFixture(f), func(s *Server, c *gossh.ClientConfig) {
		s.BranchLogins = true
		s.Queries = knownUserQuerier(gossh.FingerprintSHA256(signer.PublicKey()))
		s.BranchResolver = branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) { return daemonAccess, nil })
		c.User = "retry"
		c.Auth = []gossh.AuthMethod{gossh.PublicKeys(signer)}
	})
	conn, err := client.Dial("tcp", "localhost:3000")
	require.NoError(t, err)
	defer conn.Close()
	_, err = conn.Write([]byte("request"))
	require.NoError(t, err)
	require.NoError(t, conn.(interface{ CloseWrite() error }).CloseWrite())
	reply, err := io.ReadAll(conn)
	require.NoError(t, err)
	require.Equal(t, "reply", string(reply))
	require.Equal(t, uint16(3000), f.port)
}

func TestDaemonBridgePersonAdmissionLiteral(t *testing.T) {
	require.Equal(t, microsandbox.AdmissionRequest{Class: "person", Holder: "workspace:machine-1", Actor: "person:7", Reason: "ssh"}, daemonAdmission(daemonAccess))
}
