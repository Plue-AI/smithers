package repohostserver

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMachineObjectsHoldRepositoryWriterExclusion(t *testing.T) {
	server := &Server{config: Config{StoragePath: t.TempDir()}, locks: newRepoLocker()}
	failure := errors.New("transfer interrupted")
	err := server.WithGitObjectStore(t.Context(), "owner", "app", func(path string) error {
		require.Equal(t, filepath.Join(server.config.StoragePath, "owner", "app", ".jj", "repo", "store", "git"), path)
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		_, err := server.locks.RLock(ctx, server.config.RepoPath("owner", "app"))
		require.Error(t, err, "GC cannot overlap object transfer")
		return failure
	})
	require.ErrorIs(t, err, failure)
	unlock, err := server.locks.Lock(t.Context(), server.config.RepoPath("owner", "app"))
	require.NoError(t, err)
	unlock()
	called := false
	require.Error(t, server.WithGitObjectStore(t.Context(), "..", "app", func(string) error { called = true; return nil }))
	require.False(t, called)
}
