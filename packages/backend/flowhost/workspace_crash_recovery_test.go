//go:build unix

package flowhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Exercise the public resolver with real PostgreSQL bindings and the canonical
// process workspace adapter. Only the coding host's HTTP application is a test
// child (defined in workspace_launcher_test.go): this qualifies crash lifecycle,
// not replay of Control approvals or recovery of a lost disk (#1868, #2099).
func TestWorkspaceResolverRecoversKilledHostWithoutReplacingBox(t *testing.T) {
	pool := hostTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	authority, catalog := hostFixture(t, pool)
	runtime, err := process.New(process.Config{Root: t.TempDir(), TerminationGrace: 100 * time.Millisecond})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	box, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: authority.WorkspaceID})
	require.NoError(t, err)
	box, err = runtime.StartWorkspace(ctx, box.ID)
	require.NoError(t, err)
	launcher, err := NewWorkspaceLauncher(runtime)
	require.NoError(t, err)
	catalog.Executable, err = os.Executable()
	require.NoError(t, err)
	marker := filepath.Join(t.TempDir(), "host.json")
	catalog.Environment = map[string]string{"SMITHERS_FLOWHOST_TEST_CHILD": "1", "SMITHERS_FLOWHOST_TEST_MARKER": marker}
	catalog.ReadyTimeout = 5 * time.Second
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	resolver, err := New(Config{
		Store: store, Launcher: launcher, Catalogs: []Catalog{catalog},
		Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) { return authority, nil }),
	})
	require.NoError(t, err)
	first, err := resolver.ResolveFlowRuntime(ctx, authority.Target)
	require.NoError(t, err)
	readBinding := func() Binding {
		t.Helper()
		lease, err := store.AcquireExisting(ctx, authority, catalog)
		require.NoError(t, err)
		binding := lease.Binding()
		require.NoError(t, lease.Close())
		return binding
	}
	originalBinding := readBinding()
	before, err := first.Identity(ctx)
	require.NoError(t, err)
	readMarker := func() map[string]string {
		t.Helper()
		data, err := os.ReadFile(marker)
		require.NoError(t, err)
		var receipt map[string]string
		require.NoError(t, json.Unmarshal(data, &receipt))
		return receipt
	}
	original := readMarker()
	// A sentinel detects allocating a new state directory or clearing the old
	// one. It is deliberately not represented as an actual Control journal.
	stateFile := filepath.Join(original["state"], "retained-state-sentinel")
	require.NoError(t, os.WriteFile(stateFile, []byte("retained"), 0600))
	pid, err := strconv.Atoi(original["pid"])
	require.NoError(t, err)
	require.NoError(t, syscall.Kill(pid, syscall.SIGKILL))
	// Wait for the adapter to reap the real process so the restart does not
	// race an unreaped child.
	require.Eventually(t, func() bool {
		_, err := resolver.ResolveExistingFlowRuntime(ctx, authority.Target)
		var failure flowruntime.Failure
		return errors.As(err, &failure) && failure.FlowRuntimeCode() == "runtime_host_not_running"
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, originalBinding, readBinding(), "read-only resolution must not change ownership")
	second, err := resolver.ResolveFlowRuntime(ctx, authority.Target)
	require.NoError(t, err)
	after, err := second.Identity(ctx)
	require.NoError(t, err)
	require.Equal(t, before.OwnerGeneration+1, after.OwnerGeneration)
	require.Equal(t, before.SourceRevision, after.SourceRevision)
	require.Equal(t, before.RuntimeArtifactDigest, after.RuntimeArtifactDigest)
	recoveredBinding := readBinding()
	require.Equal(t, originalBinding.ID, recoveredBinding.ID)
	require.Equal(t, originalBinding.WorkspaceID, recoveredBinding.WorkspaceID)
	require.Equal(t, after.OwnerGeneration, recoveredBinding.OwnerGeneration)
	require.Equal(t, "running", recoveredBinding.State)
	restarted := readMarker()
	require.NotEqual(t, original["pid"], restarted["pid"])
	require.Equal(t, original["state"], restarted["state"])
	retained, err := os.ReadFile(stateFile)
	require.NoError(t, err)
	require.Equal(t, "retained", string(retained))
	current, err := runtime.InspectWorkspace(ctx, box.ID)
	require.NoError(t, err)
	require.Equal(t, box.ID, current.ID)
	require.Equal(t, box.Root, current.Root)
	require.Equal(t, box.StateDir, current.StateDir)
	require.Equal(t, workspaceapi.WorkspaceRunning, current.State)
	// Read-only reconnect reaches the healthy owner without changing the
	// durable binding or starting another process.
	readOnly, err := resolver.ResolveExistingFlowRuntime(ctx, authority.Target)
	require.NoError(t, err)
	readOnlyIdentity, err := readOnly.Identity(ctx)
	require.NoError(t, err)
	require.Equal(t, after, readOnlyIdentity)
	require.Equal(t, recoveredBinding, readBinding())
	require.Equal(t, restarted["pid"], readMarker()["pid"])
	// A healthy reconnect must not perform another ownership transition.
	again, err := resolver.ResolveFlowRuntime(ctx, authority.Target)
	require.NoError(t, err)
	identity, err := again.Identity(ctx)
	require.NoError(t, err)
	require.Equal(t, after, identity)
	require.Equal(t, restarted["pid"], readMarker()["pid"])

	// Even with a retained product binding, intentional deletion is not
	// authority for automatic creation of a fresh, empty workspace.
	require.NoError(t, runtime.DeleteWorkspace(ctx, box.ID))
	for range 2 {
		_, err = resolver.ResolveFlowRuntime(ctx, authority.Target)
		var failure flowruntime.Failure
		require.ErrorAs(t, err, &failure)
		require.Equal(t, "runtime_inspection_failed", failure.FlowRuntimeCode())
		require.Equal(t, recoveredBinding, readBinding(), "a missing box must not advance ownership or start a host")
		_, err = runtime.InspectWorkspace(ctx, box.ID)
		require.ErrorIs(t, err, workspaceapi.ErrWorkspaceNotFound)
	}
}
