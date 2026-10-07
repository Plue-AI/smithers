package ssh_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"testing"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	transport "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/smithersai/smithers/packages/backend/repository"
	productssh "github.com/smithersai/smithers/packages/backend/ssh"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// Only the not-yet-available W7 machine is a fake. Keys, roster, branch/grant
// resolution, SSH handshakes and per-channel reauthorization are production.
// This is not a real-machine C-J3-06 acceptance receipt.
type rosterBridge struct{}

func (rosterBridge) Validate(_ context.Context, a productssh.WorkspaceAccess) error {
	if a.User != "alice" || a.UID != 20041 || a.MemberID == 0 || a.Token != "" {
		return productssh.ErrWorkspaceAccessDenied
	}
	return nil
}
func (rosterBridge) Serve(s gliderssh.Session, a productssh.WorkspaceAccess) (int, error) {
	_, err := fmt.Fprintf(s, "%s:%d", a.User, a.UID)
	return 0, err
}

func TestInstallSSHBranchRosterBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d}`, repo.ID))}))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20041)`, repo.ID, alice.ID)
	require.NoError(t, err)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	machine, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "retry", TargetBookmark: "scratch/alice/retry", Kind: "vm", Status: "stopped", EnvironmentSource: "repository"})
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: machine.ID, OwnerUserID: machineOwner, GranteeUserID: alice.ID, Level: "write"})
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: alice.ID, Name: "alice", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	a, resolveErr := (&transport.InstallBranchResolver{Database: pool}).ResolveBranch(ctx, alice.ID, "retry")
	require.NoError(t, resolveErr)
	require.Equal(t, "alice", a.User)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	server, err := productssh.New(ctx, productssh.Config{Database: pool, Repository: repository.NewRemoteClient(nil, "test"), Admission: policy, Addr: addr, HostKeyDir: t.TempDir(), LFSSigningSecret: "test-lfs-secret", PublicAPIOrigin: "http://localhost:4000", BranchLogins: true, WorkspaceBridge: rosterBridge{}})
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, server.Shutdown(c))
		<-done
	}()
	dial := func(login string) (*gossh.Client, error) {
		return gossh.Dial("tcp", addr, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
	}
	var client *gossh.Client
	require.Eventually(t, func() bool { client, err = dial("retry"); return err == nil }, 5*time.Second, 20*time.Millisecond)
	defer client.Close()
	session, err := client.NewSession()
	require.NoError(t, err)
	output, err := session.Output("id")
	require.NoError(t, err)
	require.Equal(t, "alice:20041", string(output))
	session.Close()
	for _, login := range []string{"main", "root", "machine+alice", "scratch/bob/retry"} {
		c, e := dial(login)
		if c != nil {
			c.Close()
		}
		require.Error(t, e, login)
	}
	// Every mutation happens after the successful handshake. A retained SSH
	// connection must not outlive membership, identity or its branch grant.
	for _, tc := range []struct{ name, change, undo string }{
		{"suspended", `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`},
		{"login disabled", `UPDATE users SET prohibit_login=true WHERE id=$1`, `UPDATE users SET prohibit_login=false WHERE id=$1`},
		{"read only", `UPDATE workspace_shares SET level='read' WHERE grantee_user_id=$1`, `UPDATE workspace_shares SET level='write' WHERE grantee_user_id=$1`},
		{"inactive", `UPDATE users SET is_active=false WHERE id=$1`, `UPDATE users SET is_active=true WHERE id=$1`},
		{"no identity", `UPDATE collaborators SET unix_login=NULL WHERE user_id=$1`, `UPDATE collaborators SET unix_login='alice' WHERE user_id=$1`},
		{"deleted branch", `UPDATE workspaces SET deleted_at=now() WHERE id IN (SELECT workspace_id FROM workspace_shares WHERE grantee_user_id=$1)`, `UPDATE workspaces SET deleted_at=NULL WHERE id IN (SELECT workspace_id FROM workspace_shares WHERE grantee_user_id=$1)`},
		{"identity changed", `UPDATE collaborators SET unix_uid=20042 WHERE user_id=$1`, `UPDATE collaborators SET unix_uid=20041 WHERE user_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The previous case restored authority, but its asynchronous
			// revocation can still close a newly accepted connection. Establish
			// a working positive control before this case removes authority.
			var retained *gossh.Client
			require.Eventually(t, func() bool {
				candidate, err := dial("retry")
				if err != nil {
					return false
				}
				probe, err := candidate.NewSession()
				if err == nil {
					var output []byte
					output, err = probe.Output("id")
					probe.Close()
					if err == nil && string(output) == "alice:20041" {
						retained = candidate
						return true
					}
				}
				candidate.Close()
				return false
			}, 5*time.Second, 20*time.Millisecond)
			defer retained.Close()
			_, e := pool.Exec(ctx, tc.change, alice.ID)
			require.NoError(t, e)
			s, e := retained.NewSession()
			if e == nil {
				defer s.Close()
				_, e = s.Output("id")
			}
			require.Error(t, e)
			c, e := dial("retry")
			if c != nil {
				c.Close()
			}
			require.Error(t, e)
			_, e = pool.Exec(ctx, tc.undo, alice.ID)
			require.NoError(t, e)
		})
	}
	// Still asleep: identity resolution and authentication have no wake side effect.
	row, err := q.GetWorkspace(ctx, machine.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", row.Status)
}
