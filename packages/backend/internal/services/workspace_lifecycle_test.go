package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Microsandbox auto-suspends idle VMs, so the idle sweeper (and manual suspend)
// routinely races it: SuspendSandbox answers 400 "VM is not running". That is the
// desired end state — the workspace MUST still be marked suspended, or its row
// stays 'running' forever and permanently holds a concurrent-sandbox quota
// slot (three leaks bricked all provisioning for a user in prod, 2026-07-05).
func TestWorkspaceService_SuspendWorkspace_ReconcilesAlreadyStoppedVM(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "vm not running", err: &sandbox.StatusError{StatusCode: 400, Message: "VM is not running: abc123"}},
		{name: "vm gone", err: &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			statusUpdates := 0
			q := &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
					workspace := sampleDBWorkspace(arg.ID)
					workspace.Status = "running"
					workspace.VmID = "vm-zombie"
					if statusUpdates > 0 {
						workspace.Status = "suspended"
					}
					return workspace, nil
				},
				suspendRunningWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
					statusUpdates++
					workspace := sampleDBWorkspace(id)
					workspace.VmID = "vm-zombie"
					workspace.Status = "suspended"
					return workspace, nil
				},
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				suspendVMFn: func(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
					return sandbox.SuspendResult{}, tc.err
				},
			}))

			workspace, err := svc.SuspendWorkspace(context.Background(), "ws-zombie", 101, 1)
			require.NoError(t, err)
			assert.Equal(t, "suspended", workspace.Status)
			assert.Equal(t, 1, statusUpdates, "the quota-holding row must be reconciled to suspended")
		})
	}
}

// Two concurrent suspends of the same running workspace (e.g. a user hitting
// SuspendWorkspace while the idle sweeper reclaims it) must decrement the
// active-VM gauge exactly once. Only the caller that WINS the running->suspended
// CAS decrements; the loser (whose SuspendSandbox answers "not running" and whose CAS
// returns pgx.ErrNoRows) must not, or the gauge drifts negative.
func TestWorkspaceService_SuspendWorkspace_DecrementsGaugeExactlyOnceUnderRace(t *testing.T) {
	t.Parallel()

	var gauge float64
	metrics := &mockSandboxMetricsRecorder{addActiveVMsFn: func(vmType string, delta float64) {
		if vmType == "workspace" {
			gauge += delta
		}
	}}

	// First call wins the CAS; second call loses it (pgx.ErrNoRows) and its VM
	// is already stopped.
	casWon := false
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.Status = "running" // both callers read a stale 'running'
			ws.VmID = "vm-race"
			return ws, nil
		},
		suspendRunningWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
			if casWon {
				return db.Workspace{}, pgx.ErrNoRows
			}
			casWon = true
			ws := sampleDBWorkspace(id)
			ws.Status = "suspended"
			return ws, nil
		},
	}
	suspendCalls := 0
	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxMetrics(metrics),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			suspendVMFn: func(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
				suspendCalls++
				if suspendCalls == 1 {
					return sandbox.SuspendResult{}, nil
				}
				return sandbox.SuspendResult{}, &sandbox.StatusError{StatusCode: 400, Message: "VM is not running"}
			},
		}))

	_, err := svc.SuspendWorkspace(context.Background(), "ws-race", 101, 1)
	require.NoError(t, err)
	_, err = svc.SuspendWorkspace(context.Background(), "ws-race", 101, 1)
	require.NoError(t, err)

	assert.Equal(t, float64(-1), gauge, "the gauge must be decremented exactly once across both suspends")
}

// Suspending a workspace that never held a +1 (status 'failed', VM already
// reclaimed) must not decrement the gauge — the CAS matches no 'running' row.
func TestWorkspaceService_SuspendWorkspace_NonRunningDoesNotDecrement(t *testing.T) {
	t.Parallel()

	var gauge float64
	metrics := &mockSandboxMetricsRecorder{addActiveVMsFn: func(vmType string, delta float64) {
		if vmType == "workspace" {
			gauge += delta
		}
	}}
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.Status = "failed"
			ws.VmID = "vm-failed"
			return ws, nil
		},
		suspendRunningWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows // no 'running' row to flip
		},
	}
	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxMetrics(metrics),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			suspendVMFn: func(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
				return sandbox.SuspendResult{}, &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
			},
		}))

	_, err := svc.SuspendWorkspace(context.Background(), "ws-failed", 101, 1)
	require.NoError(t, err)
	assert.Equal(t, float64(0), gauge, "a non-running workspace must not move the active-VM gauge")
}

// A genuinely failing suspend (Microsandbox 5xx) must still surface as an error —
// only the already-stopped states are reconciled.
func TestWorkspaceService_SuspendWorkspace_RealFailureStillErrors(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = "running"
			workspace.VmID = "vm-broken"
			return workspace, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		suspendVMFn: func(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
			return sandbox.SuspendResult{}, &sandbox.StatusError{StatusCode: 500, Message: "internal"}
		},
	}))

	_, err := svc.SuspendWorkspace(context.Background(), "ws-broken", 101, 1)
	require.Error(t, err)
}

