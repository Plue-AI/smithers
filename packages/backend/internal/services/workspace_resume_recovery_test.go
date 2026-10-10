package services

// Workspace resume must recover when the controller reports that a persisted
// sandbox no longer exists or cannot be resumed.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A missing sandbox on the no-input resume path advises a fresh create instead
// of retrying a resource the controller has already forgotten.
func TestWorkspaceService_EnsureExistingWorkspaceRunning_TreatsMissingSandboxAsGone(t *testing.T) {
	t.Parallel()

	realClient := &mockWorkspaceSandboxVMClient{getVMFn: func(context.Context, string) (sandbox.Sandbox, error) { return sandbox.Sandbox{}, sandbox.ErrNotFound }}

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(realClient))

	ws := sampleDBWorkspace("ws-deleted")
	ws.Status = "suspended"
	ws.VmID = "czly94117m21u5s8h94x"

	_, err := svc.ensureExistingWorkspaceRunning(context.Background(), ws)
	require.Error(t, err)

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "a missing sandbox must map to an APIError, got %T: %v", err, err)
	assert.Equal(t, 409, apiErr.Status, "a gone sandbox on the no-input path must be a Conflict, not a bare Internal")
	assert.Contains(t, apiErr.Message, "smithers workspace create")
}

// asleepMainMachine seeds the canonical main branch machine, owned by the
// machine service and asleep with vm, and returns the member who opens it.
// Since de86a86992 (#3565) CreateWorkspace reserves that machine in one
// PostgreSQL transaction behind the activation providers and joins it, and
// the wake passes machine admission (c240bd3cf7, #3568).
func asleepMainMachine(t *testing.T, vm string) (*pgxpool.Pool, int64, int64, db.Workspace) {
	t.Helper()
	ctx := context.Background()
	pool := newProductTestPool(t)
	member, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Name: "primary", TargetBookmark: "main", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id=$2 WHERE id=$1`, row.ID, vm)
	require.NoError(t, err)
	row, err = q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	return pool, member, repo, row
}

// Repeated controller failures must preserve the asleep machine's disk.
func TestWorkspaceService_CreateWorkspace_PreservesDiskOnServerFailure(t *testing.T) {
	t.Parallel()
	pool, member, repo, asleep := asleepMainMachine(t, "sandbox-unresumable")

	var startCalls, creates int
	var deletedVMs []string
	svc := composeHostedSandboxWake(newWorkspaceServiceForTests(
		db.New(pool),
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			},
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVMs = append(deletedVMs, vmID)
				return nil
			},
			startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
				startCalls++
				// The unresumable snapshot returns a hard controller failure every time.
				return sandbox.StartResult{}, &sandbox.StatusError{
					StatusCode: 500,
					Message:    "sandbox runtime could not restore " + vmID,
				}
			},
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				creates++
				return sandbox.CreateResult{ID: "vm-replacement"}, nil
			},
			execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				status := int32(0)
				return sandbox.ExecResult{StatusCode: &status}, nil
			},
		}),
	), pool)

	_, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{RepositoryID: repo, UserID: member, Name: "primary"})
	var refusal *pkgerrors.APIError
	require.ErrorAs(t, err, &refusal)
	assert.Equal(t, 503, refusal.Status)
	assert.Positive(t, refusal.RetryAfter)
	assert.Equal(t, 2, startCalls)
	assert.Zero(t, creates)
	assert.Empty(t, deletedVMs)
	row, err := db.New(pool).GetWorkspace(context.Background(), asleep.ID)
	require.NoError(t, err)
	assert.Equal(t, "sandbox-unresumable", row.VmID)
	assert.Equal(t, "suspended", row.Status)
}

// A single transient 500 from StartSandbox must be absorbed by the immediate retry:
// the VM resumes on the second attempt and must NOT be replaced. This protects
// genuinely flaky resumes from unnecessary (data-losing) VM reprovisioning.
func TestWorkspaceService_CreateWorkspace_RetryResumeSavesVM(t *testing.T) {
	t.Parallel()
	pool, member, repo, asleep := asleepMainMachine(t, "vm-flaky")

	var startCalls int
	createVMCalled := false
	svc := composeHostedSandboxWake(newWorkspaceServiceForTests(
		db.New(pool),
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateStopped}, nil
			},
			startVMFn: func(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
				startCalls++
				if startCalls == 1 {
					return sandbox.StartResult{}, &sandbox.StatusError{StatusCode: 500, Message: "transient"}
				}
				return sandbox.StartResult{ID: vmID}, nil
			},
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				createVMCalled = true
				return sandbox.CreateResult{ID: "vm-should-not-exist"}, nil
			},
		}),
	), pool)

	workspace, err := svc.CreateWorkspace(context.Background(), CreateWorkspaceInput{RepositoryID: repo, UserID: member, Name: "primary"})
	require.NoError(t, err)
	assert.Equal(t, asleep.ID, workspace.ID, "create joins the branch's machine")
	assert.Equal(t, 2, startCalls, "the resume must be retried exactly once and then succeed")
	assert.False(t, createVMCalled, "a retry that succeeds must NOT reprovision a fresh VM")
	assert.Equal(t, "vm-flaky", workspace.VMID, "the original VM must be preserved")
	assert.Equal(t, "running", workspace.Status)
}

// A detached provisioning goroutine that fails must drive the workspace to the
// terminal 'failed' status so pollers stop hanging (the multi client treats
// state 'failed'/'error' as terminal). Currently it only logs, so the row keeps
// its non-terminal status and clients hang until their own 4-minute deadline.
func TestWorkspaceService_ProvisionWorkspaceAsync_MarksFailedOnError(t *testing.T) {
	t.Parallel()

	failedCh := make(chan struct{}, 1)
	q := &mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			if arg.Status == "failed" {
				select {
				case failedCh <- struct{}{}:
				default:
				}
			}
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = "vm-broken"
			workspace.Status = arg.Status
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
			// A hard, non-recoverable InspectSandbox failure (not a gone VM) — ensureWorkspaceRunning returns Internal.
			return sandbox.Sandbox{}, &sandbox.StatusError{StatusCode: 500, Message: "internal"}
		},
	}))

	ws := sampleDBWorkspace("ws-async")
	ws.VmID = "vm-broken"
	ws.Status = "starting"

	svc.provisionWorkspaceAsync(context.Background(), ws, CreateWorkspaceSessionInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
	})

	select {
	case <-failedCh:
		// fixed behavior: the row reached 'failed'.
	case <-time.After(3 * time.Second):
		t.Fatal("async provisioning failure never marked the workspace 'failed'; pollers would hang")
	}
}
