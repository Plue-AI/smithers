package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Ported from Plue 667fa74fc (smithersai/plue#528): a rollout during
// provisioning must not strand workspaces or sessions pending.

func TestWorkspaceShutdownWaitsForDetachedProvisioning(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	q := provisioningTestQuerier(nil)
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			close(started)
			<-release
			return sandbox.CreateResult{ID: "survivor"}, nil
		},
	}))
	ws := sampleDBWorkspace("survivor")
	ws.Status = "starting"
	ws.VmID = ""
	svc.provisionWorkspaceAsync(context.Background(), ws, CreateWorkspaceSessionInput{})
	<-started
	done := make(chan error, 1)
	go func() { done <- svc.WaitForProvisioning(context.Background()) }()
	select {
	case <-done:
		t.Fatal("API exited with a live provisioner")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	require.NoError(t, <-done)
}

func TestWorkspaceProvisioningResumesRegisteredVM(t *testing.T) {
	q := provisioningTestQuerier(nil)
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Error("restart allocated a second VM")
			return sandbox.CreateResult{}, nil
		},
	}))
	ws := sampleDBWorkspace("survivor")
	ws.Status = "starting"
	ws.VmID = "existing-vm"
	got, err := svc.provisionWorkspaceVM(context.Background(), ws, CreateWorkspaceSessionInput{}, true)
	require.NoError(t, err)
	require.Equal(t, "existing-vm", got.VmID)
	require.Equal(t, "running", got.Status)
}

// Recovery must not reclone a completed repository and erase the user's files.
func TestWorkspaceCloneCheckpointSkipsCompletedBootstrap(t *testing.T) {
	container := os.Getenv("SMITHERS_TEST_GUEST_CONTAINER")
	if container == "" {
		t.Skip("set SMITHERS_TEST_GUEST_CONTAINER to a Linux container with bash and flock")
	}
	dir := fmt.Sprintf("/tmp/clone-checkpoint-%d", time.Now().UnixNano())
	marker := dir + "/state"
	once := workspaceCloneOnce("echo CLONED >> "+dir+"/calls", marker)
	script := "set -e\n" + once + "\n" + once + "\ncat " + dir + "/calls\nrm -rf " + dir
	cmd := exec.Command("docker", "exec", "-i", container, "bash")
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	require.Equal(t, "CLONED\n", string(out))
}

// The same checkpoint on the host shell: a completed bootstrap is skipped and
// a failed one is retried.
func TestWorkspaceCloneCheckpointLocalShell(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	dir := t.TempDir()
	marker := dir + "/state"
	run := func(command string) error {
		return exec.Command(bash, "-c", workspaceCloneOnce(command, marker)).Run()
	}
	require.Error(t, run("echo FAILED >> "+dir+"/calls; exit 3"))
	require.NoError(t, run("echo CLONED >> "+dir+"/calls"))
	require.NoError(t, run("echo CLONED >> "+dir+"/calls"))
	calls, err := os.ReadFile(dir + "/calls")
	require.NoError(t, err)
	require.Equal(t, "FAILED\nCLONED\n", string(calls))
}

type rolloutRecoveryQuerier struct {
	*mockWorkspaceQuerier
	workspace db.Workspace
	mu        sync.Mutex
	completed []string
}

func (q *rolloutRecoveryQuerier) ListWorkspaceProvisioningRecovery(context.Context) ([]db.ListWorkspaceProvisioningRecoveryRow, error) {
	return []db.ListWorkspaceProvisioningRecoveryRow{{ID: q.workspace.ID}}, nil
}
func (q *rolloutRecoveryQuerier) CompletePendingWorkspaceSessions(_ context.Context, id string) ([]string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.completed = append(q.completed, id)
	return nil, nil
}
func (q *rolloutRecoveryQuerier) FindUnregisteredWorkspaceSandbox(context.Context, string) (string, error) {
	return "accepted-before-crash", nil
}

func TestStaleProvisioningReconcilesInsteadOfFailingAfterRestart(t *testing.T) {
	// CI exports SMITHERS_WORKSPACE_JJ_EXPORT_BINARY, a ~50 MB debug build;
	// staging it outlasts the one-second resume bound. Recovery is under test.
	dir := t.TempDir()
	t.Setenv(workspaceCLIPackageEnv, filepath.Join(dir, "missing-cli"))
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(dir, "missing-host"))
	t.Setenv(workspaceJJExportBinaryEnv, filepath.Join(dir, "missing-helper"))
	ws := sampleDBWorkspace("survivor")
	ws.Status = "starting"
	ws.VmID = ""
	ws.UpdatedAt = time.Now().Add(-time.Hour)
	q := &rolloutRecoveryQuerier{mockWorkspaceQuerier: provisioningTestQuerier(nil), workspace: ws}
	q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return ws, nil }
	done := make(chan db.Workspace, 1)
	q.updateWorkspaceExecutionInfoFn = func(_ context.Context, p db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
		current := ws
		current.VmID = p.VmID
		current.Status = p.Status
		if p.Status == "running" {
			done <- current
		}
		return current, nil
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Error("recovery allocated duplicate VM")
			return sandbox.CreateResult{}, nil
		},
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{State: sandbox.StateRunning}, nil
		},
	}))
	require.NoError(t, svc.CleanupStalePendingWorkspaces(context.Background()))
	select {
	case got := <-done:
		require.Equal(t, "accepted-before-crash", got.VmID)
	case <-time.After(time.Second):
		t.Fatal("stale workspace was not resumed")
	}
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
	require.Equal(t, []string{ws.ID}, q.completed, "recovered sessions settle once the workspace runs")
}

