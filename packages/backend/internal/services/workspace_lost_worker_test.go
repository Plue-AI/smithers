package services

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestWorkspaceResumePreservesLostWorkerResponseAndRetainedVM(t *testing.T) {
	workspace := sampleDBWorkspace("ws-retained")
	workspace.VmID = "vm-retained"
	workspace.Status = "suspended"
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable,
					Code: "host_lease_lost", Message: "The workspace worker is unavailable. Use another workspace, or retry when this worker is available."}
			},
		}))
	retained, err := svc.ensureExistingWorkspaceRunning(context.Background(), workspace)
	failure := apiErrorOf(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, failure.Status)
	assert.Equal(t, pkgerrors.CodeHostLeaseLost, failure.Code)
	assert.Equal(t, pkgerrors.FaultInfra, failure.Fault)
	assert.Contains(t, failure.Message, "Use another workspace, or retry when this worker is available.")
	assert.NotContains(t, failure.Message, "create")
	assert.Equal(t, workspace, retained)
}

type lostWorkerRuntime struct {
	workspaceapi.WorkspaceRuntime
	inspectErr error
	startErr   error
}

func (r lostWorkerRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	if r.inspectErr != nil {
		return workspaceapi.Workspace{}, r.inspectErr
	}
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceStopped}, nil
}

func (r lostWorkerRuntime) StartWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, r.startErr
}

// 2026-09-29, production: after a release replaced the sandbox workers,
// /api/workflow/provision answered 500 fault=bug "inspect workspace runtime:
// ... (host_lease_lost)" for a suspended workspace on the runtime path. The
// lease loss can surface on inspect or on the start that follows it.
func TestWorkspaceRuntimeResumeKeepsLostWorkerResponse(t *testing.T) {
	lost := fmt.Errorf("runtime: %w", &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable,
		Code: "host_lease_lost", Message: "The workspace worker is unavailable. Use another workspace, or retry when this worker is available."})
	for name, runtime := range map[string]lostWorkerRuntime{
		"inspect": {inspectErr: lost},
		"start":   {startErr: lost},
	} {
		t.Run(name, func(t *testing.T) {
			row := sampleDBWorkspace("ws-runtime-lost")
			row.Status = "suspended"
			row.VmID = "vm-lost"
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(runtime), WithWorkspaceBillingPolicy(&countedResumePolicy{}))
			_, err := svc.ensureRuntimeWorkspaceRunningLocked(context.Background(), row, row.UserID)
			failure := apiErrorOf(t, err)
			assert.Equal(t, http.StatusServiceUnavailable, failure.Status)
			assert.Equal(t, pkgerrors.CodeHostLeaseLost, failure.Code)
			assert.Equal(t, pkgerrors.FaultInfra, failure.Fault)
			assert.Contains(t, failure.Message, "Use another workspace, or retry when this worker is available.")
		})
	}
}

// A worker that dies while a command runs is the same infrastructure fault as
// one lost before it starts (found by the plue recovery drill, 2026-09-29).
func TestWorkspaceCommandOnALostWorkerFailsAsInfra(t *testing.T) {
	lost := fmt.Errorf("exec: %w", &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable,
		Code: "host_lease_lost", Message: "The workspace worker is unavailable. Use another workspace, or retry when this worker is available."})
	failure := apiErrorOf(t, runtimeOperationError("execute workspace command", lost))
	assert.Equal(t, http.StatusServiceUnavailable, failure.Status)
	assert.Equal(t, pkgerrors.CodeHostLeaseLost, failure.Code)
	assert.Equal(t, pkgerrors.FaultInfra, failure.Fault)

	other := apiErrorOf(t, runtimeOperationError("execute workspace command", fmt.Errorf("boom")))
	assert.Equal(t, http.StatusInternalServerError, other.Status)
	assert.Equal(t, "execute workspace command: boom", other.Message)
}

type lostWorkerRepositoryRuntime struct {
	workspaceapi.WorkspaceRuntime
	lost error
}

func (lostWorkerRepositoryRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{PersistentFiles: true, Execution: true, FileOperations: true}
}

func (lostWorkerRepositoryRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}

func (r lostWorkerRepositoryRuntime) ListFiles(context.Context, string, string) ([]workspaceapi.FileEntry, error) {
	return nil, r.lost
}

func (r lostWorkerRepositoryRuntime) ExecuteCommand(context.Context, string, workspaceapi.Command) (workspaceapi.CommandResult, error) {
	return workspaceapi.CommandResult{}, r.lost
}

// The repository check runs on every resume, provision and command after the
// box answers; a worker lost there is the same infrastructure fault.
func TestWorkspaceRepositoryCheckOnALostWorkerFailsAsInfra(t *testing.T) {
	lost := fmt.Errorf("files: %w", &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable,
		Code: "host_lease_lost", Message: "The workspace worker is unavailable. Use another workspace, or retry when this worker is available."})
	row := sampleDBWorkspace("ws-repo-lost")
	row.Status = "running"
	row.VmID = "vm-repo-lost"
	svc := newWorkspaceServiceForTests(&repositoryIdentityQuerier{}, WithWorkspaceRuntime(lostWorkerRepositoryRuntime{lost: lost}),
		WithWorkspaceGitBaseURL("https://smithers.example"))
	_, err := svc.ensureRuntimeWorkspaceRunningLocked(context.Background(), row, row.UserID)
	failure := apiErrorOf(t, err)
	assert.Equal(t, http.StatusServiceUnavailable, failure.Status)
	assert.Equal(t, pkgerrors.CodeHostLeaseLost, failure.Code)
	assert.Equal(t, pkgerrors.FaultInfra, failure.Fault)
}

type repositoryIdentityQuerier struct{ mockWorkspaceQuerier }

func (*repositoryIdentityQuerier) GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "alice", RepoName: "demo"}, nil
}
