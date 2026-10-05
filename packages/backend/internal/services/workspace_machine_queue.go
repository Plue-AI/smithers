package services

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// workspaceMachineQueue is the workspace runtime's admission queue
// (microsandbox.Runtime): the one line in which workspaces wait for a
// machine on a full host, in order, with its reason and each one's place.
type workspaceMachineQueue interface {
	Request(class, holder, actor, reason string) (microsandbox.AdmissionRequest, error)
	CancelAdmission(holder, actor string, now time.Time) bool
	AdmissionSnapshot() []microsandbox.AdmissionRequest
}

const (
	// workspaceMachineReason is the admission queue's reason for a workspace
	// that waits for a machine: "Waiting for a machine · #2" (spec §4.2).
	workspaceMachineReason = "machine"
	// workspaceWaitingForMachine is the provisioning stage of a workspace in
	// that line.
	workspaceWaitingForMachine = "waiting_for_machine"
)

// workspaceMachineWaitEvery paces a waiting workspace's look at the line.
var workspaceMachineWaitEvery = 2 * time.Second

// errWorkspaceMachineWaitEnded reports a wait that ended without a machine
// and without a failure: the workspace was stopped or deleted while it
// waited, or the wait ran out of time and the row stays pending for the
// provisioning reconciler. Nothing marks it failed.
var errWorkspaceMachineWaitEnded = errors.New("the workspace left the line for a machine")

// isMachineCapacityError reports the runtime's typed refusal of a machine on
// a full host (microVM capacity reached). It is transient: nothing was
// created, and a slot frees when another machine stops.
func isMachineCapacityError(err error) bool {
	var capacity *microsandbox.CapacityError
	return errors.As(err, &capacity) && capacity.Code == "machine_capacity"
}

func machineQueueHolder(workspaceID string) string { return "workspace:" + workspaceID }

// waitForMachine keeps a workspace the full host refused in the runtime's
// admission queue instead of failing it (T-MCH-06): its row stays pending at
// the stage waiting_for_machine, and it tries again only at the head of the
// line, so machines go out in order; try is the provisioning it repeats. It
// answers nil once the workspace runs, errWorkspaceMachineWaitEnded when it
// leaves the line unprovisioned, and any other error the provisioning
// answered. A workspace with a machine already, or a runtime with no queue,
// answers cause unchanged.
func (s *WorkspaceService) waitForMachine(ctx context.Context, workspace db.Workspace, cause error, try func(context.Context, db.Workspace) error) error {
	queue, ok := s.runtime.(workspaceMachineQueue)
	if !ok || strings.TrimSpace(workspace.VmID) != "" {
		return cause
	}
	holder := machineQueueHolder(workspace.ID)
	if _, err := queue.Request("todo", holder, holder, workspaceMachineReason); err != nil {
		return cause
	}
	// The line is left whatever ends the wait; a machine started without a
	// grant holds no reservation.
	defer queue.CancelAdmission(holder, holder, time.Now())
	s.setWorkspaceProvisioningStageBestEffort(ctx, workspace.ID, workspaceWaitingForMachine)
	ticker := time.NewTicker(workspaceMachineWaitEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return errWorkspaceMachineWaitEnded
		case <-ticker.C:
		}
		current, err := s.q.GetWorkspace(ctx, workspace.ID)
		if err != nil || current.DeletedAt.Valid || current.Status != "pending" && current.Status != "starting" {
			return errWorkspaceMachineWaitEnded
		}
		if place, _ := machineQueuePlace(queue, holder); place > 1 {
			continue
		}
		if err = try(ctx, current); err == nil {
			s.setWorkspaceProvisioningStageBestEffort(ctx, workspace.ID, "")
			return nil
		}
		if !isNoCapacityError(err) {
			return err
		}
	}
}

// machineQueuePlace is holder's 1-based place in the line for a machine.
func machineQueuePlace(queue workspaceMachineQueue, holder string) (int, bool) {
	for _, row := range queue.AdmissionSnapshot() {
		if row.Holder == holder && row.State == "waiting" {
			return row.Position, true
		}
	}
	return 0, false
}

// MachinePlace is a waiting workspace's place in the line for a machine
// ("Waiting for a machine · #2"); false when it is not waiting.
func (s *WorkspaceService) MachinePlace(workspace db.Workspace) (int, bool) {
	if s == nil || workspace.ProvisioningStage != workspaceWaitingForMachine || workspace.Status != "pending" && workspace.Status != "starting" {
		return 0, false
	}
	queue, ok := s.runtime.(workspaceMachineQueue)
	if !ok {
		return 0, false
	}
	place, waiting := machineQueuePlace(queue, machineQueueHolder(workspace.ID))
	return place, waiting && place > 0
}

// MachinePlace is a lane's place in the line for a machine.
func (l *workspaceMythicalLanes) MachinePlace(workspace db.Workspace) (int, bool) {
	if l == nil || l.workspaces == nil {
		return 0, false
	}
	return l.workspaces.MachinePlace(workspace)
}

// machinePlace is a TODO's lane's place in the line for a machine on a full
// host, read from the lanes that provision it.
func (s *MythicalService) machinePlace(workspace db.Workspace) (int, bool) {
	lanes, ok := s.lanes.(interface {
		MachinePlace(db.Workspace) (int, bool)
	})
	if !ok {
		return 0, false
	}
	return lanes.MachinePlace(workspace)
}
