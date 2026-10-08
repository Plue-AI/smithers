package compose

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

type maintenanceMachineRuntime interface {
	DrainMachineAdmission(context.Context) error
	StopMachineAdmission(context.Context) error
	ResumeMachineAdmission(context.Context) error
}

type installMachineAdmission struct {
	runtime    maintenanceMachineRuntime
	workspaces *services.WorkspaceService
}

func (a installMachineAdmission) Drain(ctx context.Context) error {
	if err := a.runtime.DrainMachineAdmission(ctx); err != nil {
		return err
	}
	if a.workspaces != nil {
		return a.workspaces.WaitForProvisioning(ctx)
	}
	return nil
}
func (a installMachineAdmission) Stop(ctx context.Context) error {
	if err := a.runtime.StopMachineAdmission(ctx); err != nil {
		return err
	}
	if a.workspaces != nil {
		return a.workspaces.WaitForProvisioning(ctx)
	}
	return nil
}
func (a installMachineAdmission) Resume(ctx context.Context) error {
	return a.runtime.ResumeMachineAdmission(ctx)
}

// Bind the runtime's own capacity mutex, rather than a second scheduler.
// A persisted freeze must fence starts before this process serves requests.
func composeInstallAdmission(ctx context.Context, service *services.InstallQuiesce, runtime any, workspaces *services.WorkspaceService) error {
	machine, ok := runtime.(maintenanceMachineRuntime)
	if !ok {
		return nil // Available names the missing T-MCH-06 contract.
	}
	service.Admission = installMachineAdmission{runtime: machine, workspaces: workspaces}
	if _, ok := runtime.(interface {
		MaintenanceHealthWake(context.Context, string, string, microsandbox.AdmissionProviders) error
	}); ok && workspaces != nil {
		service.HealthWake = workspaces.MaintenanceHealthWake
	}
	var frozen bool
	if err := service.Gate.Store.Update(ctx, func(row *services.QuiesceFreeze) (*services.QuiesceFreeze, error) {
		frozen = row != nil
		return row, nil
	}); err != nil {
		return err
	}
	_, markerErr := os.Lstat(filepath.Join(service.Gate.StateDir, ".upgrade-incomplete"))
	if markerErr != nil && !errors.Is(markerErr, os.ErrNotExist) {
		return markerErr
	}
	if frozen || markerErr == nil {
		return machine.DrainMachineAdmission(ctx)
	}
	return nil
}

func composeAdmissionPublication(runtime any, stack *services.MythicalService) {
	if queue, ok := runtime.(interface {
		SetAdmissionPublisher(func(context.Context, microsandbox.AdmissionRequest) error)
	}); ok {
		queue.SetAdmissionPublisher(stack.PublishMachineGrant)
	}
}
