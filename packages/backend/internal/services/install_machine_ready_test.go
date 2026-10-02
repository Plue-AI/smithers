package services

import (
	"context"
	"errors"
	"io/fs"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

const readinessCommit = "0123456789abcdef0123456789abcdef01234567"

type readinessSources struct {
	resolve func(context.Context, string, string) (string, error)
}

func (s readinessSources) ResolveSourceRevision(ctx context.Context, repo, rev string) (string, error) {
	return s.resolve(ctx, repo, rev)
}
func (readinessSources) ReadSourceFile(context.Context, workspaceapi.WorkspaceSource, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}

type readinessLayers func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error)

func (f readinessLayers) ResolveWorkspaceLayer(ctx context.Context, s workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	return f(ctx, s)
}

type readinessMemory struct {
	mu     sync.Mutex
	state  InstallReadiness
	events []InstallReadiness
}

func (m *readinessMemory) Update(_ context.Context, _ string, f func(InstallReadiness) (InstallReadiness, error)) (InstallReadiness, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, err := f(m.state)
	if err != nil {
		return m.state, err
	}
	m.state = next
	m.events = append(m.events, next)
	return next, nil
}

// Spec oracle (§8.6.3): Source ready means the mirror holds main; Machine ready
// means the first recipe for main is built. §19.3 forbids exposing state before
// its event exists. The expected receipts are pending -> running -> ready for
// the machine, with Source ready already committed when its build starts.
func TestInstallMachineReadySourcePrecedesVerifiedMachine(t *testing.T) {
	store := &readinessMemory{}
	svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(_ context.Context, repo, rev string) (string, error) {
		require.Equal(t, "owner/repo", repo)
		require.Equal(t, "main", rev)
		return readinessCommit, nil
	}}}
	calls := 0
	svc.Layers = readinessLayers(func(_ context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		calls++
		require.Equal(t, readinessCommit, spec.Source.Revision)
		require.Equal(t, "owner/repo", spec.Source.Repository)
		require.Equal(t, InstallReady, store.state.Source.State)
		require.Equal(t, 100, store.state.Source.Pct)
		require.Equal(t, InstallRunning, store.state.Machine.State)
		require.Zero(t, store.state.Machine.Pct)
		return microsandbox.Layer{Key: "verified-layer"}, nil
	})
	state, err := svc.Prepare(t.Context(), "owner/repo")
	require.NoError(t, err)
	require.Equal(t, InstallReady, state.Source.State)
	require.Equal(t, InstallReady, state.Machine.State)
	require.Equal(t, 100, state.Machine.Pct)
	_, err = svc.Prepare(t.Context(), "owner/repo")
	require.NoError(t, err)
	require.Equal(t, 2, calls, "each attempt must resolve the current cached recipe")
}

// Spec oracle (§8.6.3, §19.3): missing main cannot produce Source ready or start
// a machine build; failed verification leaves Source ready and Machine failed.
func TestInstallMachineReadyMissingMainAndFailedVerification(t *testing.T) {
	for _, tc := range []struct {
		name, commit              string
		sourceErr, buildErr       error
		layer                     microsandbox.Layer
		sourceState, machineState InstallStepState
		code                      string
	}{
		{name: "missing main", sourceErr: fs.ErrNotExist, sourceState: InstallFailed, machineState: InstallPending, code: "source_main_unavailable"},
		{name: "invalid main", commit: "main", sourceState: InstallFailed, machineState: InstallPending, code: "source_main_invalid"},
		{name: "verification failed", commit: readinessCommit, buildErr: errors.New("offline verify failed"), sourceState: InstallReady, machineState: InstallFailed, code: "machine_build_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &readinessMemory{}
			calls := 0
			svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) { return tc.commit, tc.sourceErr }}, Layers: readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
				calls++
				return tc.layer, tc.buildErr
			})}
			state, err := svc.Prepare(t.Context(), "owner/repo")
			require.Error(t, err)
			var typed *InstallReadinessError
			require.ErrorAs(t, err, &typed)
			require.Equal(t, tc.code, typed.Code)
			require.Equal(t, "infra", typed.Class)
			require.Equal(t, typed.Message, typed.Error())
			require.Equal(t, tc.sourceState, state.Source.State)
			require.Equal(t, tc.machineState, state.Machine.State)
			if tc.sourceState == InstallFailed {
				require.Zero(t, calls)
				require.Zero(t, state.Source.Pct)
			} else {
				require.Equal(t, 100, state.Source.Pct)
				require.Equal(t, typed, state.Machine.Error)
			}
		})
	}
}

func TestInstallMachineReadyBaseOnlyAndRecipeError(t *testing.T) {
	for _, failure := range []error{nil, &microsandbox.RecipeError{Class: "user", Code: "recipe_dependencies_failed", Message: "Public registries only", Fix: "Use a public registry"}} {
		store := &readinessMemory{}
		svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) { return readinessCommit, nil }}, Layers: readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
			return microsandbox.Layer{}, failure
		})}
		state, err := svc.Prepare(t.Context(), "owner/repo")
		if failure == nil {
			require.NoError(t, err)
			require.Equal(t, InstallReady, state.Machine.State)
			require.Empty(t, state.LayerKey)
		} else {
			var typed *InstallReadinessError
			require.ErrorAs(t, err, &typed)
			require.Equal(t, "user", typed.Class)
			require.Equal(t, "recipe_dependencies_failed", typed.Code)
			require.Equal(t, "Use a public registry", state.Machine.Error.Fix)
		}
	}
}

