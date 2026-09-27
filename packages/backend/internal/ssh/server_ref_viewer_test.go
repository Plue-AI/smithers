package ssh

import (
	"context"
	"io"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// #2253: an SSH git read shows a person's key its user's own
// refs/smithers/users/<id>/ refs, the negotiation rounds included; a deploy
// key sees no user ref.
func TestProxyGitCommandNamesTheRefViewer(t *testing.T) {
	for _, tc := range []struct {
		name      string
		principal sshPrincipal
		viewer    int64
	}{
		{"person", sshPrincipal{UserID: 7, Username: "alice"}, 7},
		{"deploy key", sshPrincipal{UserID: 7, Username: "deploy-key:CI", IsDeployKey: true}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var viewers []int64
			record := func(ctx context.Context) {
				mu.Lock()
				defer mu.Unlock()
				viewers = append(viewers, repohost.RefViewer(ctx))
			}
			server := &Server{RepoHostClient: &mockRepoHostGitProxy{
				infoRefsUploadPackFn: func(ctx context.Context, _, _ string) ([]byte, error) {
					record(ctx)
					return []byte("0000"), nil
				},
				proxyUploadPackBodyFn: func(ctx context.Context, _, _ string, _ io.Reader, _ io.Writer) error {
					record(ctx)
					return nil
				},
				infoRefsReceivePackFn: func(ctx context.Context, _, _ string) ([]byte, error) {
					record(ctx)
					return []byte("0000"), nil
				},
			}}
			require.NoError(t, server.proxyGitCommand(context.Background(),
				newTestSession("git-upload-pack 'alice/demo.git'", "0009done\n"), "git-upload-pack", "alice", "demo", tc.principal))
			require.NoError(t, server.proxyGitCommand(context.Background(),
				newTestSession("git-receive-pack 'alice/demo.git'", ""), "git-receive-pack", "alice", "demo", tc.principal))
			require.GreaterOrEqual(t, len(viewers), 3)
			for _, viewer := range viewers {
				require.Equal(t, tc.viewer, viewer)
			}
		})
	}
}
