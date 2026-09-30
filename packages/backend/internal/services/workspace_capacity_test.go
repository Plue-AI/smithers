package services

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// noCapacityRefusal is byte-for-byte what the controller answers when the
// worker pool has no room: HTTP 503 with the structured envelope
// {"error":{"code":"no_capacity","message":"..."}} (controller.writeStoreError
// on store.ErrNoCapacity). The transport decodes that envelope into both Code
// and ErrorCode, so a classifier that reads either one sees it.
func noCapacityRefusal() *sandbox.StatusError {
	return &sandbox.StatusError{
		StatusCode: http.StatusServiceUnavailable,
		ErrorCode:  "no_capacity",
		Code:       "no_capacity",
		Provider:   sandbox.ProviderName("microsandbox"),
		Message:    "no healthy Microsandbox worker has sufficient capacity",
	}
}

// capacityFixture wires a workspace row whose VM is healthy but suspended,
// plus a sandbox client that records every destructive call. It is the exact
// shape of the prod incident: the resume is refused for capacity while the VM
// and its disk are perfectly intact.
type capacityFixture struct {
	reg           *registrarWorkspaceQuerier
	client        *mockWorkspaceSandboxVMClient
	deletedVMs    []string
	createdVMs    int
	startAttempts int
}

func newCapacityFixture(t *testing.T, id string, resumeErr error) *capacityFixture {
	t.Helper()

	fixture := &capacityFixture{
		reg: &registrarWorkspaceQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}},
	}
	fixture.reg.state = sampleDBWorkspace(id)
	fixture.reg.state.Status = "suspended"
	fixture.reg.state.VmID = "vm-live"
	fixture.reg.mockWorkspaceQuerier.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		return fixture.reg.state, nil
	}
	fixture.reg.mockWorkspaceQuerier.suspendRunningWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		if fixture.reg.state.Status != "running" {
			return db.Workspace{}, pgx.ErrNoRows
		}
		fixture.reg.state.Status = "suspended"
		return fixture.reg.state, nil
	}
	fixture.reg.mockWorkspaceQuerier.updateWorkspaceStatusFn = func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		fixture.reg.state.Status = arg.Status
		return fixture.reg.state, nil
	}
	fixture.reg.mockWorkspaceQuerier.updateWorkspaceExecutionInfoFn = func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
		fixture.reg.state.VmID = arg.VmID
		fixture.reg.state.Status = arg.Status
		return fixture.reg.state, nil
	}

	fixture.client = &mockWorkspaceSandboxVMClient{
		getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
		},
		startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
			fixture.startAttempts++
			return sandbox.StartResult{}, resumeErr
		},
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			fixture.createdVMs++
			return sandbox.CreateResult{ID: "vm-replacement"}, nil
		},
		deleteVMFn: func(_ context.Context, vmID string) error {
			fixture.deletedVMs = append(fixture.deletedVMs, vmID)
			return nil
		},
	}
	return fixture
}

func (f *capacityFixture) service(t *testing.T) *WorkspaceService {
	t.Helper()
	return newWorkspaceServiceForTests(f.reg, WithWorkspaceSandboxClient(f.client))
}

// assertNoCapacityAPIError checks the contract the app renders: a retryable
// 503 carrying the machine-readable code and a Retry-After the client obeys.
func assertNoCapacityAPIError(t *testing.T, err error) *pkgerrors.APIError {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "a full pool must surface as a typed APIError, got %T: %v", err, err)
	assert.Equal(t, http.StatusServiceUnavailable, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeNoCapacity, apiErr.Code)
	assert.Equal(t, 30, apiErr.RetryAfter, "clients need a Retry-After to back off on")
	return apiErr
}

// assertHumanRefusal guards the app-visible shape: apps/app prints plue's
// refusal verbatim (writeRouteError passes no_capacity messages through
// isSafe5xxMessageCode uncensored), so the message must read as a sentence a
// person wrote — never the provider's "microsandbox api returned status 503
// (no_capacity): no healthy Microsandbox worker has sufficient capacity".
func assertHumanRefusal(t *testing.T, message string) {
	t.Helper()
	assert.NotEmpty(t, message)
	lower := strings.ToLower(message)
	for _, leak := range []string{"microsandbox", "api returned status", "sandbox", "vm", "503", "no_capacity"} {
		assert.NotContains(t, lower, leak, "the user-facing refusal must not leak %q", leak)
	}
	assert.Equal(t, strings.ToUpper(message[:1]), message[:1], "a sentence starts with a capital")
	assert.True(t, strings.HasSuffix(message, "."), "a sentence ends with a period: %q", message)
}

// TestEnsureWorkspaceRunning_NoCapacityKeepsTheBox is the blocker: a resume
// into a full pool must never cost the user their computer. The controller
// refuses the reservation BEFORE any worker RPC, so the guest is still
// suspended with its disk intact — reprovisioning would clear vm_id and delete
// a healthy VM for a condition that clears itself in seconds.
func TestEnsureWorkspaceRunning_NoCapacityKeepsTheBox(t *testing.T) {
	t.Parallel()

	fixture := newCapacityFixture(t, "ws-no-capacity", noCapacityRefusal())
	_, err := fixture.service(t).ensureWorkspaceRunning(context.Background(), fixture.reg.state, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "acme",
		RepoName:     "repo",
	})

	apiErr := assertNoCapacityAPIError(t, err)
	assertHumanRefusal(t, apiErr.Message)
	assert.Empty(t, fixture.deletedVMs, "a full pool must not delete the user's VM")
	assert.Zero(t, fixture.createdVMs, "a full pool must not reprovision")
	assert.Equal(t, 1, fixture.startAttempts, "retrying a full pool immediately only burns a round trip")
	assert.Equal(t, "vm-live", fixture.reg.state.VmID, "vm_id must survive so the next open resumes the same computer")
	assert.Equal(t, "suspended", fixture.reg.state.Status)
}

