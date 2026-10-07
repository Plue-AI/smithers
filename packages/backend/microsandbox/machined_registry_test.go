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

func TestMachineLifecycleRevokesBootAuthority(t *testing.T) {
	for _, action := range []string{"stop", "stop-stopped", "delete", "reclaim", "delete-failed", "reclaim-failed"} {
		t.Run(action, func(t *testing.T) {
			removeExit := 0
			if action == "delete-failed" || action == "reclaim-failed" {
				removeExit = 1
			}
			r, _ := reclaimFakeMSB(t, removeExit)
			state := "stopped"
			if action == "stop" {
				state = "running"
			}
			ws := addReclaimWorkspace(t, r, "agent-stuck", state, "")
			authority, err := r.MachinedRegistry().MintBoot(ws.ID, ws.Machine)
			require.NoError(t, err)
			stream := &machinedLifecycleStream{}
			lease, err := r.MachinedRegistry().Admit(authority.ID, []byte(authority.Credential), stream)
			require.NoError(t, err)
			require.NoError(t, lease.Reconciled())
			switch action {
			case "stop", "stop-stopped":
				err = r.StopWorkspace(t.Context(), ws.ID)
			case "delete", "delete-failed":
				err = r.DeleteWorkspace(t.Context(), ws.ID)
			default:
				err = r.ReclaimWorkspaceDisk(t.Context(), ws.ID)
			}
			if removeExit != 0 {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.True(t, stream.closed)
			require.ErrorIs(t, lease.RequireReady(ws.ID), machined.ErrUnauthorized)
			reconnect := &machinedLifecycleStream{}
			_, err = r.MachinedRegistry().Admit(authority.ID, []byte(authority.Credential), reconnect)
			require.ErrorIs(t, err, machined.ErrUnauthorized)
			require.True(t, reconnect.closed)
		})
	}
}

type machinedLifecycleStream struct{ closed bool }

func (s *machinedLifecycleStream) Close() error { s.closed = true; return nil }
