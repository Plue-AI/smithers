package repohost

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOnlyEmbeddedEngineGrantsLocalGitStore(t *testing.T) {
	calls := 0
	withStore := func(_ context.Context, owner, repo string, use func(string) error) error {
		if owner != "owner" || repo != "app" {
			return errors.New("unknown repository")
		}
		calls++
		return use("/install/repositories/owner/app/.jj/repo/store/git")
	}
	use := func(path string) error {
		require.Equal(t, "/install/repositories/owner/app/.jj/repo/store/git", path)
		return nil
	}
	remote := new(Client)
	remote.SetLocalGitStore(withStore)
	require.Error(t, remote.WithLocalGitStore(t.Context(), "owner", "app", use))
	local := NewLocalClient(http.NotFoundHandler(), "token")
	require.Error(t, local.WithLocalGitStore(t.Context(), "owner", "app", use))
	local.SetLocalGitStore(withStore)
	require.NoError(t, local.WithLocalGitStore(t.Context(), "owner", "app", use))
	require.Error(t, local.WithLocalGitStore(t.Context(), "other", "app", use))
	require.Equal(t, 1, calls)
}
