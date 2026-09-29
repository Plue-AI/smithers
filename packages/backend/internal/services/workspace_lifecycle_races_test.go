package services

// Regression tests for the workspace state-machine race fixes (issues #313,
// #312, #240, #115, #114, #113, #296): CAS-guarded session/workspace
// transitions, gauge pairing, reprovision row reset, and the stranded-starting
// reaper.

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	sandbox "github.com/smithersai/smithers/packages/backend/sandbox"
)

// workspaceRaceMetricsRecorder captures active-VM gauge deltas for the
// gauge-pairing assertions in this file.
type workspaceRaceMetricsRecorder struct {
	deltas []float64
}

func (m *workspaceRaceMetricsRecorder) ObserveSandboxVMCreate(string, string, float64) {}

func (m *workspaceRaceMetricsRecorder) AddSandboxActiveVMs(_ string, delta float64) {
	m.deltas = append(m.deltas, delta)
}

func (m *workspaceRaceMetricsRecorder) ObserveSandboxVMSuspend(float64) {}

// Issue #114: deleting a suspended workspace must not decrement the active-VM
// gauge again — suspend already paid the -1 on the running->suspended CAS.
func TestDestroyWorkspace_GaugeDecrementOnlyWhenRunning(t *testing.T) {
	t.Parallel()

	t.Run("suspended workspace does not decrement", func(t *testing.T) {
		t.Parallel()
		metrics := &workspaceRaceMetricsRecorder{}
		q := &mockWorkspaceQuerier{
			suspendRunningWorkspaceFn: func(ctx context.Context, id string) (db.Workspace, error) {
				return db.Workspace{}, pgx.ErrNoRows
			},
		}
		svc := newWorkspaceServiceForTests(q,
			WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}),
			WithWorkspaceSandboxMetrics(metrics),
		)

		ws := sampleDBWorkspace("ws-114")
		ws.Status = "suspended"
		require.NoError(t, svc.destroyWorkspace(context.Background(), ws))
		assert.Empty(t, metrics.deltas)
	})

	t.Run("running workspace decrements exactly once", func(t *testing.T) {
		t.Parallel()
		metrics := &workspaceRaceMetricsRecorder{}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
			WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}),
			WithWorkspaceSandboxMetrics(metrics),
		)

		require.NoError(t, svc.destroyWorkspace(context.Background(), sampleDBWorkspace("ws-114b")))
		assert.Equal(t, []float64{-1}, metrics.deltas)
	})
}

// Issue #115: only the resume that wins the CAS into 'running' may increment
// the active-VM gauge; a racing loser must not add a second +1 for one VM.
func TestResumeWorkspaceVM_GaugeIncrementOnlyOnCASWin(t *testing.T) {
	t.Parallel()

	t.Run("lost CAS does not increment", func(t *testing.T) {
		t.Parallel()
		metrics := &workspaceRaceMetricsRecorder{}
		q := &mockWorkspaceQuerier{
			resumeWorkspaceToRunningFn: func(ctx context.Context, id string) (db.Workspace, error) {
				return db.Workspace{}, pgx.ErrNoRows
			},
		}
		svc := newWorkspaceServiceForTests(q,
			WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}),
			WithWorkspaceSandboxMetrics(metrics),
		)

		ws := sampleDBWorkspace("ws-115")
		ws.Status = "suspended"
		updated, err := svc.resumeWorkspaceVM(context.Background(), ws)
		require.NoError(t, err)
		assert.Equal(t, "running", updated.Status)
		assert.Empty(t, metrics.deltas)
	})

	t.Run("won CAS increments exactly once", func(t *testing.T) {
		t.Parallel()
		metrics := &workspaceRaceMetricsRecorder{}
		svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
			WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}),
			WithWorkspaceSandboxMetrics(metrics),
		)

		ws := sampleDBWorkspace("ws-115b")
		ws.Status = "suspended"
		updated, err := svc.resumeWorkspaceVM(context.Background(), ws)
		require.NoError(t, err)
		assert.Equal(t, "running", updated.Status)
		assert.Equal(t, []float64{1}, metrics.deltas)
	})
}

