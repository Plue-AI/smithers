package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// machineQueueStore holds workspace rows in memory and records their
// provisioning stage, as the product store does.
type machineQueueStore struct {
	*mockWorkspaceQuerier
	mu   sync.Mutex
	rows map[string]db.Workspace
}

func (q *machineQueueStore) row(id string) db.Workspace {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.rows[id]
}

func (q *machineQueueStore) update(id string, change func(*db.Workspace)) {
	q.mu.Lock()
	defer q.mu.Unlock()
	row := q.rows[id]
	change(&row)
	q.rows[id] = row
}

func (q *machineQueueStore) UpdateWorkspaceProvisioningStage(_ context.Context, arg db.UpdateWorkspaceProvisioningStageParams) (db.Workspace, error) {
	q.update(arg.ID, func(row *db.Workspace) { row.ProvisioningStage = arg.ProvisioningStage })
	return q.row(arg.ID), nil
}

// machineQueueService composes the real runtime admission queue: an
// unbooted microsandbox.Runtime orders demand without msb.
func machineQueueService(t *testing.T, ids ...string) (*WorkspaceService, *machineQueueStore) {
	t.Helper()
	every := workspaceMachineWaitEvery
	workspaceMachineWaitEvery = 5 * time.Millisecond
	t.Cleanup(func() { workspaceMachineWaitEvery = every })
	q := &machineQueueStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, rows: map[string]db.Workspace{}}
	q.getWorkspaceFn = func(_ context.Context, id string) (db.Workspace, error) { return q.row(id), nil }
	for _, id := range ids {
		row := sampleDBWorkspace(id)
		row.Status, row.VmID = "pending", ""
		q.rows[id] = row
	}
	return newWorkspaceServiceForTests(q, WithWorkspaceRuntime(new(microsandbox.Runtime))), q
}

// fullHost is a host with slots machines free; a try beyond them is the
// runtime's typed refusal, as runtimeOperationError answers it.
type fullHost struct {
	mu      sync.Mutex
	slots   int
	granted []string
	tries   map[string]int
}

func (h *fullHost) try(_ context.Context, row db.Workspace) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tries[row.ID]++
	if h.slots == 0 {
		return runtimeOperationError("inspect workspace runtime", &microsandbox.CapacityError{Code: "machine_capacity", Class: "capacity",
			Message: "microVM capacity reached: 1 of 1 machines are in use"})
	}
	h.slots--
	h.granted = append(h.granted, row.ID)
	return nil
}

func (h *fullHost) free() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.slots++
}

func (h *fullHost) triesOf(id string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tries[id]
}

// The runtime's capacity refusal is the honest no_capacity answer, not an
// internal failure: nothing was created.
func TestMachineCapacityRefusalIsNoCapacity(t *testing.T) {
	refusal := &microsandbox.CapacityError{Code: "machine_capacity", Class: "capacity", Message: "microVM capacity reached: 1 of 1 machines are in use"}
	err := runtimeOperationError("inspect workspace runtime", fmt.Errorf("create: %w", refusal))
	require.True(t, isNoCapacityError(err))
	var api *pkgerrors.APIError
	require.ErrorAs(t, err, &api)
	require.Equal(t, workspaceNoCapacityMessage, api.Message)
	require.ErrorIs(t, api.Cause(), refusal)
	// A host that can never fit a machine is not a line to wait in.
	zero := &microsandbox.CapacityError{Code: "host_capacity_zero", Class: "capacity", Message: "cannot start a fresh install"}
	require.False(t, isNoCapacityError(runtimeOperationError("inspect workspace runtime", zero)))
}

