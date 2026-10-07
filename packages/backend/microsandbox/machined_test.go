package microsandbox

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestInstalledMachinedRequiresPinnedHostProvidersBeforeGuestEffects(t *testing.T) {
	r := &Runtime{workspaces: map[string]*workspace{"a": {metadata: metadata{ID: "a", Machine: "vm", State: "running"}}}}
	require.ErrorIs(t, r.EnsureMachined(t.Context(), "a"), ErrUnavailable)
	reached := false
	head := func(context.Context, string) (string, error) { reached = true; return "", nil }
	dispatch := func(context.Context, *machined.Link, string) error { reached = true; return nil }
	r.BindMachinedHost(head, dispatch)
	require.ErrorIs(t, r.EnsureMachined(t.Context(), "a"), ErrUnavailable)
	require.False(t, reached)
	bundle, _ := approvedBundleFixture(t)
	r.config.Bundle = pinned(t, bundle)
	// A signed bundle without the native executable cannot plant anything or
	// consume a boot authority, even when host callbacks have been installed.
	require.Error(t, r.EnsureMachined(t.Context(), "a"))
	require.False(t, reached)
	require.Nil(t, r.workspaces["a"].daemonBoot)
	r.BindMachinedHost(nil, dispatch)
	require.ErrorIs(t, r.EnsureMachined(t.Context(), "a"), ErrUnavailable)
	r.workspaces["a"].State = "stopped"
	require.Error(t, r.EnsureMachined(t.Context(), "a"))
}
