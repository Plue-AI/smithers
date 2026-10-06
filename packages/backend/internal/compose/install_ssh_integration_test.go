package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// The same startup and listener pair used by the install, real database and
// real SSH handshakes. Missing W7 deliberately refuses all member execution.
func TestInstallSSHListeners(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "ssh-owner", LowerUsername: "ssh-owner"})
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = q.CreateSSHKey(t.Context(), db.CreateSSHKeyParams{UserID: user.ID, Name: "fixture", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	cfg := &config.Config{SSH: config.SSHConfig{Addr: "0.0.0.0:0", HostKeyDir: t.TempDir()}, Auth: config.AuthConfig{LFSSigningSecret: "test-lfs-secret"}}
	server, port, stop, err := startInstallSSH(t.Context(), cfg, pool, repository.NewRemoteClient(nil, "test"), nil, nil, "http://localhost:4000")
	require.NoError(t, err)
	defer stop()
	bytes, err := os.ReadFile(filepath.Join(cfg.SSH.HostKeyDir, "ssh_host_ed25519_key"))
	require.NoError(t, err)
	host, err := gossh.ParsePrivateKey(bytes)
	require.NoError(t, err)
	dial := func(address, login string) (*gossh.Client, error) {
		return gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.FixedHostKey(host.PublicKey()), Timeout: time.Second})
	}
	loopback := net.JoinHostPort("127.0.0.1", port)
	client, err := dial(loopback, "git")
	require.NoError(t, err)
	defer client.Close()
	refused, err := dial(loopback, "retry")
	if refused != nil {
		refused.Close()
	}
	require.Error(t, err, "missing machine bridge refuses branch execution")
	// An explicit bind, never cfg.SSH.Addr's wildcard, adds the network door.
	httpServer := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })}
	defer httpServer.Close()
	network := &networkListener{serve: httpServer.Serve, listen: net.Listen, sshServe: server.Serve, sshPort: port}
	defer network.Listen("")
	bindHost := ""
	addresses, e := net.InterfaceAddrs()
	require.NoError(t, e)
	for _, address := range addresses {
		if ip, ok := address.(*net.IPNet); ok && ip.IP.To4() != nil && !ip.IP.IsLoopback() && !ip.IP.IsLinkLocalUnicast() {
			bindHost = ip.IP.String()
			break
		}
	}
	require.NotEmpty(t, bindHost, "reference host needs a network interface")
	require.NoError(t, network.Listen(net.JoinHostPort(bindHost, "0")))
	networkSSH := net.JoinHostPort(bindHost, port)
	remote, err := dial(networkSSH, "git")
	require.NoError(t, err)
	defer remote.Close()
	// Changing just HTTP's port reuses SSH's listener rather than colliding.
	require.NoError(t, network.Listen(net.JoinHostPort(bindHost, "0")))
	again, err := dial(networkSSH, "git")
	require.NoError(t, err)
	again.Close()
	oldHTTP := network.ln.Addr().String()
	// Occupying the prospective SSH port makes the whole change fail; neither
	// old listener closes and the newly opened HTTP listener is rolled back.
	occupied, err := net.Listen("tcp", net.JoinHostPort("::1", port))
	require.NoError(t, err)
	defer occupied.Close()
	require.Error(t, network.Listen("[::1]:0"))
	require.Equal(t, oldHTTP, network.ln.Addr().String())
	again, err = dial(networkSSH, "git")
	require.NoError(t, err)
	again.Close()
	require.NoError(t, network.Listen(""))
	_, err = net.DialTimeout("tcp", networkSSH, 100*time.Millisecond)
	require.Error(t, err)
	again, err = dial(loopback, "git")
	require.NoError(t, err)
	again.Close()
	// Existing sessions survive closing their listener and still reach the
	// canonical repository authorization, which refuses this absent repository.
	session, err := remote.NewSession()
	require.NoError(t, err)
	defer session.Close()
	_, err = session.CombinedOutput("git-upload-pack 'other/private.git'")
	require.Error(t, err)
	// One shutdown closes every server listener; close clients before draining.
	remote.Close()
	client.Close()
	shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	require.NoError(t, server.Shutdown(shutdown))
}