// Issue #313: a detached provisioning goroutine must not resurrect a session
// the user already stopped, and must hand back the workspace it brought up.
func TestFinishWorkspaceSessionProvisioning_DoesNotResurrectStoppedSession(t *testing.T) {
	t.Parallel()

	var sessionStatusWrites []string
	var suspendedVMs []string
	stopped := db.WorkspaceSession{ID: "sess-313", WorkspaceID: "ws-313", RepositoryID: 101, UserID: 1, Status: "stopped"}
	q := &mockWorkspaceQuerier{
		markWorkspaceSessionRunningFn: func(ctx context.Context, id string) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{}, pgx.ErrNoRows
		},
		updateWorkspaceSessionStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			sessionStatusWrites = append(sessionStatusWrites, arg.Status)
			return db.WorkspaceSession{ID: arg.ID, Status: arg.Status}, nil
		},
		getWorkspaceSessionFn: func(ctx context.Context, id string) (db.WorkspaceSession, error) {
			return stopped, nil
		},
	}
	client := &mockWorkspaceSandboxVMClient{
		suspendVMFn: func(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
			suspendedVMs = append(suspendedVMs, vmID)
			return sandbox.SuspendResult{}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))

	ws := sampleDBWorkspace("ws-313")
	session := db.WorkspaceSession{ID: "sess-313", WorkspaceID: ws.ID, RepositoryID: 101, UserID: 1, Status: "pending"}
	resp, err := svc.finishWorkspaceSessionProvisioning(context.Background(), session, ws, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	}, 80, 24)
	require.NoError(t, err)
	assert.Equal(t, "stopped", resp.Status)
	// No unconditional status write may fire — neither running nor failed.
	assert.Empty(t, sessionStatusWrites)
	// The workspace brought up for the now-stopped session is suspended again.
	assert.Equal(t, []string{ws.VmID}, suspendedVMs)
}

// Issue #312: the last-session destroy must not suspend the VM when the
// sessionless CAS reports a session appeared concurrently.
func TestDestroySession_DoesNotSuspendWhenSessionAppearsConcurrently(t *testing.T) {
	t.Parallel()

	var suspendedVMs []string
	q := &mockWorkspaceQuerier{
		suspendRunningWorkspaceIfSessionlessFn: func(ctx context.Context, id string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	}
	client := &mockWorkspaceSandboxVMClient{
		suspendVMFn: func(ctx context.Context, vmID string) (sandbox.SuspendResult, error) {
			suspendedVMs = append(suspendedVMs, vmID)
			return sandbox.SuspendResult{}, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))

	require.NoError(t, svc.DestroySession(context.Background(), "sess-312", 101, 1))
	assert.Empty(t, suspendedVMs)
}

// registrarWorkspaceQuerier layers the real RegisterWorkspaceVM guard semantics
// (vm_id=” AND status IN pending/starting/failed) over the mock, mirroring prod
// *db.Queries. Issue #240: reprovision left the row failed with the stale
// vm_id, so this guard never matched and the replacement VM was reaped.
// 'failed' remains claimable for a derived row: a raced provisioner can fail
// the row after its replacement VM boots, and the healthy VM must win.
type registrarWorkspaceQuerier struct {
	*mockWorkspaceQuerier
	state db.Workspace
}

func (r *registrarWorkspaceQuerier) RegisterWorkspaceVM(ctx context.Context, arg db.RegisterWorkspaceVMParams) (db.Workspace, error) {
	if strings.TrimSpace(r.state.VmID) != "" || (r.state.Status != "pending" && r.state.Status != "starting" && r.state.Status != "failed") {
		return db.Workspace{}, pgx.ErrNoRows
	}
	r.state.VmID = arg.VmID
	r.state.Status = arg.Status
	return r.state, nil
}

func TestReprovisionDerivedWorkspaceVM_RegistersReplacementVM(t *testing.T) {
	t.Parallel()

	reg := &registrarWorkspaceQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	reg.state = sampleDBWorkspace("ws-240")
	reg.state.IsFork = true
	reg.state.Status = "suspended"
	reg.state.VmID = "vm-old"
	reg.mockWorkspaceQuerier.getWorkspaceFn = func(ctx context.Context, id string) (db.Workspace, error) {
		return reg.state, nil
	}
	reg.mockWorkspaceQuerier.updateWorkspaceStatusFn = func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		reg.state.Status = arg.Status
		return reg.state, nil
	}
	reg.mockWorkspaceQuerier.suspendRunningWorkspaceFn = func(ctx context.Context, id string) (db.Workspace, error) {
		if reg.state.Status != "running" {
			return db.Workspace{}, pgx.ErrNoRows
		}
		reg.state.Status = "suspended"
		return reg.state, nil
	}
	reg.mockWorkspaceQuerier.updateWorkspaceExecutionInfoFn = func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
		reg.state.VmID = arg.VmID
		reg.state.Status = arg.Status
		return reg.state, nil
	}

	var deletedVMs []string
	client := &mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-new"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}
	svc := newWorkspaceServiceForTests(reg, WithWorkspaceSandboxClient(client))

	updated, err := svc.reprovisionWorkspaceVM(context.Background(), reg.state, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	}, context.DeadlineExceeded)
	require.NoError(t, err)
	assert.Equal(t, "vm-new", updated.VmID, "replacement VM must be registered on the workspace")
	assert.Equal(t, "running", updated.Status)
	assert.Contains(t, deletedVMs, "vm-old", "stale VM must be reaped")
	assert.NotContains(t, deletedVMs, "vm-new", "replacement VM must not be deleted as an orphan")
}

