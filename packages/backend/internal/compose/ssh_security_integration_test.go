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
	"github.com/pkg/sftp"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
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
		exerciseSSHBrokerSemanticInputs(t, h, client, login, member, uid)
		exerciseSSHRetainedFilesystemRace(t, client)
		exerciseSSHRetainedExecutableRace(t, client)
		exerciseSSHRetainedCwdRace(t, client)
		t.Log("C-J3-06 native startup and authenticated semantic-envelope subset; private socketpair malformed frames, retained wake races and C-COL-04 receipts remain required")
	})
}

// Bypass Sessions' semantic validators, while retaining the install's actual
// authenticated transport and canonical framing. Refusal must come back from
// the production guest, rather than a host helper or a recording broker.
func exerciseSSHBrokerSemanticInputs(t *testing.T, h *rootLayerHarness, client *gossh.Client, branchLogin string, member int64, uid uint32) {
	var branch, login string
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT w.id,c.unix_login FROM workspaces w JOIN collaborators c ON c.repository_id=w.repository_id WHERE c.user_id=$1 AND w.status='running' AND (w.target_bookmark=$2 OR w.target_bookmark='smithers/' || $2)`, member, branchLogin).Scan(&branch, &login))
	registry := h.runtime.MachinedRegistry()
	link, err := registry.Current(branch)
	require.NoError(t, err)
	fixtures, open := sshBrokerEnvelopeFixtures(login, uid)
	for _, f := range fixtures {
		t.Run("guest-envelope/"+f.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			response, e := link.Request(ctx, branch, f.method, f.fields...)
			if f.hostError != nil {
				require.ErrorIs(t, e, f.hostError, "invalid selectors must never reach root")
				return
			}
			if f.name == "NUL argv" || f.name == "NUL run" {
				require.ErrorIs(t, e, wire.BadUTF8, "noncanonical strings must never reach root")
				return
			}
			require.NoError(t, e, "canonical input must reach the guest")
			fields, e := wire.Fields("response", response.Payload[1:])
			require.NoError(t, e)
			require.Equal(t, byte(255), fields[2][0], "guest must refuse")
			refusal, e := wire.Fields("error", fields[2][1:])
			require.NoError(t, e)
			require.Equal(t, []byte{f.code}, refusal[1])
		})
	}
	// Exercise bounded stream controls against a real admitted member session.
	// These malformed controls must be rejected before any broker send, while
	// leaving its authenticated transport available for the roster race below.
	rpc := registry.Sessions(branch)
	control, err := rpc.CallSession(t.Context(), machined.SessionCall{Method: "open_session", Actor: bytes.Repeat([]byte{7}, 16), User: &machined.SessionUser{Login: login, UID: uid}, Kind: machined.SessionExec, Argv: []string{"/bin/cat"}})
	require.NoError(t, err)
	stream, err := rpc.(machined.SessionTransport).Stream(t.Context(), control.Session)
	require.NoError(t, err)
	for _, payload := range [][]byte{{4, 0}, {4, 255}, {3, 0, 0, 0, 80}, {3, 0, 24, 0, 0}, {6, 255, 255, 255, 255}} {
		t.Run(fmt.Sprintf("stream-control/%x", payload), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			require.ErrorIs(t, stream.Send(ctx, payload), wire.BadValue)
		})
	}
	_, err = rpc.CallSession(t.Context(), machined.SessionCall{Method: "kill_sessions", Session: control.Session})
	require.NoError(t, err)
	// Withdraw the roster on the same live boot. A caller retaining the resolved
	// identity and authenticated Link must not launch after the roster receipt.
	var roster []machined.SessionUser
	rows, err := h.pool.Query(t.Context(), `SELECT unix_login,unix_uid FROM collaborators WHERE repository_id=(SELECT repository_id FROM workspaces WHERE id=$1) AND user_id IS NOT NULL AND suspended_at IS NULL AND unix_login IS NOT NULL ORDER BY unix_uid`, branch)
	require.NoError(t, err)
	for rows.Next() {
		var u machined.SessionUser
		require.NoError(t, rows.Scan(&u.Login, &u.UID))
		roster = append(roster, u)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	retained := make([]machined.SessionUser, 0, len(roster))
	for _, u := range roster {
		if u.UID != uid {
			retained = append(retained, u)
		}
	}
	require.NoError(t, registry.SetRoster(t.Context(), branch, retained))
	defer func() { require.NoError(t, registry.SetRoster(t.Context(), branch, roster)) }()
	// All callers cached the member identity before withdrawal. Correlated
	// concurrent requests on the retained boot must observe the committed fence.
	t.Run("retained-roster-fence", func(t *testing.T) {
		for n := 0; n < 8; n++ {
			t.Run(fmt.Sprintf("stale-open-%d", n), func(t *testing.T) {
				t.Parallel()
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				response, err := link.Request(ctx, branch, wire.OpenSession, open(login, uid, 2, "/bin/sh", "-c", "touch /workspace/trm03-root-canary")...)
				require.NoError(t, err)
				fields, err := wire.Fields("response", response.Payload[1:])
				require.NoError(t, err)
				require.Equal(t, byte(255), fields[2][0])
				refusal, err := wire.Fields("error", fields[2][1:])
				require.NoError(t, err)
				require.Equal(t, []byte{1}, refusal[1], "retained authority cannot bypass roster withdrawal")
			})
		}
	})
	require.NoError(t, registry.SetRoster(t.Context(), branch, roster))
	// Same transport remains usable; a rejected request cannot poison another
	// member's session or leave a canary. Expectations are literal policy fixtures.
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	output, err := session.CombinedOutput("id -u; id -g; test ! -e /workspace/trm03-root-canary")
	require.NoError(t, err, string(output))
	require.Equal(t, "20000\n20000\n", string(output))
}

type sshBrokerEnvelopeFixture struct {
	name      string
	method    wire.Method
	fields    [][]byte
	code      byte
	hostError error
}

func sshBrokerEnvelopeFixtures(login string, uid uint32) ([]sshBrokerEnvelopeFixture, func(string, uint32, byte, ...string) [][]byte) {
	actor := bytes.Repeat([]byte{7}, 16)
	user := func(name string, id uint32) []byte {
		return wire.Struct(wire.Field(1, wire.String(name)), wire.Field(2, wire.U32(id)))
	}
	argv := func(values ...string) []byte {
		result := wire.U16(uint16(len(values)))
		for _, value := range values {
			result = append(result, wire.String(value)...)
		}
		return result
	}
	open := func(name string, id uint32, kind byte, values ...string) [][]byte {
		return [][]byte{wire.Field(1, user(name, id)), wire.Field(2, []byte{kind}), wire.Field(3, argv(values...)), wire.Field(5, actor)}
	}
	withSize := func(fields [][]byte, cols, rows uint16) [][]byte {
		return append(append(append([][]byte{}, fields[:3]...), wire.Field(4, wire.Struct(wire.Field(1, wire.U16(cols)), wire.Field(2, wire.U16(rows))))), fields[3:]...)
	}
	fixtures := []sshBrokerEnvelopeFixture{
		{"root uid", wire.OpenSession, open("root", 0, 2, "/bin/sh", "-c", "touch /workspace/trm03-root-canary"), 1, nil},
		{"uid login mismatch", wire.OpenSession, open(login, 20001, 2, "/bin/sh"), 1, nil},
		{"foreign login", wire.OpenSession, open("not-a-member", uid, 2, "/bin/sh"), 1, nil},
		{"empty exec", wire.OpenSession, open(login, uid, 2), 1, nil},
		{"empty executable", wire.OpenSession, open(login, uid, 2, ""), 1, nil},
		{"NUL argv", wire.OpenSession, open(login, uid, 2, "/bin/sh\x00"), 1, nil},
		{"sftp executable selection", wire.OpenSession, open(login, uid, 3, "/workspace/trm03-poison/sh"), 1, nil},
		{"PTY zero columns", wire.OpenSession, withSize(open(login, uid, 1), 0, 24), 1, nil},
		{"exec PTY dimensions", wire.OpenSession, withSize(open(login, uid, 2, "/bin/sh"), 80, 24), 1, nil},
		{"zero loopback port", wire.TCPConnect, [][]byte{wire.Field(1, wire.U16(0)), wire.Field(2, actor)}, 1, nil},
		{"zero close", wire.CloseSession, [][]byte{wire.Field(1, wire.U32(0))}, 1, nil},
		{"out of range close", wire.CloseSession, [][]byte{wire.Field(1, wire.U32(0xffffffff))}, 1, nil},
		{"foreign close", wire.CloseSession, [][]byte{wire.Field(1, wire.U32(2147483647))}, 1, nil},
		{"foreign attach", wire.AttachSession, [][]byte{wire.Field(1, wire.U32(2147483647)), wire.Field(2, wire.U64(0))}, 1, nil},
		{"zero attach", wire.AttachSession, [][]byte{wire.Field(1, wire.U32(0)), wire.Field(2, wire.U64(0))}, 1, nil},
		{"NUL run", wire.RegisterRun, [][]byte{wire.Field(1, wire.String("run\x00foreign")), wire.Field(2, wire.U32(1))}, 1, nil},
	}

	// These raw tagged selectors are deliberately absent from the production
	// protocol. The authenticated Link must reject them before broker use.
	for _, selector := range []struct{ name, value string }{
		{"environment selector", "LD_PRELOAD=/workspace/loader.so"},
		{"cwd selector", "/etc"},
		{"shell selector", "/workspace/sh"},
		{"cgroup selector", "../../broker"},
	} {
		fields := append(open(login, uid, 2, "/bin/sh"), wire.Field(7, wire.String(selector.value)))
		fixtures = append(fixtures, sshBrokerEnvelopeFixture{selector.name, wire.OpenSession, fields, 1, wire.UnknownField})
	}

	return fixtures, open
}

// Supplemental framing check: canonical cases must reach the guest; NUL
// strings must be refused on the host before sending any privileged envelope. This is not a
// substitute for executing TestSSHRootInputsValidatedBeforeUse on a microVM.
func TestSSHBrokerEnvelopeFramingBoundary(t *testing.T) {
	fixtures, _ := sshBrokerEnvelopeFixtures("rehearsal-owner", 20000)
	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			_, err := wire.RequestFrame(1, f.method, f.fields...)
			if f.hostError != nil {
				require.ErrorIs(t, err, f.hostError)
			} else if f.name == "NUL argv" || f.name == "NUL run" {
				require.ErrorIs(t, err, wire.BadUTF8)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

// Exercise branch-controlled symlink swaps on the already admitted machine,
// after the roster withdrawal/restore matrix. SFTP uses the installed member
// process, not a host filesystem or a recording bridge.
func exerciseSSHRetainedFilesystemRace(t *testing.T, client *gossh.Client) {
	t.Helper()
	t.Run("retained-sftp-symlink-race", func(t *testing.T) {
		command := func(text string) []byte {
			t.Helper()
			session, err := client.NewSession()
			require.NoError(t, err)
			defer session.Close()
			output, err := session.CombinedOutput(text)
			require.NoError(t, err, string(output))
			return output
		}
		const root = "/workspace/trm03-retained-race"
		command(`test ! -e /etc/trm03-outside-canary; mkdir -p /workspace/trm03-retained-race/inside; ln -s /etc /workspace/trm03-retained-race/target`)
		defer command(`rm -rf /workspace/trm03-retained-race`)
		remote, err := sftp.NewClient(client)
		require.NoError(t, err)
		defer remote.Close()
		outside, err := remote.Create(root + "/target/trm03-outside-canary")
		if outside != nil {
			outside.Close()
		}
		require.ErrorIs(t, err, os.ErrPermission, "fixed outside target is refused before the race")
		racer, err := client.NewSession()
		require.NoError(t, err)
		defer racer.Close()
		var raceOutput bytes.Buffer
		racer.Stdout, racer.Stderr = &raceOutput, &raceOutput
		require.NoError(t, racer.Start(`set -eu; cd /workspace/trm03-retained-race; touch ready; while test ! -e done; do ln -s /etc next; mv -Tf next target; ln -s inside next; mv -Tf next target; done`))
		defer func() {
			done, e := remote.Create(root + "/done")
			require.NoError(t, e)
			require.NoError(t, done.Close())
			require.NoError(t, racer.Wait(), raceOutput.String())
		}()
		// The handshake proves the swapping process is running before any write.
		require.Eventually(t, func() bool { _, e := remote.Stat(root + "/ready"); return e == nil }, 5*time.Second, 10*time.Millisecond)
		for attempt := 0; attempt < 64; attempt++ {
			file, e := remote.OpenFile(root+"/target/trm03-outside-canary", os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
			if e != nil {
				// A raced outside target is refused by the member process. Other errors
				// must not turn transport failure into successful confinement evidence.
				require.ErrorIs(t, e, os.ErrPermission)
				continue
			}
			_, e = file.Write([]byte("member-only\n"))
			require.NoError(t, e)
			require.NoError(t, file.Close())
		}
		require.Equal(t, "20000\n20000\n20000\n/workspace\n", string(command(`id -u; id -g; id -G; pwd; test ! -e /etc/trm03-outside-canary`)))
		positive, err := remote.Create(root + "/inside/positive")
		require.NoError(t, err)
		_, err = positive.Write([]byte("retained-member\n"))
		require.NoError(t, err)
		require.NoError(t, positive.Close())
		require.Equal(t, "retained-member\n", string(command(`cat /workspace/trm03-retained-race/inside/positive`)))
	})
}

// The SSH command is deliberately a branch-owned executable symlink. Its
// resolution and interpreter startup must happen as the member, even while a
// retained process replaces that symlink and client startup variables are hostile.
func exerciseSSHRetainedExecutableRace(t *testing.T, client *gossh.Client) {
	t.Helper()
	t.Run("retained-executable-symlink-race", func(t *testing.T) {
		command := func(text string) []byte {
			t.Helper()
			session, err := client.NewSession()
			require.NoError(t, err)
			defer session.Close()
			output, err := session.CombinedOutput(text)
			require.NoError(t, err, string(output))
			return output
		}
		command(`set -eu
 test ! -e /etc/trm03-executable-canary
 mkdir -p /workspace/trm03-executable-race
 cd /workspace/trm03-executable-race
 for name in a b; do
 cat > "$name" <<'SCRIPT'
#!/bin/sh
set -eu
id -u
id -g
id -G
pwd
grep -Eq '^0::/smithers/sessions/s[1-9][0-9]*$' /proc/$$/cgroup
if (printf 0 > /sys/fs/cgroup/smithers/cgroup.procs) 2>/dev/null; then exit 1; fi
if (printf root-canary > /etc/trm03-executable-canary) 2>/dev/null; then exit 1; fi
SCRIPT
 chmod 755 "$name"
 done
 ln -s a target`)
		defer command(`rm -rf /workspace/trm03-executable-race`)
		racer, err := client.NewSession()
		require.NoError(t, err)
		defer racer.Close()
		var raceOutput bytes.Buffer
		racer.Stdout, racer.Stderr = &raceOutput, &raceOutput
		require.NoError(t, racer.Start(`set -eu; cd /workspace/trm03-executable-race; while test ! -e done; do ln -s a next; mv -Tf next target; ln -s b next; mv -Tf next target; touch ready; done`))
		remote, err := sftp.NewClient(client)
		require.NoError(t, err)
		defer remote.Close()
		defer func() {
			file, err := remote.Create("/workspace/trm03-executable-race/done")
			require.NoError(t, err)
			require.NoError(t, file.Close())
			require.NoError(t, racer.Wait(), raceOutput.String())
		}()
		require.Eventually(t, func() bool {
			_, err := remote.Stat("/workspace/trm03-executable-race/ready")
			return err == nil
		}, 5*time.Second, 10*time.Millisecond)
		for attempt := 0; attempt < 32; attempt++ {
			session, err := client.NewSession()
			require.NoError(t, err)
			for _, pair := range [][2]string{
				{"PATH", "/workspace/trm03-executable-race"},
				{"SHELL", "/workspace/trm03-executable-race/target"},
				{"BASH_ENV", "/workspace/trm03-executable-race/target"},
				{"LD_PRELOAD", "/workspace/trm03-executable-race/target"},
			} {
				require.NoError(t, session.Setenv(pair[0], pair[1]))
			}
			output, err := session.CombinedOutput("/workspace/trm03-executable-race/target")
			session.Close()
			require.NoError(t, err, "attempt %d: %s", attempt, output)
			require.Equal(t, "20000\n20000\n20000\n/workspace\n", string(output), "attempt %d", attempt)
		}
		require.Equal(t, "20000\n20000\n20000\n/workspace\n", string(command(`id -u; id -g; id -G; pwd; test ! -e /etc/trm03-executable-canary`)))
	})
}

// Client cwd and home selectors cannot change privileged startup's fixed cwd,
// even while the retained member process atomically changes their referent.
func exerciseSSHRetainedCwdRace(t *testing.T, client *gossh.Client) {
	t.Helper()
	t.Run("retained-cwd-selector-race", func(t *testing.T) {
		command := func(text string) []byte {
			t.Helper()
			session, err := client.NewSession()
			require.NoError(t, err)
			defer session.Close()
			out, err := session.CombinedOutput(text)
			require.NoError(t, err, string(out))
			return out
		}
		command(`set -eu; test ! -e /etc/trm03-cwd-canary; mkdir -p /workspace/trm03-cwd-race/inside; ln -s inside /workspace/trm03-cwd-race/target`)
		defer command(`rm -rf /workspace/trm03-cwd-race`)
		racer, err := client.NewSession()
		require.NoError(t, err)
		defer racer.Close()
		var output bytes.Buffer
		racer.Stdout, racer.Stderr = &output, &output
		require.NoError(t, racer.Start(`set -eu; cd /workspace/trm03-cwd-race; while test ! -e done; do ln -s /etc next; mv -Tf next target; ln -s inside next; mv -Tf next target; touch ready; done`))
		defer func() {
			command(`touch /workspace/trm03-cwd-race/done`)
			require.NoError(t, racer.Wait(), output.String())
		}()
		require.Eventually(t, func() bool {
			return string(command(`test ! -e /workspace/trm03-cwd-race/ready || printf ready`)) == "ready"
		}, 5*time.Second, 10*time.Millisecond)
		for attempt := 0; attempt < 32; attempt++ {
			session, err := client.NewSession()
			require.NoError(t, err)
			for _, name := range []string{"HOME", "PWD", "OLDPWD", "CDPATH"} {
				require.NoError(t, session.Setenv(name, "/workspace/trm03-cwd-race/target"))
			}
			out, err := session.CombinedOutput(`id -u; id -g; id -G; pwd; grep -Eq '^0::/smithers/sessions/s[1-9][0-9]*$' /proc/$$/cgroup; test ! -e /etc/trm03-cwd-canary; if (printf canary > /etc/trm03-cwd-canary) 2>/dev/null; then exit 1; fi`)
			session.Close()
			require.NoError(t, err, "attempt %d: %s", attempt, out)
			require.Equal(t, "20000\n20000\n20000\n/workspace\n", string(out))
		}
		require.Equal(t, "member-control\n", string(command(`printf 'member-control\n'; test ! -e /etc/trm03-cwd-canary`)))
	})
}
