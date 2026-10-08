package microsandbox

import (
	"os"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestRecipeRefreshRefusesUnsafeReplacement(t *testing.T) {
	for _, state := range []string{"running", "starting", "stopping", "recovery_required"} {
		t.Run(state, func(t *testing.T) {
			r, log := reclaimFakeMSB(t, 0)
			ws := addReclaimWorkspace(t, r, "recipe", state, "old-layer")
			before := readReclaimMetadata(t, ws)
			changed, err := r.RefreshWorkspaceRecipe(t.Context(), workspaceapi.WorkspaceSpec{ID: ws.ID})
			require.Error(t, err)
			require.False(t, changed)
			require.Equal(t, before, readReclaimMetadata(t, ws))
			require.Empty(t, invocations(t, log))
		})
	}
	r, log := reclaimFakeMSB(t, 0)
	ws := addReclaimWorkspace(t, r, "recipe", "stopped", "old-layer")
	changed, err := r.RefreshWorkspaceRecipe(t.Context(), workspaceapi.WorkspaceSpec{ID: ws.ID})
	require.ErrorContains(t, err, "requires the workspace source")
	require.False(t, changed)
	require.Empty(t, invocations(t, log))
	_, err = r.RefreshWorkspaceRecipe(t.Context(), workspaceapi.WorkspaceSpec{ID: "absent"})
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceNotFound)
}

func TestRecipeRefreshPersistsReplacementBeforeRemoval(t *testing.T) {
	for _, removeExit := range []int{0, 1} {
		t.Run(string(rune('0'+removeExit)), func(t *testing.T) {
			r, log := reclaimFakeMSB(t, removeExit)
			ws := addReclaimWorkspace(t, r, "agent-stuck", "stopped", "old-layer")
			spec := workspaceapi.WorkspaceSpec{ID: ws.ID, Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "main"}}
			changed, err := r.RefreshWorkspaceRecipe(t.Context(), spec)
			require.True(t, changed)
			if removeExit == 0 {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
			stored := readReclaimMetadata(t, ws)
			require.True(t, stored.Reclaimed)
			require.Equal(t, "stopped", stored.State)
			require.Empty(t, stored.Snapshot)
			require.Empty(t, stored.LayerKey)
			require.Empty(t, stored.Link)
			calls := invocations(t, log)
			require.Contains(t, calls, "remove --force -q "+ws.Machine)
			changed, err = r.RefreshWorkspaceRecipe(t.Context(), spec)
			require.NoError(t, err)
			require.True(t, changed, "replacement remains pending until a fresh boot succeeds")
			require.Equal(t, calls, invocations(t, log), "replay cannot remove a disk twice")
			if removeExit != 0 {
				require.NoError(t, r.recover(t.Context()))
				require.True(t, readReclaimMetadata(t, ws).Reclaimed, "a surviving old disk must never become a warm boot")
				from := len(invocations(t, log))
				require.Error(t, r.recreateMachine(t.Context(), ws))
				for _, call := range invocations(t, log)[from:] {
					require.NotContains(t, call, "create", "unconfirmed old-disk removal forbids fresh boot")
				}
			}
		})
	}
}

func TestRecipeRefreshMetadataFailureKeepsOriginalDisk(t *testing.T) {
	r, log := reclaimFakeMSB(t, 0)
	ws := addReclaimWorkspace(t, r, "recipe", "stopped", "old-layer")
	before := ws.metadata
	require.NoError(t, os.RemoveAll(ws.directory))
	changed, err := r.RefreshWorkspaceRecipe(t.Context(), workspaceapi.WorkspaceSpec{ID: ws.ID, Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "main"}})
	require.Error(t, err)
	require.False(t, changed)
	require.Equal(t, before, ws.metadata)
	require.Empty(t, invocations(t, log), "disk removal requires a durable target recipe")
}