func TestInstallMachineReadyStaleBuildCannotOverwriteNewRevision(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	store := &readinessMemory{}
	started := make(chan struct{})
	release := make(chan struct{})
	newRevision := "fedcba9876543210fedcba9876543210fedcba98"
	var resolveMu sync.Mutex
	resolves := 0
	svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) {
		resolveMu.Lock()
		defer resolveMu.Unlock()
		resolves++
		if resolves == 1 {
			return readinessCommit, nil
		}
		return newRevision, nil
	}}, Layers: readinessLayers(func(ctx context.Context, spec workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		if spec.Source.Revision == readinessCommit {
			close(started)
			select {
			case <-release:
				return microsandbox.Layer{}, errors.New("old verify failure")
			case <-ctx.Done():
				return microsandbox.Layer{}, ctx.Err()
			}
		}
		return microsandbox.Layer{Key: "new-layer"}, nil
	})}
	done := make(chan error, 1)
	go func() { _, err := svc.Prepare(ctx, "owner/repo"); done <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	state, err := svc.Prepare(ctx, "owner/repo")
	require.NoError(t, err)
	require.Equal(t, newRevision, state.Revision)
	require.Equal(t, "new-layer", state.LayerKey)
	close(release)
	select {
	case err := <-done:
		require.ErrorIs(t, err, ErrInstallReadinessSuperseded)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	require.Equal(t, state, store.state)
	require.Equal(t, InstallReady, store.state.Machine.State)
}

func TestInstallMachineReadyCancellationIsPersistedAndRetryable(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	store := &readinessMemory{}
	svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) { return readinessCommit, nil }}, Layers: readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		cancel()
		return microsandbox.Layer{}, nil
	})}
	state, err := svc.Prepare(ctx, "owner/repo")
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, InstallReady, state.Source.State)
	require.Equal(t, InstallFailed, state.Machine.State)
	require.Equal(t, "user", state.Machine.Error.Class)
	svc.Layers = readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		return microsandbox.Layer{Key: "retried"}, nil
	})
	state, err = svc.Prepare(t.Context(), "owner/repo")
	require.NoError(t, err)
	require.Equal(t, InstallReady, state.Machine.State)
	require.Nil(t, state.Machine.Error)
}

func TestInstallMachineReadyConfigurationAndCommitBoundaries(t *testing.T) {
	for _, revision := range []string{"", readinessCommit[:39], readinessCommit + "0", "0123456789ABCDEF0123456789abcdef01234567", "0123456789abcdef0123456789abcdef0123456z"} {
		require.False(t, installMainCommit(revision))
	}
	require.True(t, installMainCommit(readinessCommit))
	svc := InstallMachineReadyService{}
	_, err := svc.Prepare(t.Context(), "owner/repo")
	var typed *InstallReadinessError
	require.ErrorAs(t, err, &typed)
	require.Equal(t, "install_readiness_unavailable", typed.Code)
}

type readinessFailingStore struct {
	readinessMemory
	calls, failAt int
	failure       error
}

func (s *readinessFailingStore) Update(ctx context.Context, repository string, mutate func(InstallReadiness) (InstallReadiness, error)) (InstallReadiness, error) {
	s.calls++
	if s.calls == s.failAt {
		return s.state, s.failure
	}
	return s.readinessMemory.Update(ctx, repository, mutate)
}

func TestInstallMachineReadyPersistenceFailuresNeverClaimCompletion(t *testing.T) {
	for _, tc := range []struct {
		name            string
		failAt          int
		buildErr        error
		expectedMachine InstallStepState
	}{
		{"start", 1, nil, ""}, {"source receipt", 2, nil, InstallPending}, {"machine receipt", 3, nil, InstallRunning}, {"failure receipt", 3, errors.New("verify failed"), InstallRunning},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure := errors.New("storage unavailable")
			store := &readinessFailingStore{failAt: tc.failAt, failure: failure}
			builds := 0
			svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) { return readinessCommit, nil }}, Layers: readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
				builds++
				return microsandbox.Layer{Key: "built"}, tc.buildErr
			})}
			state, err := svc.Prepare(t.Context(), "owner/repo")
			require.ErrorIs(t, err, failure)
			require.Equal(t, tc.expectedMachine, state.Machine.State)
			require.Equal(t, store.state, state)
			if tc.failAt < 3 {
				require.Zero(t, builds)
			} else {
				require.Equal(t, 1, builds)
			}
		})
	}
}

func TestInstallMachineReadySameRevisionRechecksChangedRecipe(t *testing.T) {
	for _, changed := range []string{"detector", "manifest"} {
		t.Run(changed, func(t *testing.T) {
			store := &readinessMemory{}
			calls := 0
			svc := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) { return readinessCommit, nil }}, Layers: readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
				calls++
				require.Equal(t, InstallRunning, store.state.Machine.State)
				require.Empty(t, store.state.LayerKey, "old recipe is not a ready receipt for the new attempt")
				return microsandbox.Layer{Key: changed + "-" + string(rune('0'+calls))}, nil
			})}
			first, err := svc.Prepare(t.Context(), "owner/repo")
			require.NoError(t, err)
			second, err := svc.Prepare(t.Context(), "owner/repo")
			require.NoError(t, err)
			require.Equal(t, 2, calls)
			require.Equal(t, first.Revision, second.Revision)
			require.NotEqual(t, first.LayerKey, second.LayerKey)
			require.Equal(t, InstallReady, second.Machine.State)
			failure := errors.New("updated recipe verification failed")
			svc.Layers = readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
				return microsandbox.Layer{}, failure
			})
			failed, err := svc.Prepare(t.Context(), "owner/repo")
			require.ErrorIs(t, err, failure)
			require.Equal(t, InstallFailed, failed.Machine.State)
			require.Equal(t, InstallReady, failed.Source.State)
			require.Empty(t, failed.LayerKey)
		})
	}
}
