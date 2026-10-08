package compose

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	internalssh "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

// Executable Linux refusal subset of C-J3-06. No bridge accepts a session and
// no host payload runs. The native positive control belongs to the two tests
// below; a passing subset is not reference-host acceptance.
func TestSSHUnavailableProvidersFailClosed(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ssh-owner", LowerUsername: "ssh-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "ssh-proof", LowerName: "ssh-proof", DefaultBookmark: "main"})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"ssh-owner","repository_name":"ssh-proof","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"ssh-owner","repository_name":"ssh-proof","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))}))
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	machine, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, Name: "retry-webhooks", TargetBookmark: "scratch/ssh-owner/retry-webhooks", Kind: "vm", Status: "stopped", EnvironmentSource: "repository"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','ssh-owner',20001)`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: owner.ID, Name: "fixture", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	cfg := &config.Config{SSH: config.SSHConfig{Addr: "127.0.0.1:0", HostKeyDir: t.TempDir()}, Auth: config.AuthConfig{LFSSigningSecret: "test-lfs-secret"}}
	_, port, stop, err := startInstallSSH(ctx, cfg, pool, repository.NewRemoteClient(nil, "test"), nil, nil, "http://localhost:4000")
	require.NoError(t, err)
	defer stop()
	for _, login := range []string{"retry-webhooks", "smithers/retry-webhooks", "root", "machine+ssh-owner"} {
		t.Run(login, func(t *testing.T) {
			c, e := gossh.Dial("tcp", net.JoinHostPort("127.0.0.1", port), &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			if c != nil {
				c.Close()
			}
			require.Error(t, e)
		})
	}
	// Omit each required production bridge capability independently. These are
	// actual install adapters; no recording bridge can supply acceptance.
	// C-MCH-11: refusals enter the production SSH gateway with a real
	// admission runtime composed. Inject only VM inventory/boot observations;
	// a missing door must not create demand, a durable transition or a VM.
	binary := filepath.Join(t.TempDir(), "msb")
	bootLog := filepath.Join(t.TempDir(), "unexpected-boot")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = list ]; then echo '[]'; else echo \"$*\" >> %q; exit 99; fi\n", bootLog)), 0700))
	profile := microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}
	runtime, err := microsandbox.New(ctx, microsandbox.Config{Root: t.TempDir(), Binary: binary, HostProfile: &profile,
		SkipQualification: true, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768, MaxRunningVMs: 3})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	service := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithWorkspaceRuntime(runtime),
		services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)))
	service.EnableMachineAdmission(func(context.Context) (int64, error) { return 140 << 30, nil })
	assertNoAdmission := func(t *testing.T) {
		t.Helper()
		require.Empty(t, runtime.AdmissionSnapshot())
		require.Zero(t, runtime.InUse())
		require.NoFileExists(t, bootLog)
		stored, err := q.GetWorkspace(ctx, machine.ID)
		require.NoError(t, err)
		require.Equal(t, "stopped", stored.Status)
		var sessions int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1`, machine.ID).Scan(&sessions))
		require.Zero(t, sessions)
	}
	assertNoAdmission(t)
	for _, missing := range []string{"authorization", "admission", "session tracking", "authenticated daemon transport", "transaction boundary"} {
		t.Run(missing, func(t *testing.T) {
			bridge := installDaemonBridge(pool, service, &machined.Registry{})
			switch missing {
			case "authorization":
				bridge.Ready = nil
			case "admission":
				bridge.Admit = nil
			case "session tracking":
				bridge.Track = nil
			case "authenticated daemon transport":
				bridge = installDaemonBridge(pool, service, nil)
			case "transaction boundary":
				bridge = installDaemonBridge(pool, services.NewWorkspaceService(q), &machined.Registry{})
			}
			_, p, close, e := startInstallSSH(ctx, cfg, pool, repository.NewRemoteClient(nil, "test"), nil, bridge, "http://localhost:4000")
			require.NoError(t, e)
			defer close()
			c, e := gossh.Dial("tcp", net.JoinHostPort("127.0.0.1", p), &gossh.ClientConfig{User: "retry-webhooks", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			if c != nil {
				c.Close()
			}
			require.Error(t, e)
			assertNoAdmission(t)
		})
	}
	resolver := &internalssh.InstallBranchResolver{Database: pool}
	resolved, err := resolver.ResolveBranch(ctx, owner.ID, "retry-webhooks")
	require.NoError(t, err)
	require.Equal(t, machine.ID, resolved.SandboxID)
	require.Equal(t, uint32(20001), resolved.UID)
	for _, fixture := range []struct{ name, change, undo string }{
		{"missing identity", `UPDATE collaborators SET unix_login=NULL WHERE user_id=$1`, `UPDATE collaborators SET unix_login='ssh-owner' WHERE user_id=$1`},
		{"suspended roster", `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`},
		{"root identity", `UPDATE collaborators SET unix_uid=1 WHERE user_id=$1`, `UPDATE collaborators SET unix_uid=20001 WHERE user_id=$1`},
		{"withdrawn authorization", `UPDATE collaborators SET permission='read' WHERE user_id=$1`, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			_, e := pool.Exec(ctx, fixture.change, owner.ID)
			require.NoError(t, e)
			defer func() { _, e := pool.Exec(ctx, fixture.undo, owner.ID); require.NoError(t, e) }()
			_, e = resolver.ResolveBranch(ctx, owner.ID, "retry-webhooks")
			require.Error(t, e)
			bridge := installDaemonBridge(pool, service, &machined.Registry{})
			_, p, close, e := startInstallSSH(ctx, cfg, pool, repository.NewRemoteClient(nil, "test"), nil, bridge, "http://localhost:4000")
			require.NoError(t, e)
			defer close()
			c, e := gossh.Dial("tcp", net.JoinHostPort("127.0.0.1", p), &gossh.ClientConfig{User: "retry-webhooks", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			if c != nil {
				c.Close()
			}
			require.Error(t, e)

		})
	}
	row, err := q.GetWorkspace(ctx, machine.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", row.Status)
	var sessions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1`, machine.ID).Scan(&sessions))
	require.Zero(t, sessions, "refusal precedes reservation and wake")
}

