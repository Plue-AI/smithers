//go:build unix

package process

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestRuntimeDuplicateServiceStartWaitsForReadiness(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "readiness"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	address := reserveTestAddress(t)
	command := helperCommand("serve", map[string]string{"SMITHERS_TEST_ADDRESS": address})
	command.Args = append([]string{"/bin/sh", "-c", `while [ ! -f start.ready ]; do sleep 0.01; done; exec "$@"`, "service"}, command.Args...)
	spec := workspaceapi.ServiceSpec{Name: "delayed", Command: command, ReadyAddress: address, ReadyTimeout: 2 * time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() {
		_, err := runtime.StartService(ctx, workspace.ID, spec)
		finished <- err
	}()
	joined := false
	defer func() {
		cancel()
		if joined {
			return
		}
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("service launch did not settle")
		}
	}()
	require.Eventually(t, func() bool {
		runtime.mu.Lock()
		defer runtime.mu.Unlock()
		return runtime.workspaces[workspace.ID].services[spec.Name] != nil
	}, time.Second, time.Millisecond)

	duplicateCtx, duplicateCancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer duplicateCancel()
	_, err = runtime.StartService(duplicateCtx, workspace.ID, spec)
	require.ErrorIs(t, err, context.DeadlineExceeded, "duplicate start must not report a service ready before its listener opens")
	observed, err := runtime.InspectService(context.Background(), workspace.ID, spec.Name)
	require.NoError(t, err)
	require.Equal(t, workspaceapi.ServiceRunning, observed.State, "a cancelled duplicate must not stop the original launch")

	require.NoError(t, runtime.WriteFile(context.Background(), workspace.ID, "start.ready", nil, 0o600))
	select {
	case err := <-finished:
		joined = true
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("service did not become ready after opening its gate")
	}
	duplicate, err := runtime.StartService(context.Background(), workspace.ID, spec)
	require.NoError(t, err)
	require.Equal(t, observed.PID, duplicate.PID)
}

// A service that exits before it listens reports its exit status, so an
// operator reading the startup failure sees why (smithersai/smithers#2472).
// The status is the whole of it: stderr stays in InspectService.
func TestRuntimeServiceExitBeforeListeningReportsItsExitStatus(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "early-exit"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	command := helperCommand("serve", nil)
	command.Args = []string{"/bin/sh", "-c", "echo secret-detail >&2; exit 23"}
	spec := workspaceapi.ServiceSpec{Name: "host", Command: command, ReadyAddress: reserveTestAddress(t), ReadyTimeout: 5 * time.Second}
	_, err = runtime.StartService(context.Background(), workspace.ID, spec)
	require.ErrorContains(t, err, "process exited before accepting connections")
	require.ErrorContains(t, err, "exit status 23")
	require.NotContains(t, err.Error(), "secret-detail")
}
