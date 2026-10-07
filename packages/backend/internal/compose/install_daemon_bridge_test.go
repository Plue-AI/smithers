package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	internalssh "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
	"net"
	"testing"
	"time"
)

// Real SSH and PostgreSQL exercise the composed reservation/queue boundary.
// The unresolved guest provider is a sentinel; no member process is launched.
func TestInstallSSHReservesBeforeUnresolvedWakeSupplemental(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	ctx := t.Context()
	machine, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, f.row.ID, machine)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='failed' WHERE workspace_id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: f.user.ID, Name: "supplemental", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	runtime := &requestHTTPRuntime{entered: make(chan struct{}), release: make(chan struct{})}
	service := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)))
	defer func() {
		close(runtime.release)
		wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		require.NoError(t, service.WaitForProvisioning(wait))
	}()
	bridge := installDaemonBridge(f.pool, service, runtime.MachinedRegistry())
	require.NotNil(t, bridge)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	server := &internalssh.Server{Queries: q, Authorizer: services.NewSSHAuthorizationService(q), HostKeyDir: t.TempDir(), WorkspaceBridge: bridge, BranchLogins: true, BranchResolver: &internalssh.InstallBranchResolver{Database: f.pool}, InstallMainMirror: true}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(stop)
		<-done
	}()
	client, err := gossh.Dial("tcp", listener.Addr().String(), &gossh.ClientConfig{User: "presence", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
	require.NoError(t, err)
	defer client.Close()
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	require.NoError(t, session.Start("id"))
	select {
	case <-runtime.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("SSH channel did not launch its durable reservation")
	}
	var id, status, via string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT id,status,ssh_connection_info->>'via' FROM workspace_sessions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`, f.row.ID).Scan(&id, &status, &via))
	require.Equal(t, "pending", status)
	require.Equal(t, "ssh", via)
	require.NoError(t, client.Close())
	require.Eventually(t, func() bool { row, err := q.GetWorkspaceSession(ctx, id); return err == nil && row.Status == "stopped" }, 5*time.Second, 20*time.Millisecond, "disconnected SSH must close its pending reservation")
}