func TestProvisionReplayNeverDeletesItsRegisteredVM(t *testing.T) {
	q := &registrarWorkspaceQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, state: sampleDBWorkspace("replay")}
	q.state.Status = "running"
	q.state.VmID = "same-vm"
	q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return q.state, nil }
	var deleted []string
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{deleteVMFn: func(_ context.Context, id string) error { deleted = append(deleted, id); return nil }}))
	got, _, err := svc.registerNewWorkspaceVM(context.Background(), q.state, "same-vm", "starting")
	require.NoError(t, err)
	require.Equal(t, "same-vm", got.VmID)
	require.Empty(t, deleted)
}

// A running workspace with pending sessions is settled without reprovisioning.
func TestReconcileCompletesPendingSessionsOnRunningWorkspace(t *testing.T) {
	ws := sampleDBWorkspace("running-box")
	ws.Status = "running"
	q := &rolloutRecoveryQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, workspace: ws}
	q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return ws, nil }
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			t.Error("a running workspace was reprovisioned")
			return sandbox.CreateResult{}, nil
		},
	}))
	require.NoError(t, svc.ReconcileWorkspaceProvisioning(context.Background()))
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
	require.Equal(t, []string{ws.ID}, q.completed)
}

// Repeated ticks while one provisioner runs start no second provisioner.
func TestReconcileDeduplicatesInFlightProvisioning(t *testing.T) {
	ws := sampleDBWorkspace("slow")
	ws.Status = "starting"
	ws.VmID = ""
	q := &rolloutRecoveryQuerier{mockWorkspaceQuerier: provisioningTestQuerier(nil), workspace: ws}
	q.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return ws, nil }
	var finds atomic.Int32
	release := make(chan struct{})
	svc := newWorkspaceServiceForTests(&countingAdoptionQuerier{rolloutRecoveryQuerier: q, finds: &finds, release: release}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	for range 5 {
		require.NoError(t, svc.ReconcileWorkspaceProvisioning(context.Background()))
	}
	close(release)
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
	require.Equal(t, int32(1), finds.Load())
}

type countingAdoptionQuerier struct {
	*rolloutRecoveryQuerier
	finds   *atomic.Int32
	release chan struct{}
}

func (q *countingAdoptionQuerier) FindUnregisteredWorkspaceSandbox(context.Context, string) (string, error) {
	q.finds.Add(1)
	<-q.release
	return "", errors.New("stop after dedupe check")
}

func TestRunWorkspaceProvisioningReconcilerRepeatsAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	done := make(chan struct{})
	go func() {
		runWorkspaceProvisioningReconciler(ctx, 5*time.Millisecond, func(context.Context) error {
			if calls.Add(1) == 2 {
				panic("one bad tick")
			}
			return errors.New("transient")
		})
		close(done)
	}()
	require.Eventually(t, func() bool { return calls.Load() >= 3 }, time.Second, time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reconciler did not stop")
	}
}

// Ownership is a real advisory lock: a second process sees a retryable
// in-progress error until the owner's transaction ends.
func TestWorkspaceProvisionLockPostgresOwnership(t *testing.T) {
	pool := getAgentTestPool(t)
	ws := sampleDBWorkspace("7f0c1c1e-5d1c-4a55-9d3e-6c2b1f0a0528")
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return ws, nil }}
	owner := newWorkspaceServiceForTests(q, WithWorkspaceTransactions(pool))
	other := newWorkspaceServiceForTests(q, WithWorkspaceTransactions(pool))
	ctx := context.Background()
	_, err := owner.withWorkspaceProvisionLock(ctx, ws, func(current db.Workspace) (db.Workspace, error) {
		_, contended := other.withWorkspaceProvisionLock(ctx, ws, func(db.Workspace) (db.Workspace, error) {
			t.Error("two processes owned one workspace's provisioning")
			return ws, nil
		})
		require.ErrorIs(t, contended, errWorkspaceProvisionInProgress)
		require.True(t, isWorkspaceGuestNotReady(contended), "callers get a retryable guest_not_ready")
		return current, nil
	})
	require.NoError(t, err)
	ran := false
	_, err = other.withWorkspaceProvisionLock(ctx, ws, func(current db.Workspace) (db.Workspace, error) {
		ran = true
		return current, nil
	})
	require.NoError(t, err)
	require.True(t, ran, "ownership ends with the owner's transaction")
}
