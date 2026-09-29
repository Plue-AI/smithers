package routes

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// testHostKey wraps a freshly-generated ed25519 signer plus the
// advertised wire shape the API would publish for it. Using a real key
// (not a stub) ensures the callback we ship actually handles real
// crypto/ssh PublicKey objects.
type testHostKey struct {
	signer    gossh.Signer
	advertise services.WorkspaceSSHHostKey
}

type testSSHServerStats struct {
	shellStarts atomic.Int32
	ptyRequests atomic.Int32
}

func newTestHostKey(t *testing.T) testHostKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(priv)
	require.NoError(t, err)
	pub := signer.PublicKey()
	return testHostKey{
		signer: signer,
		advertise: services.WorkspaceSSHHostKey{
			Algorithm:         pub.Type(),
			PublicKey:         base64.StdEncoding.EncodeToString(pub.Marshal()),
			FingerprintSHA256: gossh.FingerprintSHA256(pub),
		},
	}
}

// startTestSSHServer launches an in-process gliderlabs SSH server bound
// to a random localhost port. It presents the provided signer as its
// host key and accepts any password so the test can drive host-key
// checks without fighting auth.
func startTestSSHServer(t *testing.T, signer gossh.Signer) (host string, port int, stats *testSSHServerStats) {
	t.Helper()

	stats = &testSSHServerStats{}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = ln.Close() })

	srv := &gliderssh.Server{
		Handler: func(s gliderssh.Session) {
			stats.shellStarts.Add(1)
			// Emit deterministic output so shell-start tests can assert
			// the interactive path actually began after host-key verify.
			_, _ = s.Write([]byte("ok\n"))
		},
		PtyCallback: func(ctx gliderssh.Context, pty gliderssh.Pty) bool {
			stats.ptyRequests.Add(1)
			return true
		},
		PasswordHandler: func(ctx gliderssh.Context, password string) bool { return true },
	}
	srv.AddHostKey(signer)

	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	host, portStr, err := net.SplitHostPort(ln.Addr().String())
	require.NoError(t, err)
	p, err := strconv.Atoi(portStr)
	require.NoError(t, err)
	return host, p, stats
}

// Advertised key matches the server's key -> dial succeeds. This proves
// the happy path for the pinned-callback.
func TestDialSSH_CorrectHostKey_DialSucceeds(t *testing.T) {
	t.Parallel()

	hk := newTestHostKey(t)
	host, port, stats := startTestSSHServer(t, hk.signer)

	h := &WorkspaceTerminalHandler{}
	info := services.WorkspaceSSHConnectionInfo{
		VMID:        "vm-test",
		Host:        host,
		Port:        port,
		Username:    "root",
		AccessToken: "any-token",
		HostKeys:    []services.WorkspaceSSHHostKey{hk.advertise},
	}

	client, session, err := h.dialSSH(context.Background(), info, 80, 24)
	require.NoError(t, err, "dial must succeed when advertised key matches server")
	require.NotNil(t, client)
	require.NotNil(t, session)

	stdout, err := session.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, session.Shell(), "successful host-key verification must let shell startup proceed")
	buf := make([]byte, 3) // "ok\n"
	_, err = io.ReadFull(stdout, buf)
	require.NoError(t, err)
	assert.Equal(t, "ok\n", string(buf))
	require.NoError(t, session.Wait())
	assert.Equal(t, int32(1), stats.shellStarts.Load(), "shell handler should run exactly once on happy path")

	_ = session.Close()
	_ = client.Close()
}

func TestDialSSH_CancellationInterruptsStalledHandshake(t *testing.T) {
	key := newTestHostKey(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	host, portText, err := net.SplitHostPort(listener.Addr().String())
	require.NoError(t, err)
	port, err := strconv.Atoi(portText)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		client, session, dialErr := (&WorkspaceTerminalHandler{}).dialSSH(ctx, services.WorkspaceSSHConnectionInfo{
			VMID: "vm", Host: host, Port: port, Username: "developer", AccessToken: "token",
			HostKeys: []services.WorkspaceSSHHostKey{key.advertise},
		}, 80, 24)
		if session != nil {
			_ = session.Close()
		}
		if client != nil {
			_ = client.Close()
		}
		result <- dialErr
	}()
	var serverConn net.Conn
	select {
	case serverConn = <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("TCP connection did not reach the stalled SSH handshake")
	}
	defer serverConn.Close()
	cancel()
	select {
	case err := <-result:
		require.Error(t, err, "canceled handshake must not return an SSH client")
	case <-time.After(2 * time.Second):
		t.Fatal("context cancellation did not interrupt the SSH handshake")
	}
	_ = serverConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = io.Copy(io.Discard, serverConn)
	require.NoError(t, err, "the canceled client must close its TCP connection")
}

func TestDialSSH_UsesInternalDialHostWhenProvided(t *testing.T) {
	t.Parallel()

	hk := newTestHostKey(t)
	host, port, stats := startTestSSHServer(t, hk.signer)

	h := &WorkspaceTerminalHandler{}
	info := services.WorkspaceSSHConnectionInfo{
		VMID:        "vm-test",
		Host:        "ssh.jjhub.tech",
		DialHost:    host,
		Port:        port,
		Username:    "root",
		AccessToken: "any-token",
		HostKeys:    []services.WorkspaceSSHHostKey{hk.advertise},
	}

	client, session, err := h.dialSSH(context.Background(), info, 80, 24)
	require.NoError(t, err, "dial must use DialHost while public Host remains user-facing")
	require.NotNil(t, client)
	require.NotNil(t, session)
	stdout, err := session.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, session.Shell())
	buf := make([]byte, 3) // "ok\n"
	_, err = io.ReadFull(stdout, buf)
	require.NoError(t, err)
	assert.Equal(t, "ok\n", string(buf))
	require.NoError(t, session.Wait())
	assert.Equal(t, int32(1), stats.shellStarts.Load())

	_ = session.Close()
	_ = client.Close()
}