// The sibling resume path (SSH, fork-source warmup) carries no provisioning
// input, so it cannot reprovision — but it must still answer a retryable 503
// instead of the 500 that a bare 5xx produces.
func TestEnsureExistingWorkspaceRunning_NoCapacityKeepsTheBox(t *testing.T) {
	t.Parallel()

	fixture := newCapacityFixture(t, "ws-no-capacity-existing", noCapacityRefusal())
	_, err := fixture.service(t).ensureExistingWorkspaceRunning(context.Background(), fixture.reg.state)

	apiErr := assertNoCapacityAPIError(t, err)
	assertHumanRefusal(t, apiErr.Message)
	assert.Empty(t, fixture.deletedVMs)
	assert.Zero(t, fixture.createdVMs)
	assert.Equal(t, 1, fixture.startAttempts)
	assert.Equal(t, "vm-live", fixture.reg.state.VmID)
	assert.Equal(t, "suspended", fixture.reg.state.Status)
}

// 2026-09-30, production: /api/workflow/provision for a suspended workspace on
// the runtime path answered 500 fault=bug "start workspace runtime: microsandbox
// api returned status 503 (no_capacity): ..." (#3079). The runtime start path
// takes the same verdict as every other resume: a retryable 503 in product
// words, with the row parked.
func TestEnsureRuntimeWorkspaceRunning_NoCapacityKeepsTheBox(t *testing.T) {
	t.Parallel()

	for _, status := range []string{"suspended", "running"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			fixture := newCapacityFixture(t, "ws-runtime-no-capacity-"+status, nil)
			fixture.reg.state.Status = status
			runtime := lostWorkerRuntime{startErr: fmt.Errorf("runtime: %w", noCapacityRefusal())}
			svc := newWorkspaceServiceForTests(fixture.reg, WithWorkspaceRuntime(runtime), WithWorkspaceBillingPolicy(&countedResumePolicy{}))

			_, err := svc.ensureRuntimeWorkspaceRunningLocked(context.Background(), fixture.reg.state, fixture.reg.state.UserID)

			apiErr := assertNoCapacityAPIError(t, err)
			assert.Equal(t, pkgerrors.FaultInfra, apiErr.Fault)
			assertHumanRefusal(t, apiErr.Message)
			assert.Equal(t, "vm-live", fixture.reg.state.VmID)
			assert.Equal(t, "suspended", fixture.reg.state.Status)
		})
	}
}

// A hard 5xx (even one that reads like an unresumable snapshot) is retried
// once and then reported as retryable. The controller cannot tell a corrupt
// snapshot from an outage, and the suspended disk may hold unpushed work, so
// the VM is never replaced on a 5xx; only a 404 (vmAlreadyGone) reprovisions
// and a human discards the box with `smithers workspace create`.
func TestEnsureWorkspaceRunning_HardFailureKeepsTheBox(t *testing.T) {
	t.Parallel()

	fixture := newCapacityFixture(t, "ws-hard-5xx", &sandbox.StatusError{
		StatusCode: http.StatusInternalServerError,
		Message:    "Failed to spawn UFFD handler",
	})
	updated, err := fixture.service(t).ensureWorkspaceRunning(context.Background(), fixture.reg.state, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "acme",
		RepoName:     "repo",
	})

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusServiceUnavailable, apiErr.Status)
	assert.Positive(t, apiErr.RetryAfter)
	assert.Equal(t, 2, fixture.startAttempts, "a hard 5xx keeps its single immediate retry")
	assert.Zero(t, fixture.createdVMs, "a twice-failed resume never reprovisions")
	assert.Empty(t, fixture.deletedVMs, "the VM and its disk survive")
	assert.Equal(t, "vm-live", updated.VmID)
	assert.Equal(t, "vm-live", fixture.reg.state.VmID)
}

// The detached provisioning goroutine drives the row terminal on failure so
// pollers stop. 'failed' is the wrong verdict for a full pool when the box
// already HAS a VM: the row's status is what the UI renders as a dead box, and
// the stranded-'starting' reaper deletes a failed box's VM outright.
func TestProvisionWorkspaceAsync_NoCapacityLeavesTheBoxSuspended(t *testing.T) {
	t.Parallel()

	statuses := make(chan string, 8)
	fixture := newCapacityFixture(t, "ws-async-no-capacity", noCapacityRefusal())
	fixture.reg.state.Status = "starting"
	fixture.reg.mockWorkspaceQuerier.updateWorkspaceStatusFn = func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		fixture.reg.state.Status = arg.Status
		select {
		case statuses <- arg.Status:
		default:
		}
		return fixture.reg.state, nil
	}

	fixture.service(t).provisionWorkspaceAsync(context.Background(), fixture.reg.state, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "acme",
		RepoName:     "repo",
	})

	select {
	case status := <-statuses:
		assert.Equal(t, "suspended", status, "a full pool must park the box, not condemn it")
	case <-time.After(3 * time.Second):
		t.Fatal("async provisioning never settled the row after a no_capacity refusal")
	}
	assert.Empty(t, fixture.deletedVMs, "the box keeps its VM")
	assert.Equal(t, "vm-live", fixture.reg.state.VmID)
}