// A resume must NOT wait for the provider ready signal: it is a one-shot that
// fires only on first boot. NixOS guests use a separate in-guest activation
// probe after StartSandbox; this container case remains immediate.
func TestWorkspaceService_ResumeWorkspace_DoesNotWaitForReady(t *testing.T) {
	t.Parallel()

	var markedResumed db.MarkWorkspaceResumedParams
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = "suspended"
			workspace.VmID = "vm-suspended"
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-suspended"
			workspace.Status = arg.Status
			return workspace, nil
		},
		markWorkspaceResumedFn: func(_ context.Context, arg db.MarkWorkspaceResumedParams) error {
			markedResumed = arg
			return nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
			assert.Equal(t, "vm-suspended", vmID)
			require.NotNil(t, req.WaitForReady)
			assert.False(t, *req.WaitForReady, "resume must not wait for the never-re-firing ready signal")
			return sandbox.StartResult{ID: vmID}, nil
		},
	}))

	workspace, err := svc.ResumeWorkspace(context.Background(), "ws-suspended", 101, 1)
	require.NoError(t, err)
	assert.Equal(t, "running", workspace.Status)
	assert.Equal(t, "ws-suspended", markedResumed.ID)
	assert.False(t, markedResumed.ResumedAt.IsZero())
	require.NotNil(t, workspace.StartedAt)
	require.NotNil(t, workspace.ResumedAt)
}

func TestWorkspaceService_ResumeWorkspaceDoesNotMarkNixGuestRunningBeforeActivation(t *testing.T) {
	resumeMarkedRunning := false
	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = "suspended"
			workspace.Kind = "vm"
			workspace.VmID = "vm-nix-starting"
			return workspace, nil
		},
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			resumeMarkedRunning = true
			return db.Workspace{}, nil
		},
	}
	status := int32(75)
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: "vm-nix-starting", State: sandbox.StateStopped}, nil
		},
		startVMFn: func(_ context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{ID: vmID}, nil
		},
		execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-nix-starting", vmID)
			assert.Contains(t, req.Command, "systemctl is-system-running")
			return sandbox.ExecResult{StatusCode: &status}, nil
		},
	}))

	_, err := svc.ResumeWorkspace(context.Background(), "ws-nix", 101, 1)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeGuestNotReady, apiErr.Code)
	assert.False(t, resumeMarkedRunning, "workspace status must remain suspended until guest activation")
}

func TestWorkspaceService_ResumeWorkspace_ReturnsRetryableFailureOnResumeTimeout(t *testing.T) {
	t.Parallel()

	q := &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = "suspended"
			workspace.VmID = "vm-suspended"
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
			return sandbox.StartResult{}, context.DeadlineExceeded
		},
	}))

	_, err := svc.ResumeWorkspace(context.Background(), "ws-suspended", 101, 1)
	require.Error(t, err)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, 503, apiErr.Status)
	assert.Positive(t, apiErr.RetryAfter)
}

func TestWorkspaceService_CleanupStalePendingWorkspaces_FailsZombies(t *testing.T) {
	t.Parallel()

	var updated []string
	q := &mockWorkspaceQuerier{
		listStalePendingWorkspacesFn: func(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error) {
			require.Equal(t, int32(workspaceStaleAfter/time.Second), staleAfterSecs)
			first := sampleDBWorkspace("ws-stale-1")
			first.Status = "pending"
			first.VmID = ""
			second := sampleDBWorkspace("ws-stale-2")
			second.Status = "starting"
			second.VmID = ""
			return []db.Workspace{first, second}, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updated = append(updated, arg.ID+":"+arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = arg.Status
			workspace.VmID = ""
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q)
	require.NoError(t, svc.CleanupStalePendingWorkspaces(context.Background()))
	assert.Equal(t, []string{"ws-stale-1:failed", "ws-stale-2:failed"}, updated)
}

// A workspace whose Microsandbox VM was reclaimed out-of-band must still be
// deletable: a 404 from DeleteSandbox is the desired terminal state, so destroy must
// proceed to soft-delete rather than 500 and leave the row holding its
// concurrent-sandbox quota slot forever ("delete one to continue" must hold).
func TestWorkspaceService_DestroyWorkspace_ToleratesAlreadyGoneVM(t *testing.T) {
	t.Parallel()

	softDeleted := false
	q := &mockWorkspaceQuerier{
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			ws := sampleDBWorkspace(id)
			ws.VmID = "vm-gone"
			ws.Status = "running"
			return ws, nil
		},
		softDeleteWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			softDeleted = true
			return sampleDBWorkspace(id), nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(_ context.Context, _ string) error {
			return &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
		},
	}))

	require.NoError(t, svc.DestroyWorkspace(context.Background(), "ws-1"),
		"a 404 (VM already gone) must not block soft-delete")
	assert.True(t, softDeleted, "workspace must be soft-deleted so its quota slot is freed")
}

// A genuine (non-404) VM delete failure must still fail the destroy and leave
// the row intact, so we never orphan a live VM by soft-deleting its workspace.
func TestWorkspaceService_DestroyWorkspace_PropagatesRealVMDeleteError(t *testing.T) {
	t.Parallel()

	softDeleted := false
	q := &mockWorkspaceQuerier{
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			ws := sampleDBWorkspace(id)
			ws.VmID = "vm-live"
			ws.Status = "running"
			return ws, nil
		},
		softDeleteWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			softDeleted = true
			return sampleDBWorkspace(id), nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(_ context.Context, _ string) error {
			return &sandbox.StatusError{StatusCode: 500, Message: "internal"}
		},
	}))

	require.Error(t, svc.DestroyWorkspace(context.Background(), "ws-1"),
		"a non-404 delete error must fail the destroy")
	assert.False(t, softDeleted, "workspace must not be soft-deleted when VM delete genuinely fails")
}
