package repohost

import (
	"context"
	"errors"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestMachineRepositoryRequiresInstalledProvider(t *testing.T) {
	client := &Client{}
	reached := false
	visit := func(string) error { reached = true; return nil }
	require.Error(t, client.WithMachineRepository(t.Context(), "owner", "repo", visit))
	require.False(t, reached)
	refusal := errors.New("repository lock refused")
	client.BindMachineRepository(func(ctx context.Context, owner, repo string, f func(string) error) error {
		require.Equal(t, "owner", owner)
		require.Equal(t, "repo", repo)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return refusal
	})
	require.ErrorIs(t, client.WithMachineRepository(t.Context(), "owner", "repo", visit), refusal)
	require.False(t, reached)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, client.WithMachineRepository(ctx, "owner", "repo", visit), context.Canceled)
	require.False(t, reached)
	client.BindMachineRepository(func(ctx context.Context, owner, repo string, f func(string) error) error { return f("/trusted/store") })
	require.NoError(t, client.WithMachineRepository(t.Context(), "owner", "repo", func(path string) error { require.Equal(t, "/trusted/store", path); return nil }))
	require.Error(t, client.WithMachineRepository(t.Context(), "owner", "repo", nil))
}
