package microsandbox

import (
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestRuntimeOwnsMachinedRegistry(t *testing.T) {
	r := &Runtime{}
	registry := r.MachinedRegistry()
	require.Same(t, registry, r.MachinedRegistry())
	_, err := registry.Current("branch")
	require.ErrorIs(t, err, machined.ErrNotReady)
	authority, err := registry.MintBoot("branch", "machine")
	require.NoError(t, err)
	replacement, err := r.MachinedRegistry().MintBoot("branch", "machine")
	require.NoError(t, err)
	require.NotEqual(t, authority.ID, replacement.ID)
	require.Empty(t, registry.ConnectedBranches())
	require.NoError(t, r.Close())
	_, err = registry.MintBoot("branch", "machine")
	require.ErrorIs(t, err, machined.ErrNotReady)
}
