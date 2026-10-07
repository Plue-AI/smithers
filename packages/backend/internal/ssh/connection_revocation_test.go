package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

func connectionSigner(t *testing.T) gossh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	return signer
}

func TestSSHKeyRevocationDuringCredentialLookup(t *testing.T) {
	key := connectionSigner(t)
	fingerprint := gossh.FingerprintSHA256(key.PublicKey())
	lookupStarted, releaseLookup := make(chan struct{}), make(chan struct{})
	var started, release sync.Once
	defer release.Do(func() { close(releaseLookup) })
	queries := knownUserQuerier(fingerprint)
	lookup := queries.getUserBySSHFingerprintFn
	queries.getUserBySSHFingerprintFn = func(ctx context.Context, fingerprint string) (db.GetUserBySSHFingerprintRow, error) {
		// Capture the pre-removal answer, then hold its return across revocation.
		row, err := lookup(ctx, fingerprint)
		started.Do(func() { close(lookupStarted) })
		<-releaseLookup
		return row, err
	}
	server := &Server{Addr: freePort(t), HostKeyDir: t.TempDir(), Queries: queries}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, server.Shutdown(ctx))
		select {
		case <-stopped:
		case <-ctx.Done():
			t.Error("SSH server did not stop")
		}
	})
	require.Eventually(t, func() bool {
		conn, err := net.DialTimeout("tcp", server.Addr, time.Second)
		if conn != nil {
			_ = conn.Close()
		}
		return err == nil
	}, 5*time.Second, 10*time.Millisecond)
	answer := make(chan error, 1)
	go func() {
		client, err := gossh.Dial("tcp", server.Addr, &gossh.ClientConfig{User: "git", Auth: []gossh.AuthMethod{gossh.PublicKeys(key)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
		if client != nil {
			_ = client.Close()
		}
		answer <- err
	}()
	select {
	case <-lookupStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("credential lookup did not start")
	}
	liveSessions.handle(revocation.Event{Kind: revocation.KindSSHKeyRevoked, KeyFingerprint: fingerprint})
	release.Do(func() { close(releaseLookup) })
	select {
	case err := <-answer:
		require.Error(t, err, "revocation during lookup must prevent authentication from completing")
	case <-time.After(5 * time.Second):
		t.Fatal("revoked authentication did not finish")
	}
}

func TestSSHRevocationEndsAuthenticatedConnection(t *testing.T) {
	for _, state := range []string{"idle", "completed-session"} {
		t.Run(state, func(t *testing.T) {
			key, otherKey := connectionSigner(t), connectionSigner(t)
			fingerprint, otherFingerprint := gossh.FingerprintSHA256(key.PublicKey()), gossh.FingerprintSHA256(otherKey.PublicKey())
			server, client := gatewayFixture(t, &tcpFixtureBridge{}, func(server *Server, config *gossh.ClientConfig) {
				server.BranchLogins = true
				server.Queries = knownUserQuerier(fingerprint, otherFingerprint)
				server.BranchResolver = branchResolverFunc(func(context.Context, int64, string) (WorkspaceAccess, error) {
					return WorkspaceAccess{SandboxID: "revocation-machine", User: "alice"}, nil
				})
				config.User = "retry-webhooks"
				config.Auth = []gossh.AuthMethod{gossh.PublicKeys(key)}
			})
			other, err := gossh.Dial("tcp", server.Addr, &gossh.ClientConfig{User: "retry-webhooks", Auth: []gossh.AuthMethod{gossh.PublicKeys(otherKey)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			require.NoError(t, err)
			defer other.Close()
			if state == "completed-session" {
				session, err := client.NewSession()
				require.NoError(t, err)
				body, err := session.Output("true")
				require.NoError(t, err)
				require.Equal(t, "session works\n", string(body))
				_ = session.Close()
			}
			ended := make(chan error, 1)
			go func() { ended <- client.Wait() }()
			liveSessions.handle(revocation.Event{Kind: revocation.KindSSHKeyRevoked, KeyFingerprint: fingerprint})
			select {
			case <-ended:
			case <-time.After(5 * time.Second):
				t.Fatal("revoked key retained an authenticated connection")
			}
			_, err = client.NewSession()
			require.Error(t, err, "revoked connection must not open a replacement session")
			_, _, err = client.OpenChannel("direct-tcpip", gossh.Marshal(directTCPIPData{Destination: "localhost", Port: 3000}))
			require.Error(t, err, "revoked connection must not open a forwarding channel")
			// Revoking one key does not revoke another key of the same member.
			session, err := other.NewSession()
			require.NoError(t, err)
			defer session.Close()
			body, err := session.Output("true")
			require.NoError(t, err)
			require.Equal(t, "session works\n", string(body))
		})
	}
}
