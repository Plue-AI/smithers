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
				server := &Server{InstallMainMirror: true, Queries: pushRepoQuerier(), RepoHostClient: &mockRepoHostGitProxy{
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
				server.InstallMainMirror = false
				require.NoError(t, server.proxyReceivePack(context.Background(), newTestSession("", body), "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy}))
				assert.Equal(t, 1, calls)
				server.InstallMainMirror = true
				feature := strings.Replace(body, "refs/heads/main", "refs/heads/work", 1)
				require.NoError(t, server.proxyReceivePack(context.Background(), newTestSession("", feature), "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy}))
				assert.Equal(t, 2, calls)
			})
		}
	}
}

// sshPushBody is one receive-pack request of several ref creations.
func sshPushBody(refs ...string) string {
	var body strings.Builder
	for i, ref := range refs {
		line := strings.Repeat("0", 40) + " " + strings.Repeat("2", 40) + " " + ref
		if i == 0 {
			line += "\x00report-status"
		}
		line += "\n"
		fmt.Fprintf(&body, "%04x%s", len(line)+4, line)
	}
	return body.String() + "0000PACK"
}

// The install fact comes from the repository engine (repohost.Client), not
// from the login parser: BranchLogins alone protects nothing, and the rule
// covers the default bookmark, its aliases and a multi-ref request.
func TestSSHReceivePackInstallMainCoversDefaultBookmarkAliasesAndMultiRef(t *testing.T) {
	trunk := &mockSSHPrincipalQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 109, DefaultBookmark: "trunk"}, nil
		},
	}
	calls := 0
	server := &Server{InstallMainMirror: true, Queries: trunk, RepoHostClient: &mockRepoHostGitProxy{
		infoRefsReceivePackFn: func(context.Context, string, string) ([]byte, error) { return []byte("0000"), nil },
		proxyReceivePackFn: func(_ context.Context, _, _ string, stdin io.Reader, _ io.Writer, _ ...repohost.ReceivePackMetadata) error {
			_, _ = io.Copy(io.Discard, stdin)
			calls++
			return nil
		},
	}}
	for _, deploy := range []bool{false, true} {
		for _, refs := range [][]string{
			{"refs/heads/main"}, {"refs/heads/trunk"}, {"refs/heads/MAIN"}, {"refs/heads/ma\u200cin"},
			{"refs/heads/Trunk"}, {"refs/heads/tr\u200dunk"}, {"refs/Heads/trunk"},
			{"refs/heads/work", "refs/heads/main"}, {"refs/heads/work", "refs/heads/trunk"},
		} {
			sess := newTestSession("", sshPushBody(refs...))
			err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy})
			require.Error(t, err, "deploy=%v %v", deploy, refs)
			assert.Contains(t, sess.stderr.String(), "GitHub mirror", "deploy=%v %v", deploy, refs)
		}
	}
	assert.Zero(t, calls)
	require.NoError(t, server.proxyReceivePack(context.Background(), newTestSession("", sshPushBody("refs/heads/work", "refs/heads/trunk/child")), "alice", "demo", sshPrincipal{UserID: 1}))
	assert.Equal(t, 1, calls)

	// BranchLogins selects the install login parser; it is not the install
	// main fact, which an SSH server takes from its repository engine.
	server.InstallMainMirror, server.BranchLogins = false, true
	require.NoError(t, server.proxyReceivePack(context.Background(), newTestSession("", sshPushBody("refs/heads/main")), "alice", "demo", sshPrincipal{UserID: 1}))
	assert.Equal(t, 2, calls)
}

// Round 4 admission at the SSH door: a command naming HEAD, another
// pseudoref or a bare name is refused before repo-host, with the reason on
// stderr, for user and deploy keys, on an install and hosted.
func TestSSHReceivePackRefusesPseudorefs(t *testing.T) {
	calls := 0
	server := &Server{Queries: pushRepoQuerier(), RepoHostClient: &mockRepoHostGitProxy{
		infoRefsReceivePackFn: func(context.Context, string, string) ([]byte, error) { return []byte("0000"), nil },
		proxyReceivePackFn: func(_ context.Context, _, _ string, stdin io.Reader, _ io.Writer, _ ...repohost.ReceivePackMetadata) error {
			_, _ = io.Copy(io.Discard, stdin)
			calls++
			return nil
		},
	}}
	for _, install := range []bool{true, false} {
		for _, deploy := range []bool{false, true} {
			for _, name := range []string{"HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "main"} {
				server.InstallMainMirror = install
				sess := newTestSession("", sshPushBody("refs/tags/v1", name))
				err := server.proxyReceivePack(context.Background(), sess, "alice", "demo", sshPrincipal{UserID: 1, IsDeployKey: deploy})
				require.Error(t, err, "install=%v deploy=%v %s", install, deploy, name)
				assert.Contains(t, sess.stderr.String(), `"`+name+`" is not a fully qualified name under refs/`)
			}
		}
	}
	assert.Zero(t, calls)
}
