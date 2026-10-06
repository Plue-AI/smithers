package services

import (
	"context"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// workspaceGuestLayout is where a workspace's commands run: the unprivileged
// account, its home and the repository checkout.
type workspaceGuestLayout struct {
	User string
	Home string
	Root string
}

// defaultWorkspaceGuestLayout is the guest this backend provisions through
// its sandbox provider.
var defaultWorkspaceGuestLayout = workspaceGuestLayout{User: defaultWorkspaceUser, Home: defaultWorkspaceHome, Root: defaultWorkspaceClonePath}

func (l workspaceGuestLayout) localDir() string    { return l.Home + "/.local" }
func (l workspaceGuestLayout) localBinDir() string { return l.Home + "/.local/bin" }
func (l workspaceGuestLayout) localNodeDir() string {
	return l.Home + "/.local/node"
}
func (l workspaceGuestLayout) nodeInstallLog() string { return l.Home + "/.smithers/node-install.log" }
func (l workspaceGuestLayout) claudeInstallLog() string {
	return l.Home + "/.smithers/claude-install.log"
}

// runtimeGuest reports whether a sandboxed runtime owns this backend's
// workspaces. Its guests have the runtime's own account, home and checkout,
// and a command for one goes through the runtime, never through a sandbox
// provider the deployment also holds for compute.
func (s *WorkspaceService) runtimeGuest() bool {
	return s.runtime != nil && s.runtime.Isolation() == workspaceapi.IsolationSandboxed
}

// guestAccountPattern is an unprivileged POSIX account name.
var guestAccountPattern = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// workspaceGuestLayout answers a workspace's guest layout. A runtime guest's
// checkout and home are what its runtime reports, and its account is the one
// the runtime runs its commands as; any other workspace is this backend's
// own guest. The workspace must be running.
func (s *WorkspaceService) workspaceGuestLayout(ctx context.Context, row db.Workspace, requesterID int64) (workspaceGuestLayout, error) {
	if !s.runtimeGuest() {
		return defaultWorkspaceGuestLayout, nil
	}
	layout, operationCtx, err := s.runtimeGuestPaths(ctx, row, requesterID)
	if err != nil {
		return workspaceGuestLayout{}, err
	}
	if cached, ok := s.runtimeGuestAccounts.Load(row.ID); ok {
		layout.User = cached.(string)
		return layout, nil
	}
	result, err := s.runtime.ExecuteCommand(operationCtx, row.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "id -u && id -un"}})
	if err != nil {
		return workspaceGuestLayout{}, runtimeOperationError("read workspace guest account", err)
	}
	fields := strings.Fields(result.Stdout)
	if result.ExitCode != 0 || len(fields) != 2 || fields[0] == "0" || !guestAccountPattern.MatchString(fields[1]) {
		return workspaceGuestLayout{}, pkgerrors.Internal("workspace runtime runs commands as no unprivileged account")
	}
	layout.User = fields[1]
	s.runtimeGuestAccounts.Store(row.ID, layout.User)
	return layout, nil
}

// runtimeGuestPaths answers a runtime guest's checkout and home, and the
// operation context a command for it runs under.
func (s *WorkspaceService) runtimeGuestPaths(ctx context.Context, row db.Workspace, requesterID int64) (workspaceGuestLayout, context.Context, error) {
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, "workspace-guest:"+row.ID+":"+uuid.NewString())
	if err != nil {
		return workspaceGuestLayout{}, nil, err
	}
	observed, err := s.runtime.InspectWorkspace(operationCtx, row.ID)
	if err != nil {
		return workspaceGuestLayout{}, nil, runtimeOperationError("inspect workspace runtime", err)
	}
	if !path.IsAbs(observed.Root) || !path.IsAbs(observed.Home) {
		return workspaceGuestLayout{}, nil, pkgerrors.Internal("workspace runtime reports no guest checkout or home")
	}
	return workspaceGuestLayout{Home: observed.Home, Root: observed.Root}, operationCtx, nil
}

// execRuntimeGuestScript runs script in a runtime workspace through its
// runtime, which runs it as the guest's account in the guest's checkout. An
// error is the transport's: the script may or may not have run.
func (s *WorkspaceService) execRuntimeGuestScript(operationCtx context.Context, workspaceID, script string) (workspaceapi.CommandResult, error) {
	execCtx, cancel := context.WithTimeout(operationCtx, time.Duration(workspaceOperationTimeoutMS)*time.Millisecond)
	defer cancel()
	return s.runtime.ExecuteCommand(execCtx, workspaceID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", script}})
}
