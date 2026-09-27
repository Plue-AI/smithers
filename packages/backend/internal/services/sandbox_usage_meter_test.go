package services

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Shared mocks default to successful writes, including when used by billing tests.
type sandboxUsageRecorder struct {
	mu     sync.Mutex
	opens  []db.OpenSandboxUsageIntervalParams
	closes []db.CloseSandboxUsageIntervalParams
	sweeps int
	err    error
}

func (m *sandboxUsageRecorder) OpenSandboxUsageInterval(ctx context.Context, arg db.OpenSandboxUsageIntervalParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.opens = append(m.opens, arg)
	return m.err
}
func (m *sandboxUsageRecorder) CloseSandboxUsageInterval(ctx context.Context, arg db.CloseSandboxUsageIntervalParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closes = append(m.closes, arg)
	return m.err
}
func (m *sandboxUsageRecorder) CloseOrphanedSandboxUsageIntervals(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sweeps++
	return m.err
}
func (m *sandboxUsageRecorder) requireOpen(t *testing.T, user int64, kind, id string) {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	require.Contains(t, m.opens, db.OpenSandboxUsageIntervalParams{UserID: user, SandboxKind: kind, SandboxID: id})
}
func (m *sandboxUsageRecorder) requireClose(t *testing.T, kind, id string) {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	require.Contains(t, m.closes, db.CloseSandboxUsageIntervalParams{SandboxKind: kind, SandboxID: id})
}

func TestSandboxUsageWorkspaceStarts(t *testing.T) {
	ctx := context.Background()
	for _, point := range []string{"create", "snapshot", "fork", "empty-source fork", "derived fork", "resume", "recover existing", "recover session", "agent fresh", "agent fork", "pod running"} {
		t.Run(point, func(t *testing.T) {
			w := sampleDBWorkspace("meter-workspace")
			w.Status = "starting"
			w.UserID = 42
			source := sampleDBWorkspace("meter-source")
			source.VmID = "vm-source"
			source.Status = "running"
			source.UserID = w.UserID
			q := &mockWorkspaceQuerier{
				getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return w, nil },
				updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
					out := w
					out.VmID = arg.VmID
					out.Status = arg.Status
					return out, nil
				},
				updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
					out := w
					out.Status = arg.Status
					return out, nil
				},
				getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
					return source, nil
				},
			}
			q.err = errors.New("meter unavailable")
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					return sandbox.CreateResult{ID: "vm-meter"}, nil
				},
				getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
					return sandbox.Sandbox{ID: id, State: sandbox.StateRunning}, nil
				},
			}))
			input := CreateWorkspaceSessionInput{UserID: w.UserID, RepoOwner: "alice", RepoName: "repo", SourceBookmark: "feature"}
			agentInput := CreateAgentWorkspaceInput{UserID: w.UserID, RepoOwner: "alice", RepoName: "repo"}
			var err error
			switch point {
			case "create":
				_, err = svc.createWorkspaceVM(ctx, w, input)
			case "snapshot":
				_, err = svc.createWorkspaceVMFromSnapshot(ctx, w, sampleDBWorkspaceSnapshot("snap", w.ID, "snap", "fs-snap"))
			case "fork":
				_, err = svc.forkWorkspaceVM(ctx, w, source)
			case "empty-source fork":
				_, err = svc.forkWorkspaceVM(ctx, w, db.Workspace{})
			case "derived fork":
				w.TargetBookmark = "feature"
				w.IsFork = true
				var ok bool
				_, ok = svc.tryForkDerivedFromPrimary(ctx, w, input)
				require.True(t, ok)
			case "resume":
				w.VmID = "vm-meter"
				w.Status = "suspended"
				_, err = svc.resumeWorkspaceVM(ctx, w)
			case "recover existing":
				w.VmID = "vm-meter"
				_, err = svc.ensureExistingWorkspaceRunning(ctx, w)
			case "recover session":
				w.VmID = "vm-meter"
				_, err = svc.ensureWorkspaceRunning(ctx, w, input)
			case "agent fresh":
				w.Kind = "agent"
				_, err = svc.provisionFreshAgentWorkspace(ctx, w, agentInput, nil, "main")
			case "agent fork":
				w.Kind = "agent"
				_, err = svc.forkAgentWorkspace(ctx, w, agentInput, nil, source, true)
			case "pod running":
				err = svc.UpdateWorkspacePodStatus(ctx, UpdateWorkspacePodStatusInput{WorkspaceID: w.ID, Status: "running"})
			}
			require.NoError(t, err)
			q.requireOpen(t, w.UserID, "workspace", w.ID)
		})
	}
}

