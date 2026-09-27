package chatconnector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCredentialRotationAndRevocation(t *testing.T) {
	for _, failRotation := range []bool{false, true} {
		t.Run(fmt.Sprint(failRotation), func(t *testing.T) {
			root := t.TempDir()
			host := &Host{config: filepath.Join(root, "config"), bootstrap: filepath.Join(root, "bootstrap"), stateRoot: root, refreshInterval: 50 * time.Millisecond}
			require.NoError(t, os.WriteFile(host.config, []byte(`{"owner":"alice","repo":"demo"}`), 0600))
			require.NoError(t, os.WriteFile(host.bootstrap, []byte("owner-secret"), 0600))
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var mu sync.Mutex
			issued, revoked := 0, 0
			issue := func(_ context.Context, owner, repo, bootstrap string) (string, func(), error) {
				require.Equal(t, "alice", owner)
				require.Equal(t, "demo", repo)
				require.Equal(t, "owner-secret", bootstrap)
				mu.Lock()
				defer mu.Unlock()
				if failRotation && issued == 1 {
					return "", nil, errors.New("revoked bootstrap")
				}
				issued++
				return fmt.Sprintf("sync-%d", issued), func() { mu.Lock(); revoked++; mu.Unlock() }, nil
			}
			var tokenPath string
			err := host.withCredential(ctx, issue, func(ctx context.Context, path string) error {
				tokenPath = path
				info, err := os.Stat(path)
				require.NoError(t, err)
				require.Equal(t, os.FileMode(0600), info.Mode().Perm())
				first, err := os.ReadFile(path)
				require.NoError(t, err)
				require.Equal(t, "sync-1", string(first))
				for {
					select {
					case <-ctx.Done():
						return nil
					case <-time.After(time.Millisecond):
					}
					current, err := os.ReadFile(path)
					require.NoError(t, err)
					require.NotEmpty(t, current, "replacement is atomic")
					if string(current) != "sync-1" {
						cancel()
						return nil
					}
				}
			})
			if failRotation {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			mu.Lock()
			require.Equal(t, issued, revoked)
			mu.Unlock()
			_, err = os.Stat(tokenPath)
			require.True(t, os.IsNotExist(err))
			original, err := os.ReadFile(host.bootstrap)
			require.NoError(t, err)
			require.Equal(t, "owner-secret", string(original))
		})
	}
}
