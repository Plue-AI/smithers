package flowhost

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A machine that never writes its initialization receipt held the install's
// only slot through 18 workspace_initializing refusals (run 12, learning
// machine 1b01c924). An authority that names its own source pins nothing from
// the partial checkout, so each refusal is a failed start on its binding and
// the start bound ends the wait with the disk-preserving release.
func TestPostgresNeverInitializedMachineExhaustsStartBound(t *testing.T) {
	type fixture struct {
		pool        *pgxpool.Pool
		resolver    *Resolver
		launcher    *boundedStartLauncher
		base        *memoryLauncher
		authority   Authority
		initialized *bool
		checks      *int
	}
	setup := func(t *testing.T, named bool) fixture {
		pool := hostTestPool(t)
		authority, catalog := hostFixture(t, pool)
		revision := authority.SourceRevision
		if !named {
			authority.SourceRevision = ""
		}
		store, err := NewStore(pool, testCodec{})
		require.NoError(t, err)
		initialized, checks := false, 0
		store.BindWorkspaceInitialized(func(_ context.Context, got Authority) error {
			require.Equal(t, authority.WorkspaceID, got.WorkspaceID)
			checks++
			if initialized {
				return nil
			}
			return failure{code: "workspace_initializing", retryable: true}
		})
		base := &memoryLauncher{transport: &identityTransport{}, isolation: workspaceapi.IsolationSandboxed}
		launcher := &boundedStartLauncher{snapshotLauncher: &snapshotLauncher{memoryLauncher: base, revision: revision}}
		resolver, err := New(Config{Store: store, Launcher: launcher, Catalogs: []Catalog{catalog},
			Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) { return authority, nil })})
		require.NoError(t, err)
		return fixture{pool: pool, resolver: resolver, launcher: launcher, base: base, authority: authority, initialized: &initialized, checks: &checks}
	}
	refusal := func(t *testing.T, f fixture) flowruntime.Failure {
		t.Helper()
		_, err := f.resolver.ResolveFlowRuntime(t.Context(), f.authority.Target)
		var known flowruntime.Failure
		require.ErrorAs(t, err, &known)
		return known
	}
	binding := func(t *testing.T, f fixture) (state, code string, failures int) {
		t.Helper()
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT state,last_error_code,start_failures FROM flow_runtime_host_bindings WHERE workspace_id=$1`, f.authority.WorkspaceID).Scan(&state, &code, &failures))
		return state, code, failures
	}

	t.Run("never initializes", func(t *testing.T) {
		f := setup(t, true)
		for attempt := 1; attempt < MaxStartFailures; attempt++ {
			known := refusal(t, f)
			require.Equal(t, "workspace_initializing", known.FlowRuntimeCode())
			require.True(t, known.FlowRuntimeRetryable(), "attempt %d waits", attempt)
		}
		require.Zero(t, f.launcher.releases)
		known := refusal(t, f)
		require.Equal(t, "runtime_start_exhausted", known.FlowRuntimeCode())
		require.False(t, known.FlowRuntimeRetryable(), "the bound turns the wait into a failed start")
		require.Equal(t, 1, f.launcher.releases, "the machine stops, keeping its disk, and its slot is free")
		state, code, failures := binding(t, f)
		require.Equal(t, []any{"failed", "runtime_start_exhausted", MaxStartFailures}, []any{state, code, failures})
		// A late receipt never revives the exhausted binding.
		*f.initialized = true
		checks := *f.checks
		require.Equal(t, "runtime_start_exhausted", refusal(t, f).FlowRuntimeCode())
		require.Equal(t, checks, *f.checks, "an exhausted binding is not checked again")
		require.Empty(t, f.base.starts, "no host starts on a machine that never initialized")
		require.Zero(t, f.launcher.captures, "a partial checkout's source is never read")
	})

	t.Run("initializes within the bound", func(t *testing.T) {
		f := setup(t, true)
		require.Equal(t, "workspace_initializing", refusal(t, f).FlowRuntimeCode())
		*f.initialized = true
		_, err := f.resolver.ResolveFlowRuntime(t.Context(), f.authority.Target)
		require.NoError(t, err)
		require.Len(t, f.base.starts, 1)
		require.Equal(t, f.authority.SourceRevision, f.base.starts[0].Binding.SourceRevision)
		state, _, failures := binding(t, f)
		require.Equal(t, "running", state)
		require.Equal(t, 1, failures, "the wait counted as one failed start")
		require.Zero(t, f.launcher.releases)
	})

	t.Run("an unnamed source never binds a partial checkout", func(t *testing.T) {
		f := setup(t, false)
		for attempt := 0; attempt <= MaxStartFailures; attempt++ {
			known := refusal(t, f)
			require.Equal(t, "workspace_initializing", known.FlowRuntimeCode())
			require.True(t, known.FlowRuntimeRetryable())
		}
		var count int
		require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM flow_runtime_host_bindings WHERE workspace_id=$1`, f.authority.WorkspaceID).Scan(&count))
		require.Zero(t, count)
		require.Zero(t, f.launcher.captures)
		require.Zero(t, f.launcher.releases)
	})
}