func TestSandboxUsageWorkspaceStopsAndSweep(t *testing.T) {
	for _, point := range []string{"suspend", "sessionless suspend", "stop/delete teardown", "delete", "fail", "provision failed", "agent failed", "agent suspend", "pod stopped", "pod failed", "idle sweep", "sweep list failure"} {
		t.Run(point, func(t *testing.T) {
			ctx := context.Background()
			w := sampleDBWorkspace("meter-close")
			w.Status = "running"
			w.VmID = "vm-meter"
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return w, nil }, listIdleWorkspacesFn: func(context.Context) ([]db.Workspace, error) { return []db.Workspace{w}, nil }}
			// Every lifecycle must still succeed when metering writes fail.
			q.err = errors.New("meter unavailable")
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
			var err error
			switch point {
			case "suspend":
				err = svc.suspendWorkspace(ctx, w)
			case "sessionless suspend":
				err = svc.suspendWorkspaceIfSessionless(ctx, w)
			case "stop/delete teardown":
				err = svc.teardownWorkspaceVM(ctx, w)
			case "delete":
				err = svc.destroyWorkspace(ctx, w)
			case "fail":
				_, err = svc.failWorkspace(ctx, w, errors.New("VM failed"))
			case "provision failed":
				svc.markWorkspaceProvisionFailed(ctx, w, errors.New("VM failed"))
			case "agent failed":
				err = svc.FailAgentWorkspace(ctx, w.ID)
			case "agent suspend":
				err = svc.SuspendAgentWorkspace(ctx, w.ID)
			case "pod stopped":
				err = svc.UpdateWorkspacePodStatus(ctx, UpdateWorkspacePodStatusInput{WorkspaceID: w.ID, Status: "stopped"})
			case "pod failed":
				err = svc.UpdateWorkspacePodStatus(ctx, UpdateWorkspacePodStatusInput{WorkspaceID: w.ID, Status: "failed"})
			case "idle sweep":
				err = svc.CleanupIdleWorkspaces(ctx)
				require.Equal(t, 1, q.sweeps)
			case "sweep list failure":
				q.listIdleWorkspacesFn = func(context.Context) ([]db.Workspace, error) { return nil, errors.New("list failed") }
				require.Error(t, svc.CleanupIdleWorkspaces(ctx))
				require.Equal(t, 1, q.sweeps)
				return
			}
			require.NoError(t, err)
			q.requireClose(t, "workspace", w.ID)
		})
	}
}

func TestSandboxUsageAgentReservationAndTerminal(t *testing.T) {
	for _, capped := range []bool{false, true} {
		q := &mockAgentDispatchQuerier{}
		q.err = errors.New("meter unavailable")
		svc := newTestDispatchService(q, nil)
		if capped {
			svc.concurrencyCounter = &mockAgentConcurrencyCounter{}
			svc.concurrencyMax = 3
		}
		d := &agentDispatch{svc: svc, ctx: context.Background(), input: DispatchAgentRunInput{UserID: 42, SessionID: "meter-agent"}}
		require.NoError(t, d.reserveFleetSlot())
		q.requireOpen(t, 42, "agent", "meter-agent")
	}
	for _, status := range []string{"completed", "failed", "cancelled", "timed_out"} {
		t.Run(status, func(t *testing.T) {
			q := &mockAgentDispatchQuerier{}
			svc := newTestDispatchService(q, nil)
			session := db.AgentSession{ID: "meter-agent", UserID: 42, Status: status}
			if status == "timed_out" {
				q.updateAgentSessionTimedOutFn = func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
					return session, nil
				}
				require.NoError(t, svc.reapExpiredSession(context.Background(), session))
			} else {
				svc.finalizeAgentSession(context.Background(), session, status, "")
			}
			q.requireClose(t, "agent", session.ID)
		})
	}
}

func TestSandboxUsageAgentWorkspaceHandoff(t *testing.T) {
	q := &mockWorkspaceQuerier{}
	svc := newWorkspaceServiceForTests(q)
	w := sampleDBWorkspace("meter-ws")
	w.AgentSessionID = pgUUIDFromString("0f8fad5b-d9cb-469f-a165-70867728950e")
	svc.meterWorkspaceUsage(context.Background(), w, "running")
	q.requireClose(t, "agent", UUIDString(w.AgentSessionID))
	q.requireOpen(t, w.UserID, "workspace", w.ID)
}

func TestSandboxUsageFailedAgentDispatchClosesReservation(t *testing.T) {
	q := &mockAgentDispatchQuerier{}
	svc := newTestDispatchService(q, nil)
	d := &agentDispatch{svc: svc, ctx: context.Background(), input: DispatchAgentRunInput{UserID: 1, SessionID: "failed-agent"}}
	require.NoError(t, d.reserveFleetSlot())
	require.Error(t, d.markInfraFailed("create VM failed"))
	q.requireOpen(t, 1, "agent", "failed-agent")
	q.requireClose(t, "agent", "failed-agent")
}

func TestSandboxUsageDeniedReservationDoesNotOpen(t *testing.T) {
	q := &mockAgentDispatchQuerier{}
	svc := newTestDispatchService(q, nil)
	svc.concurrencyCounter = &mockAgentConcurrencyCounter{count: 1}
	svc.concurrencyMax = 1
	d := &agentDispatch{svc: svc, ctx: context.Background(), input: DispatchAgentRunInput{UserID: 1, SessionID: "denied-agent"}}
	require.Error(t, d.reserveFleetSlot())
	require.Empty(t, q.opens)
}

func TestSandboxUsageStopWorkspace(t *testing.T) {
	w := sampleDBWorkspace("stop-meter")
	q := &stopWorkspaceStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return w, nil },
	}, stop: func(context.Context, string) (db.StopWorkspaceRetainingRowRow, error) {
		w.Status = "stopped"
		return db.StopWorkspaceRetainingRowRow(w), nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.StopWorkspace(context.Background(), w.ID, w.RepositoryID, w.UserID)
	require.NoError(t, err)
	q.requireClose(t, "workspace", w.ID)
}
