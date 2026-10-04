package ssh

import (
	"context"
	stdErrors "errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// An SSH push is checked under repo-host's lock against the repository it
// was authorized for (#2846).
func TestSSHReceivePackChecksRepositoryUnderLock(t *testing.T) {
	for _, tc := range []struct {
		name    string
		current int64
	}{
		{name: "unchanged", current: 109},
		{name: "replaced", current: 110},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lookups := 0
			var checkErr error
			server := &Server{
				Queries: &mockSSHPrincipalQuerier{
					getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
						lookups++
						if lookups == 1 {
							return db.Repository{ID: 109}, nil
						}
						assert.Equal(t, db.GetRepoByOwnerAndLowerNameParams{Owner: "alice", LowerName: "demo"}, arg)
						return db.Repository{ID: tc.current}, nil
					},
				},
				Authorizer: &mockSSHAuthorizer{authorizeFn: func(context.Context, int64, string, string, services.AccessMode) error { return nil }},
				RepoHostClient: &mockRepoHostGitProxy{
					infoRefsReceivePackFn: func(context.Context, string, string) ([]byte, error) { return []byte("0000"), nil },
					proxyReceivePackFn: func(ctx context.Context, _, _ string, stdin io.Reader, _ io.Writer, meta ...repohost.ReceivePackMetadata) error {
						require.Len(t, meta, 1)
						require.Equal(t, int64(109), meta[0].RepositoryID)
						require.NotNil(t, meta[0].VerifyLocked)
						// What the client does once repo-host reports the lock.
						checkErr = meta[0].VerifyLocked(ctx)
						if checkErr != nil {
							return fmt.Errorf("receive-pack refused under the repository lock: %w", checkErr)
						}
						_, _ = io.Copy(io.Discard, stdin)
						return nil
					},
				},
			}
			sess := newTestSession("git-receive-pack 'alice/demo.git'", "0000receive-pack-request")
			sess.ctx.SetValue(principalKey, sshPrincipal{UserID: 1, Username: "alice"})
			server.sessionHandler(sess)
			if tc.current == 109 {
				require.NoError(t, checkErr)
				assert.Equal(t, 0, sess.exitCode)
				return
			}
			require.True(t, stdErrors.Is(checkErr, repohost.ErrRepositoryReplaced))
			assert.Equal(t, 1, sess.exitCode)
			assert.Contains(t, sess.stderr.String(), "repository was replaced during the push; retry the push")
		})
	}
}

func TestSSHReceivePackInstallMainMirror(t *testing.T) {
	for _, deploy := range []bool{false, true} {
		for _, op := range []string{"fast-forward", "non-fast-forward", "create", "delete"} {
			t.Run(fmt.Sprintf("deploy=%v/%s", deploy, op), func(t *testing.T) {
				old, next := strings.Repeat("1", 40), strings.Repeat("2", 40)
				if op == "non-fast-forward" {
					old, next = next, old
				}
				if op == "create" {
					old = strings.Repeat("0", 40)
				}
				if op == "delete" {
					next = strings.Repeat("0", 40)
				}
				line := old + " " + next + " refs/heads/main\x00report-status\n"
				body := fmt.Sprintf("%04x%s0000PACK", len(line)+4, line)
				calls := 0
				server := &Server{BranchLogins: true, Queries: pushRepoQuerier(), RepoHostClient: &mockRepoHostGitProxy{
					infoRefsReceivePackFn: func(context.Context, string, string) ([]byte, error) { return []byte("0000"), nil },
					proxyReceivePackFn: func(_ context.Context, _, _ string, stdin io.Reader, _ io.Writer, _ ...repohost.ReceivePackMetadata) error {
						_, _ = io.Copy(io.Discard, stdin)
						calls++
						return nil
					},
				}}
				sess := newTestSession("", body)
				err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy})
				require.Error(t, err)
				assert.Contains(t, sess.stderr.String(), "main")
				assert.Zero(t, calls)
				// Hosted main and install feature pushes retain their receive behavior.
				server.BranchLogins = false
				require.NoError(t, server.proxyReceivePack(context.Background(), newTestSession("", body), "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy}))
				assert.Equal(t, 1, calls)
				server.BranchLogins = true
				feature := strings.Replace(body, "refs/heads/main", "refs/heads/work", 1)
				require.NoError(t, server.proxyReceivePack(context.Background(), newTestSession("", feature), "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy}))
				assert.Equal(t, 2, calls)
			})
		}
	}
}