// A full host queues workspaces in the runtime's admission queue instead of
// failing them: each stays pending, waiting for a machine with its place in
// line, and only the head of the line tries again, so machines go out in
// order as slots free.
func TestFullHostQueuesWorkspacesInOrder(t *testing.T) {
	svc, q := machineQueueService(t, "first", "second")
	host := &fullHost{tries: map[string]int{}}
	ctx := context.Background()
	done := map[string]chan error{"first": make(chan error, 1), "second": make(chan error, 1)}
	wait := func(id string) {
		err := host.try(ctx, q.row(id))
		require.True(t, isNoCapacityError(err))
		go func() { done[id] <- svc.waitForMachine(ctx, q.row(id), err, host.try) }()
	}
	place := func(id string) int {
		place, _ := svc.MachinePlace(q.row(id))
		return place
	}
	wait("first")
	require.Eventually(t, func() bool { return place("first") == 1 }, 5*time.Second, time.Millisecond)
	wait("second")
	require.Eventually(t, func() bool { return place("second") == 2 }, 5*time.Second, time.Millisecond)
	for _, id := range []string{"first", "second"} {
		row := q.row(id)
		require.Equal(t, "pending", row.Status, "a full host never fails a workspace")
		require.Equal(t, workspaceWaitingForMachine, row.ProvisioningStage)
	}
	require.Eventually(t, func() bool { return host.triesOf("first") >= 3 }, 5*time.Second, time.Millisecond)
	require.Equal(t, 1, host.triesOf("second"), "only the head of the line tries")

	host.free()
	require.NoError(t, <-done["first"])
	require.Empty(t, q.row("first").ProvisioningStage, "a workspace with a machine no longer waits")
	_, waiting := svc.MachinePlace(q.row("first"))
	require.False(t, waiting)
	require.Eventually(t, func() bool { return place("second") == 1 }, 5*time.Second, time.Millisecond)

	host.free()
	require.NoError(t, <-done["second"])
	require.Equal(t, []string{"first", "second"}, host.granted)
}

// A workspace leaves the line without a failure when it is stopped or
// deleted while it waits, or when the wait runs out of time; another
// provisioning failure ends the wait with that failure.
func TestMachineWaitEnds(t *testing.T) {
	refused := func() error {
		return runtimeOperationError("inspect workspace runtime", &microsandbox.CapacityError{Code: "machine_capacity", Class: "capacity", Message: "full"})
	}
	for _, tc := range []struct {
		name  string
		leave func(q *machineQueueStore, cancel context.CancelFunc)
		try   error
		want  error
	}{
		{name: "stopped", leave: func(q *machineQueueStore, _ context.CancelFunc) {
			q.update("lane", func(row *db.Workspace) { row.Status = "stopped" })
		}, want: errWorkspaceMachineWaitEnded},
		{name: "deleted", leave: func(q *machineQueueStore, _ context.CancelFunc) {
			q.update("lane", func(row *db.Workspace) { row.DeletedAt.Valid = true })
		}, want: errWorkspaceMachineWaitEnded},
		{name: "out of time", leave: func(_ *machineQueueStore, cancel context.CancelFunc) { cancel() }, want: errWorkspaceMachineWaitEnded},
		{name: "another failure", try: errors.New("guest boot failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, q := machineQueueService(t, "lane")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			try := func(context.Context, db.Workspace) error {
				if tc.try != nil {
					return tc.try
				}
				return refused()
			}
			result := make(chan error, 1)
			go func() { result <- svc.waitForMachine(ctx, q.row("lane"), refused(), try) }()
			require.Eventually(t, func() bool { _, waiting := svc.MachinePlace(q.row("lane")); return waiting || tc.try != nil }, 5*time.Second, time.Millisecond)
			if tc.leave != nil {
				tc.leave(q, cancel)
			}
			err := <-result
			if tc.want != nil {
				require.ErrorIs(t, err, tc.want)
			} else {
				require.ErrorIs(t, err, tc.try)
			}
			require.NotEqual(t, "failed", q.row("lane").Status)
			for _, row := range svc.runtime.(workspaceMachineQueue).AdmissionSnapshot() {
				require.NotEqual(t, "waiting", row.State, "the workspace left the line")
			}
		})
	}
}

// A workspace that already has a machine, or a runtime with no admission
// queue, is not queued: the refusal stands as it was.
func TestMachineWaitNeedsAQueueAndNoMachine(t *testing.T) {
	refusal := errors.New("refused")
	svc, q := machineQueueService(t, "lane")
	row := q.row("lane")
	row.VmID = "vm-live"
	require.ErrorIs(t, svc.waitForMachine(context.Background(), row, refusal, nil), refusal)
	plain := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(&laneStopRuntime{}))
	require.ErrorIs(t, plain.waitForMachine(context.Background(), q.row("lane"), refusal, nil), refusal)
}