// Issue #296: workspaces stranded in 'starting' WITH a vm_id (mid-provision
// crash) must be reaped — failed via CAS and their VM deleted — instead of
// holding a quota slot forever.
func TestCleanupStalePendingWorkspaces_ReapsStrandedStartingVMs(t *testing.T) {
	t.Parallel()

	t.Run("stranded row is failed and its vm deleted", func(t *testing.T) {
		t.Parallel()
		stranded := sampleDBWorkspace("ws-296")
		stranded.Status = "starting"
		stranded.VmID = "vm-stranded"
		var failed []string
		q := &mockWorkspaceQuerier{
			listStaleStartingWorkspacesWithVMFn: func(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error) {
				return []db.Workspace{stranded}, nil
			},
			failStaleStartingWorkspaceFn: func(ctx context.Context, arg db.FailStaleStartingWorkspaceParams) (db.Workspace, error) {
				failed = append(failed, arg.ID)
				out := stranded
				out.Status = "failed"
				return out, nil
			},
		}
		var deletedVMs []string
		client := &mockWorkspaceSandboxVMClient{deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		}}
		svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))

		require.NoError(t, svc.CleanupStalePendingWorkspaces(context.Background()))
		assert.Equal(t, []string{"ws-296"}, failed)
		assert.Equal(t, []string{"vm-stranded"}, deletedVMs)
	})

	t.Run("lost CAS leaves the vm alone", func(t *testing.T) {
		t.Parallel()
		stranded := sampleDBWorkspace("ws-296b")
		stranded.Status = "starting"
		stranded.VmID = "vm-now-running"
		q := &mockWorkspaceQuerier{
			listStaleStartingWorkspacesWithVMFn: func(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error) {
				return []db.Workspace{stranded}, nil
			},
			failStaleStartingWorkspaceFn: func(ctx context.Context, arg db.FailStaleStartingWorkspaceParams) (db.Workspace, error) {
				return db.Workspace{}, pgx.ErrNoRows
			},
		}
		var deletedVMs []string
		client := &mockWorkspaceSandboxVMClient{deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		}}
		svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))

		require.NoError(t, svc.CleanupStalePendingWorkspaces(context.Background()))
		assert.Empty(t, deletedVMs)
	})
}