// Advertised key differs from server's key -> dial fails and the error
// identifies the presented fingerprint. Critically this must fail
// *before* a shell is started, so we also assert the error text
// references host-key mismatch, not a downstream PTY/shell code.
func TestDialSSH_MismatchedHostKey_DialRejectedBeforePTY(t *testing.T) {
	t.Parallel()

	serverKey := newTestHostKey(t)
	pinnedKey := newTestHostKey(t) // different key advertised to the client

	host, port, stats := startTestSSHServer(t, serverKey.signer)

	h := &WorkspaceTerminalHandler{}
	info := services.WorkspaceSSHConnectionInfo{
		VMID:        "vm-test",
		Host:        host,
		Port:        port,
		Username:    "root",
		AccessToken: "any-token",
		HostKeys:    []services.WorkspaceSSHHostKey{pinnedKey.advertise},
	}

	client, session, err := h.dialSSH(context.Background(), info, 80, 24)
	require.Error(t, err, "dial must fail when presented key is not in advertised set")
	assert.Nil(t, client)
	assert.Nil(t, session)
	// Error must mention host-key mismatch so operators can triage.
	assert.Contains(t, err.Error(), "host key", "error must name the root cause as host-key mismatch")
	// And must carry the presented fingerprint for diagnostics.
	assert.Contains(t, err.Error(), gossh.FingerprintSHA256(serverKey.signer.PublicKey()),
		"error must include the presented (wrong) fingerprint so ops can correlate")
	assert.Contains(t, err.Error(), gossh.FingerprintSHA256(pinnedKey.signer.PublicKey()),
		"error should include expected pinned fingerprint(s) to make mismatch triage actionable")
	assert.Zero(t, stats.ptyRequests.Load(), "mismatch must fail before PTY allocation")
	assert.Zero(t, stats.shellStarts.Load(), "mismatch must fail before shell handler runs")
}

// Rotation: advertise two keys, only one matches the server. Clients
// must accept *either* key because rotation requires overlap.
func TestDialSSH_RotationOverlap_EitherAdvertisedKeyWorks(t *testing.T) {
	t.Parallel()

	oldKey := newTestHostKey(t)
	newKey := newTestHostKey(t)

	cases := []struct {
		name         string
		serverSigner gossh.Signer
	}{
		{name: "server uses old key", serverSigner: oldKey.signer},
		{name: "server uses new key", serverSigner: newKey.signer},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			host, port, _ := startTestSSHServer(t, tc.serverSigner)

			h := &WorkspaceTerminalHandler{}
			info := services.WorkspaceSSHConnectionInfo{
				VMID:        "vm-test",
				Host:        host,
				Port:        port,
				Username:    "root",
				AccessToken: "any-token",
				HostKeys: []services.WorkspaceSSHHostKey{
					oldKey.advertise,
					newKey.advertise,
				},
			}

			client, session, err := h.dialSSH(context.Background(), info, 80, 24)
			require.NoError(t, err, "either advertised key must satisfy the pinned callback during rotation")
			_ = session.Close()
			_ = client.Close()
		})
	}
}

// No advertised host keys -> refuse to dial. This prevents regressions
// that would reintroduce insecure host-key acceptance.
func TestDialSSH_NoAdvertisedHostKeys_FailsClosed(t *testing.T) {
	t.Parallel()

	h := &WorkspaceTerminalHandler{}
	info := services.WorkspaceSSHConnectionInfo{
		VMID:        "vm-test",
		Host:        "127.0.0.1",
		Port:        1, // unreachable — we never expect to get this far
		Username:    "root",
		AccessToken: "any-token",
		HostKeys:    nil,
	}

	start := time.Now()
	_, _, err := h.dialSSH(context.Background(), info, 80, 24)
	require.Error(t, err)
	assert.ErrorIs(t, err, errNoAdvertisedHostKeys, "empty pin set must short-circuit before any dial")
	// Short-circuit sanity: we must not have attempted a real TCP dial
	// (which would take much longer against an unreachable port).
	assert.Less(t, time.Since(start), 2*time.Second, "must fail before tcp dial, not time out")
}

// A malformed advertised key is a hard error, not silent downgrade.
func TestDialSSH_MalformedAdvertisedKey_FailsClosed(t *testing.T) {
	t.Parallel()

	h := &WorkspaceTerminalHandler{}
	info := services.WorkspaceSSHConnectionInfo{
		VMID: "vm-test", Host: "127.0.0.1", Port: 1, Username: "root", AccessToken: "t",
		HostKeys: []services.WorkspaceSSHHostKey{{
			Algorithm: "ssh-ed25519",
			PublicKey: "not-base64-***",
		}},
	}
	_, _, err := h.dialSSH(context.Background(), info, 80, 24)
	require.Error(t, err)
	assert.True(t,
		strings.Contains(err.Error(), "decode public_key") ||
			strings.Contains(err.Error(), "parse public_key"),
		"malformed key must produce an explicit parse/decode error, got: %v", err,
	)
}

// Hostname binding is strict: callback is built for info.Host:info.Port
// and rejects any other callback hostname, even with the same key.
func TestBuildPinnedHostKeyCallback_HostnameMismatch_FailsClosed(t *testing.T) {
	t.Parallel()

	hk := newTestHostKey(t)
	cb, err := buildPinnedHostKeyCallback("expected.host", 22, []services.WorkspaceSSHHostKey{hk.advertise})
	require.NoError(t, err)

	err = cb("other.host:22", &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}, hk.signer.PublicKey())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "hostname mismatch")
}
