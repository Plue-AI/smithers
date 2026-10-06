package ssh

import (
	"context"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// These real gateway handshakes exercise channel policy. The loopback fixture
// below is supplemental mapping evidence, not a microVM acceptance receipt.
type tcpFixtureBridge struct {
	calls   atomic.Int32
	port    atomic.Uint32
	refused atomic.Bool
}

func (b *tcpFixtureBridge) Validate(context.Context, WorkspaceAccess) error {
	if b.refused.Load() {
		return ErrWorkspaceAccessDenied
	}
	return nil
}
func (*tcpFixtureBridge) Serve(s gliderssh.Session, _ WorkspaceAccess) (int, error) {
	_, err := io.WriteString(s, "session works\n")
	return 0, err
}
func (b *tcpFixtureBridge) ConnectTCP(_ context.Context, _ WorkspaceAccess, port uint16) (WorkspaceTCPConnection, error) {
	b.calls.Add(1)
	b.port.Store(uint32(port))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	go func() {
		defer listener.Close()
		c, err := listener.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		data, _ := io.ReadAll(c)
		_, _ = c.Write(append([]byte("reply:"), data...))
	}()
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		return nil, err
	}
	return conn.(*net.TCPConn), nil
}

func gatewayFixture(t *testing.T, bridge WorkspaceBridge) (*Server, *gossh.Client) {
	t.Helper()
	server := &Server{Addr: freePort(t), HostKeyDir: t.TempDir(), WorkspaceBridge: bridge}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	config := &gossh.ClientConfig{User: "msb_test+alice", Auth: []gossh.AuthMethod{gossh.Password(strings.Repeat("a", 32))}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second}
	var client *gossh.Client
	require.Eventually(t, func() bool { var err error; client, err = gossh.Dial("tcp", server.Addr, config); return err == nil }, 5*time.Second, 50*time.Millisecond)
	t.Cleanup(func() {
		_ = client.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, server.Shutdown(ctx))
		select {
		case <-done:
		case <-ctx.Done():
			t.Error("gateway did not stop")
		}
	})
	return server, client
}

func TestGatewayRefusesAgentAndX11Forwarding(t *testing.T) {
	_, client := gatewayFixture(t, &tcpFixtureBridge{})
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	for _, request := range []string{"auth-agent-req@openssh.com", "x11-req"} {
		accepted, err := session.SendRequest(request, true, nil)
		require.NoError(t, err)
		require.False(t, accepted)
	}
	for _, request := range []string{"tcpip-forward", "cancel-tcpip-forward"} {
		accepted, _, err := client.SendRequest(request, true, gossh.Marshal(struct {
			Host string
			Port uint32
		}{"127.0.0.1", 3000}))
		require.NoError(t, err)
		require.False(t, accepted)
	}
	output, err := session.Output("true")
	require.NoError(t, err)
	require.Equal(t, "session works\n", string(output))
}

func TestGatewayTCPPolicyAndHalfClose(t *testing.T) {
	bridge := &tcpFixtureBridge{}
	_, client := gatewayFixture(t, bridge)
	for _, tc := range []directTCPIPData{
		{Destination: "example.com", Port: 3000}, {Destination: "127.0.0.2", Port: 3000},
		{Destination: "127.0.0.1", Port: 0}, {Destination: "localhost", Port: 65536},
	} {
		_, _, err := client.OpenChannel("direct-tcpip", gossh.Marshal(tc))
		require.Error(t, err)
	}
	_, _, err := client.OpenChannel("direct-tcpip", []byte{0, 1})
	require.Error(t, err)
	require.Zero(t, bridge.calls.Load())
	for _, host := range []string{"localhost", "127.0.0.1", "::1"} {
		channel, requests, err := client.OpenChannel("direct-tcpip", gossh.Marshal(directTCPIPData{Destination: host, Port: 3000}))
		require.NoError(t, err)
		go gossh.DiscardRequests(requests)
		payload := strings.Repeat("x", 1024*1024)
		_, err = io.WriteString(channel, payload)
		require.NoError(t, err)
		require.NoError(t, channel.CloseWrite())
		output, err := io.ReadAll(channel)
		require.NoError(t, err)
		require.Equal(t, "reply:"+payload, string(output))
		_ = channel.Close()
	}
	require.Equal(t, int32(3), bridge.calls.Load())
	require.Equal(t, uint32(3000), bridge.port.Load())
	bridge.refused.Store(true)
	_, _, err = client.OpenChannel("direct-tcpip", gossh.Marshal(directTCPIPData{Destination: "localhost", Port: 3000}))
	require.Error(t, err)
	require.Equal(t, int32(3), bridge.calls.Load())
}

func TestGatewayTCPUnavailableFailsClosed(t *testing.T) {
	_, client := gatewayFixture(t, &recordingBridge{served: make(chan struct{})})
	_, _, err := client.OpenChannel("direct-tcpip", gossh.Marshal(directTCPIPData{Destination: "localhost", Port: 3000}))
	require.Error(t, err)
}

func TestForwardChannelRevocation(t *testing.T) {
	registry := &sessionRegistry{}
	one, peer := net.Pipe()
	defer peer.Close()
	other, otherPeer := net.Pipe()
	defer other.Close()
	defer otherPeer.Close()
	removeOne := registry.addChannel(one, revocation.Principal{UserID: 7})
	defer removeOne()
	removeOther := registry.addChannel(other, revocation.Principal{UserID: 8})
	defer removeOther()
	require.Equal(t, 2, registry.count())
	registry.handle(revocation.Event{Kind: revocation.KindUserDisabled, UserID: 7})
	_, err := peer.Write([]byte("x"))
	require.Error(t, err)
	require.Equal(t, 1, registry.count())
	registry.mu.Lock()
	require.Len(t, registry.channels, 1)
	registry.mu.Unlock()
}

func TestSSHKeyRevocationUsesAuthenticatedFingerprint(t *testing.T) {
	registry := &sessionRegistry{sessions: make(map[gliderssh.Session]revocation.Principal)}
	ctx := &fakeContext{values: map[any]any{
		principalKey:       sshPrincipal{UserID: 7, Fingerprint: "SHA256:key-one"},
		workspaceAccessKey: WorkspaceAccess{SandboxID: "vm-1", User: "alice"},
	}}
	session := &fakeSession{ctx: ctx}
	registry.add(session, sessionPrincipal(session))
	channel, peer := net.Pipe()
	defer peer.Close()
	remove := registry.addChannel(channel, contextPrincipal(ctx))
	defer remove()
	registry.handle(revocation.Event{Kind: revocation.KindSSHKeyRevoked, KeyFingerprint: "SHA256:other"})
	require.False(t, session.closed)
	registry.handle(revocation.Event{Kind: revocation.KindSSHKeyRevoked, KeyFingerprint: "SHA256:key-one"})
	require.True(t, session.closed)
	_, err := peer.Write([]byte("x"))
	require.Error(t, err)
}