// Issue #113: an invalid snapshot name must be rejected BEFORE the external
// Microsandbox snapshot is created, or the snapshot leaks on the validation error.
func TestCreateWorkspaceSnapshot_RejectsInvalidNameBeforeSnapshotVM(t *testing.T) {
	t.Parallel()

	var snapshotCalls []string
	client := &mockWorkspaceSandboxVMClient{
		snapshotVMFn: func(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
			snapshotCalls = append(snapshotCalls, vmID)
			return sandbox.SnapshotResult{SnapshotID: "snap-ext"}, nil
		},
	}
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(client))

	_, err := svc.CreateWorkspaceSnapshot(context.Background(), CreateWorkspaceSnapshotInput{
		RepositoryID: 101,
		UserID:       1,
		WorkspaceID:  "ws-113",
		Name:         "bad\x00name",
	})
	require.Error(t, err)
	assert.Empty(t, snapshotCalls, "external snapshot must not be created for an invalid name")
}

// A derived row failed without a VM remains claimable by a fresh VM. The old
// pending/starting-only guard reaped that VM as an orphan and stranded the row.
func TestEnsureDerivedWorkspaceRunning_ClaimsFailedRowWithFreshVM(t *testing.T) {
	t.Parallel()

	reg := &registrarWorkspaceQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	reg.state = sampleDBWorkspace("ws-failed-reuse")
	reg.state.IsFork = true
	reg.state.Status = "failed"
	reg.state.VmID = ""
	reg.mockWorkspaceQuerier.getWorkspaceFn = func(ctx context.Context, id string) (db.Workspace, error) {
		return reg.state, nil
	}
	reg.mockWorkspaceQuerier.updateWorkspaceExecutionInfoFn = func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
		reg.state.VmID = arg.VmID
		reg.state.Status = arg.Status
		return reg.state, nil
	}

	var deletedVMs []string
	client := &mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-replacement"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}
	svc := newWorkspaceServiceForTests(reg, WithWorkspaceSandboxClient(client))

	updated, err := svc.ensureWorkspaceRunning(context.Background(), reg.state, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-replacement", updated.VmID, "fresh VM must claim the failed row")
	assert.Equal(t, "running", updated.Status)
	assert.NotContains(t, deletedVMs, "vm-replacement", "healthy replacement VM must not be reaped as an orphan")
}

// Same incident, sibling path: a derived workspace still points at a VM Microsandbox
// deleted out-of-band (InspectSandbox 404). The old code jumped straight to
// createWorkspaceVM without resetting the row, so the claim guard saw the
// stale vm_id as "already claimed", reaped the replacement VM, and returned
// the dead row as a bogus success. The gone path must reset the row first.
func TestEnsureDerivedWorkspaceRunning_VMGoneResetsStaleRowAndRegistersReplacement(t *testing.T) {
	t.Parallel()

	reg := &registrarWorkspaceQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	reg.state = sampleDBWorkspace("ws-vm-gone")
	reg.state.IsFork = true
	reg.state.Status = "suspended"
	reg.state.VmID = "vm-dead"
	reg.mockWorkspaceQuerier.getWorkspaceFn = func(ctx context.Context, id string) (db.Workspace, error) {
		return reg.state, nil
	}
	reg.mockWorkspaceQuerier.suspendRunningWorkspaceFn = func(ctx context.Context, id string) (db.Workspace, error) {
		if reg.state.Status != "running" {
			return db.Workspace{}, pgx.ErrNoRows
		}
		reg.state.Status = "suspended"
		return reg.state, nil
	}
	reg.mockWorkspaceQuerier.updateWorkspaceExecutionInfoFn = func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
		reg.state.VmID = arg.VmID
		reg.state.Status = arg.Status
		return reg.state, nil
	}

	var deletedVMs []string
	client := &mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 404, Message: "VM not found"}
		},
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-replacement"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deletedVMs = append(deletedVMs, vmID)
			return nil
		},
	}
	svc := newWorkspaceServiceForTests(reg, WithWorkspaceSandboxClient(client))

	updated, err := svc.ensureWorkspaceRunning(context.Background(), reg.state, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-replacement", updated.VmID, "replacement VM must be registered, not the dead row returned")
	assert.Equal(t, "running", updated.Status)
	assert.Contains(t, deletedVMs, "vm-dead", "dead VM id must be reaped best-effort")
	assert.NotContains(t, deletedVMs, "vm-replacement", "healthy replacement VM must not be reaped as an orphan")
}
