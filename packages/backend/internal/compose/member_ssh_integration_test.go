package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	transport "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// Test-only dependency contract: this bridge holds a real public SSH channel,
// but executes nothing. This is key authentication/closure evidence, never
// proof of guest child termination or qualification of the install gateway.
type memberSSHFixture struct {
	pool      *pgxpool.Pool
	user      int64
	ready     chan struct{}
	forwarded atomic.Int32
}

func (f *memberSSHFixture) ResolveBranch(ctx context.Context, user int64, branch string) (transport.WorkspaceAccess, error) {
	if user != f.user || branch != "retry-webhooks" {
		return transport.WorkspaceAccess{}, transport.ErrWorkspaceAccessDenied
	}
	var login string
	err := f.pool.QueryRow(ctx, `SELECT c.unix_login FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1 AND c.suspended_at IS NULL AND NOT u.prohibit_login`, user).Scan(&login)
	if err != nil {
		return transport.WorkspaceAccess{}, transport.ErrWorkspaceAccessDenied
	}
	return transport.WorkspaceAccess{SandboxID: "fixture-machine", User: login}, nil
}
func (*memberSSHFixture) Validate(context.Context, transport.WorkspaceAccess) error { return nil }
func (f *memberSSHFixture) ConnectTCP(context.Context, transport.WorkspaceAccess, uint16) (transport.WorkspaceTCPConnection, error) {
	f.forwarded.Add(1)
	return nil, fmt.Errorf("fixture has no guest loopback transport")
}

func (f *memberSSHFixture) Serve(session gliderssh.Session, _ transport.WorkspaceAccess) (int, error) {
	f.ready <- struct{}{}
	<-session.Context().Done()
	return 1, nil
}

func exerciseImportedSSHKeys(t *testing.T, pool *pgxpool.Pool, members *services.Members, github *rosterGitHub, writer db.User, bus *revocation.Bus, request func(string, string, string, string) (int, string), createSession func(db.User, string)) {
	t.Helper()
	fixture := &memberSSHFixture{pool: pool, user: writer.ID, ready: make(chan struct{}, 1)}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	keyDir := t.TempDir()
	server := &transport.Server{Queries: db.New(pool), Addr: addr, HostKeyDir: keyDir, BranchLogins: true, BranchResolver: fixture, WorkspaceBridge: fixture}
	transport.SetRevocationSource(bus)
	defer transport.SetRevocationSource(nil)
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, server.Shutdown(ctx))
		select {
		case <-stopped:
		case <-ctx.Done():
			t.Error("SSH fixture did not stop")
		}
	}()
	var host gossh.Signer
	require.Eventually(t, func() bool {
		bytes, err := os.ReadFile(filepath.Join(keyDir, "ssh_host_ed25519_key"))
		if err != nil {
			return false
		}
		host, err = gossh.ParsePrivateKey(bytes)
		if err != nil {
			return false
		}
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}, 5*time.Second, 10*time.Millisecond)
	createSession(writer, "ssh-keys-cookie")
	maxElapsed := time.Duration(0)
	for run := 1; run <= 20; run++ {
		_, private, err := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, err)
		signer, err := gossh.NewSignerFromKey(private)
		require.NoError(t, err)
		key := strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey())))
		github.mu.Lock()
		github.keys["writer"] = []string{key}
		github.keyETag = fmt.Sprintf(`"ssh-open-%d"`, run)
		github.mu.Unlock()
		require.NoError(t, members.Recheck(t.Context()))
		status, body := request("GET", "/api/user/keys", "", "ssh-keys-cookie")
		require.Equal(t, 200, status, body)
		require.Contains(t, body, gossh.FingerprintSHA256(signer.PublicKey()))
		cfg := &gossh.ClientConfig{User: "retry-webhooks", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.FixedHostKey(host.PublicKey()), Timeout: 2 * time.Second}
		client, err := gossh.Dial("tcp", addr, cfg)
		require.NoError(t, err, "GitHub-imported key must authenticate on the production gateway")
		defer client.Close()
		session, err := client.NewSession()
		require.NoError(t, err)
		require.NoError(t, session.Shell())
		select {
		case <-fixture.ready:
		case <-time.After(5 * time.Second):
			t.Fatal("SSH session never reached bridge")
		}
		closed := make(chan error, 1)
		go func() { closed <- session.Wait() }()
		github.mu.Lock()
		github.keys["writer"] = nil
		github.keyETag = fmt.Sprintf(`"ssh-revoked-%d"`, run)
		github.mu.Unlock()
		started := time.Now()
		require.NoError(t, members.Recheck(t.Context()))
		select {
		case err := <-closed:
			require.Error(t, err, "revoked session cannot report successful completion")
		case <-time.After(time.Until(started.Add(5 * time.Second))):
			session.Close()
			client.Close()
			t.Fatal("GitHub key removal did not close SSH within five seconds")
		}
		elapsed := time.Since(started)
		require.LessOrEqual(t, elapsed, 5*time.Second)
		if elapsed > maxElapsed {
			maxElapsed = elapsed
		}
		session.Close()
		// SSH auth is connection-wide. Reusing the connection must refuse
		// every new channel before the fake guest bridge sees it.
		reused, err := client.NewSession()
		if err == nil {
			reusedDone := make(chan error, 1)
			go func() { reusedDone <- reused.Run("echo revoked") }()
			select {
			case err := <-reusedDone:
				require.Error(t, err)
			case <-fixture.ready:
				reused.Close()
				client.Close()
				t.Fatal("revoked key opened another session on its existing connection")
			case <-time.After(2 * time.Second):
				reused.Close()
				client.Close()
				t.Fatal("revoked channel did not finish")
			}
			reused.Close()
		}
		forwarded, err := client.Dial("tcp", "localhost:3000")
		if forwarded != nil {
			forwarded.Close()
		}
		require.Error(t, err)
		require.Zero(t, fixture.forwarded.Load(), "revoked forwarding never reaches the guest bridge")
		client.Close()
		fresh, err := gossh.Dial("tcp", addr, cfg)
		if fresh != nil {
			fresh.Close()
		}
		require.Error(t, err, "removed GitHub key cannot authenticate again")
		status, body = request("GET", "/api/user/keys", "", "ssh-keys-cookie")
		require.Equal(t, 200, status, body)
		require.NotContains(t, body, gossh.FingerprintSHA256(signer.PublicKey()))
		t.Logf("run=%d transport=ssh recheck_to_close_seconds=%.6f", run, elapsed.Seconds())
	}
	t.Logf("SSH max over 20 runs: %.6f seconds; fake guest bridge, durable bus without LISTEN", maxElapsed.Seconds())
}