func TestSSHProductionAuthorizationAndForwarding(t *testing.T) {
	exerciseInstalledMemberTerminalAndSSHChain(t, func(h *rootLayerHarness, client *gossh.Client, address, login string, signer gossh.Signer, member int64, uid uint32) {
		command := func(text string) ([]byte, error) {
			s, e := client.NewSession()
			if e != nil {
				return nil, e
			}
			defer s.Close()
			return s.CombinedOutput(text)
		}
		require.Equal(t, uint32(20000), uid, "fresh fixture's first roster member has the reviewed UID")
		identity, e := command("id -un; pwd; if pgrep -x sshd; then exit 1; fi")
		require.NoError(t, e)
		require.Equal(t, "rehearsal-owner\n/workspace\n", string(identity))
		output, err := command("exit 7")
		var status *gossh.ExitError
		require.ErrorAs(t, err, &status, string(output))
		require.Equal(t, 7, status.ExitStatus())
		_, err = command("kill -TERM $$")
		require.ErrorAs(t, err, &status)
		require.Equal(t, "TERM", status.Signal())
		s, err := client.NewSession()
		require.NoError(t, err)
		s.Stdin = bytes.NewReader(bytes.Repeat([]byte{0xa5}, 1048576))
		output, err = s.CombinedOutput("wc -c")
		s.Close()
		require.NoError(t, err)
		require.Equal(t, "1048576\n", string(output))
		for _, destination := range []string{"192.0.2.1:3000", "localhost:0", "127.0.0.1:65536"} {
			c, e := client.Dial("tcp", destination)
			if c != nil {
				c.Close()
			}
			require.Error(t, e, destination)
		}
		accepted, _, err := client.SendRequest("tcpip-forward", true, gossh.Marshal(struct {
			Address string
			Port    uint32
		}{"127.0.0.1", 3000}))
		require.NoError(t, err)
		require.False(t, accepted)
		s, err = client.NewSession()
		require.NoError(t, err)
		accepted, err = s.SendRequest("auth-agent-req@openssh.com", true, nil)
		require.NoError(t, err)
		require.False(t, accepted)
		s.Close()
		s, err = client.NewSession()
		require.NoError(t, err)
		accepted, err = s.SendRequest("x11-req", true, gossh.Marshal(struct {
			SingleConnection bool
			Protocol, Cookie string
			Screen           uint32
		}{true, "MIT-MAGIC-COOKIE-1", "00000000000000000000000000000000", 0}))
		require.NoError(t, err)
		require.False(t, accepted, "X11 forwarding cannot open a guest channel")
		s.Close()
		for _, user := range []string{"root", "developer", "agent", "machine+root"} {
			c, e := gossh.Dial("tcp", address, &gossh.ClientConfig{User: user, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			if c != nil {
				c.Close()
			}
			require.Error(t, e, user)
		}
		refuseLogin := func(user string, auth gossh.AuthMethod) {
			c, e := gossh.Dial("tcp", address, &gossh.ClientConfig{User: user, Auth: []gossh.AuthMethod{auth}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			if c != nil {
				c.Close()
			}
			require.Error(t, e, user)
		}
		_, private, e := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, e)
		stranger, e := gossh.NewSignerFromKey(private)
		require.NoError(t, e)
		refuseLogin(login, gossh.PublicKeys(stranger))
		refuseLogin(login, gossh.Password("legacy-workspace-grant"))
		var repositoryID int64
		require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT repository_id FROM collaborators WHERE user_id=$1`, member).Scan(&repositoryID))
		q := db.New(h.pool)
		_, e = q.CreateDeployKey(t.Context(), db.CreateDeployKeyParams{RepositoryID: repositoryID, Title: "native-refusal", KeyFingerprint: gossh.FingerprintSHA256(stranger.PublicKey()), PublicKey: string(gossh.MarshalAuthorizedKey(stranger.PublicKey())), ReadOnly: false})
		require.NoError(t, e)
		refuseLogin(login, gossh.PublicKeys(stranger))
		t.Run("withdrawn key", func(t *testing.T) {
			_, private, e := ed25519.GenerateKey(rand.Reader)
			require.NoError(t, e)
			withdrawn, e := gossh.NewSignerFromKey(private)
			require.NoError(t, e)
			key, e := q.CreateSSHKey(t.Context(), db.CreateSSHKeyParams{UserID: member, Name: "native-withdrawn", PublicKey: string(gossh.MarshalAuthorizedKey(withdrawn.PublicKey())), Fingerprint: gossh.FingerprintSHA256(withdrawn.PublicKey()), KeyType: "ssh-ed25519"})
			require.NoError(t, e)
			positive, e := gossh.Dial("tcp", address, &gossh.ClientConfig{User: login, Auth: []gossh.AuthMethod{gossh.PublicKeys(withdrawn)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			require.NoError(t, e, "same key authenticates before withdrawal")
			require.NoError(t, positive.Close())
			require.NoError(t, q.DeleteSSHKey(t.Context(), db.DeleteSSHKeyParams{ID: key.ID, UserID: member}))
			refuseLogin(login, gossh.PublicKeys(withdrawn))
		})
		// Mutate only the disposable install's roster. Each new handshake must read
		// current production authority; this never calls a real GitHub repository.
		for _, fixture := range []struct{ name, change, undo string }{
			{"suspended", `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`},
			{"removed identity", `UPDATE collaborators SET user_id=NULL WHERE user_id=$1`, `UPDATE collaborators SET user_id=$1 WHERE repository_id=$2 AND user_id IS NULL`},
		} {
			t.Run(fixture.name, func(t *testing.T) {
				_, e := h.pool.Exec(t.Context(), fixture.change, member)
				require.NoError(t, e)
				defer func() {
					var e error
					if fixture.name == "removed identity" {
						_, e = h.pool.Exec(t.Context(), fixture.undo, member, repositoryID)
					} else {
						_, e = h.pool.Exec(t.Context(), fixture.undo, member)
					}
					require.NoError(t, e)
				}()
				refuseLogin(login, gossh.PublicKeys(signer))
				_, e = command("printf revoked")
				require.Error(t, e, "retained connection cannot bypass roster revocation")
			})
		}
		t.Logf("C-J3-06 native subset: member=%d uid=%d login=%s", member, uid, login)
	})
}

func TestSSHRootInputsValidatedBeforeUse(t *testing.T) {
	exerciseInstalledMemberTerminalAndSSHChain(t, func(h *rootLayerHarness, client *gossh.Client, address, login string, signer gossh.Signer, member int64, uid uint32) {
		command := func(text string) []byte {
			s, e := client.NewSession()
			require.NoError(t, e)
			defer s.Close()
			b, e := s.CombinedOutput(text)
			require.NoError(t, e, string(b))
			return b
		}
		// Repository startup files must not select the privileged shell or loader.
		// Poison files run only as the member and remain data to the root broker.
		command(`mkdir -p /workspace/trm03-poison; printf '#!/bin/sh\nprintf root-canary > /workspace/trm03-root-canary\n' > /workspace/trm03-poison/sh; chmod 755 /workspace/trm03-poison/sh`)
		poisons := [][2]string{{"PATH", "/workspace/trm03-poison"}, {"HOME", "/workspace/trm03-poison"}, {"LD_PRELOAD", "/workspace/trm03-poison/loader.so"}, {"LD_LIBRARY_PATH", "/workspace/trm03-poison"}, {"SHELL", "/workspace/trm03-poison/sh"}, {"BASH_ENV", "/workspace/trm03-poison/sh"}, {"ENV", "/workspace/trm03-poison/sh"}, {"PYTHONPATH", "/workspace/trm03-poison"}, {"PYTHONHOME", "/workspace/trm03-poison"}}
		for index := 0; index <= len(poisons); index++ {
			name := "combined"
			values := poisons
			if index < len(poisons) {
				name = poisons[index][0]
				values = poisons[index : index+1]
			}
			t.Run(name, func(t *testing.T) {
				s, err := client.NewSession()
				require.NoError(t, err)
				defer s.Close()
				for _, pair := range values {
					require.NoError(t, s.Setenv(pair[0], pair[1]), "environment acknowledgment cannot select broker startup inputs")
				}
				output, err := s.CombinedOutput("id -u; id -g; pwd; test ! -e /workspace/trm03-root-canary")
				require.NoError(t, err, string(output))
				require.Equal(t, "20000\n20000\n/workspace\n", string(output))
			})
		}
		require.Equal(t, uint32(20000), uid)
		for _, size := range [][2]int{{0, 80}, {24, 0}, {65536, 80}, {24, 65536}} {
			t.Run(fmt.Sprintf("invalid-pty-%d-%d", size[0], size[1]), func(t *testing.T) {
				s, err := client.NewSession()
				require.NoError(t, err)
				defer s.Close()
				err = s.RequestPty("xterm", size[0], size[1], gossh.TerminalModes{})
				if err == nil {
					_, err = s.CombinedOutput("printf root-canary > /workspace/trm03-root-canary")
				}
				require.Error(t, err, "invalid dimensions must refuse before member payload")
				command("test ! -e /workspace/trm03-root-canary")
			})
		}
		positive, err := client.NewSession()
		require.NoError(t, err)
		defer positive.Close()
		require.NoError(t, positive.RequestPty("xterm", 24, 80, gossh.TerminalModes{}))
		output, err := positive.CombinedOutput("stty size")
		require.NoError(t, err, string(output))
		require.Equal(t, "24 80\r\n", string(output))
		command(`rm -rf /workspace/trm03-poison`)
		t.Log("C-J3-06 native startup-input subset; raw broker envelopes, retained-machine races and C-COL-04 receipts remain required")
	})
}
