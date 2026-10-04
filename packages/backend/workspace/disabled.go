package workspace

import (
	"context"
	"io/fs"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MachinesDisabled returns the permanent preview refusal.
func MachinesDisabled() error {
	return apierrors.New(apierrors.CodeMachinesDisabled, "Machines are off in this preview.")
}

// Disabled refuses every execution and filesystem operation without effects.
type Disabled struct{}

var _ WorkspaceRuntime = (*Disabled)(nil)

func NewDisabled() *Disabled                          { return &Disabled{} }
func (*Disabled) Isolation() IsolationLevel           { return IsolationDisabled }
func (*Disabled) Capabilities() WorkspaceCapabilities { return WorkspaceCapabilities{} }
func (*Disabled) CreateWorkspace(context.Context, WorkspaceSpec) (Workspace, error) {
	return Workspace{}, MachinesDisabled()
}
func (*Disabled) InspectWorkspace(context.Context, string) (Workspace, error) {
	return Workspace{}, MachinesDisabled()
}
func (*Disabled) StartWorkspace(context.Context, string) (Workspace, error) {
	return Workspace{}, MachinesDisabled()
}
func (*Disabled) StopWorkspace(context.Context, string) error   { return MachinesDisabled() }
func (*Disabled) DeleteWorkspace(context.Context, string) error { return MachinesDisabled() }
func (*Disabled) ExecuteCommand(context.Context, string, Command) (CommandResult, error) {
	return CommandResult{}, MachinesDisabled()
}
func (*Disabled) StartService(context.Context, string, ServiceSpec) (Service, error) {
	return Service{}, MachinesDisabled()
}
func (*Disabled) InspectService(context.Context, string, string) (ServiceObservation, error) {
	return ServiceObservation{}, MachinesDisabled()
}
func (*Disabled) StopService(context.Context, string, string) error { return MachinesDisabled() }
func (*Disabled) OpenWorkspaceTerminal(context.Context, string, Command) (Terminal, error) {
	return nil, MachinesDisabled()
}
func (*Disabled) PreviewTarget(context.Context, string, uint16) (PreviewTarget, error) {
	return PreviewTarget{}, MachinesDisabled()
}
func (*Disabled) ReadFile(context.Context, string, string) ([]byte, error) {
	return nil, MachinesDisabled()
}
func (*Disabled) WriteFile(context.Context, string, string, []byte, fs.FileMode) error {
	return MachinesDisabled()
}
func (*Disabled) ListFiles(context.Context, string, string) ([]FileEntry, error) {
	return nil, MachinesDisabled()
}
func (*Disabled) RemoveFile(context.Context, string, string) error { return MachinesDisabled() }
func (*Disabled) Close() error                                     { return MachinesDisabled() }
