package services

// A replacement primary is a new workspace identity, and therefore a new
// sandbox create operation and idempotency key.
//
// Production, 2026-09-15 13:30Z (API image 8f08c257): a sandbox worker rollout
// during a deploy killed the VM behind a kind=vm workspace. The create-or-reuse
// route returned that same workspace and the API logged
//
//	WARNING workspace resume failed; reprovisioning sandbox … error: microsandbox
//	api returned status 404 (not_found): Microsandbox worker operation failed
//	ERROR async workspace provisioning failed … error: create sandbox: microsandbox
//	api returned status 409 (idempotency_conflict): idempotency key was reused for
//	a different request
//
// because the replacement create re-derived the original create's
// Idempotency-Key while sending a different body. The workspace died 'failed'
// and every later open answered "workspace VM has not been provisioned".

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// reprovisionQuerier preserves the retired row while allowing a second primary
// to be created for the same repository and owner.
type reprovisionQuerier struct {
	*mockWorkspaceQuerier
	mu      sync.Mutex
	row     db.Workspace
	old     db.Workspace
	resets  int
	creates int
}

func newReprovisionQuerier(row db.Workspace) *reprovisionQuerier {
	q := &reprovisionQuerier{row: row}
	q.mockWorkspaceQuerier = &mockWorkspaceQuerier{
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			current := q.current()
			if current.Status == "failed" {
				return db.Workspace{}, pgx.ErrNoRows
			}
			return current, nil
		},
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			if id == q.row.ID {
				return q.row, nil
			}
			if id == q.old.ID {
				return q.old, nil
			}
			return db.Workspace{}, pgx.ErrNoRows
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			q.creates++
			q.row = sampleDBWorkspace("ws-replacement")
			q.row.Name, q.row.Status, q.row.VmID = arg.Name, arg.Status, ""
			return q.row, nil
		},
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			if arg.ID != q.row.ID {
				return db.Workspace{}, pgx.ErrNoRows
			}
			q.row.Status = arg.Status
			if arg.Status == "failed" {
				q.old = q.row
			}
			return q.row, nil
		},
		updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			q.mu.Lock()
			defer q.mu.Unlock()
			if arg.ID != q.row.ID {
				return db.Workspace{}, pgx.ErrNoRows
			}
			q.row.VmID = arg.VmID
			q.row.Status = arg.Status
			return q.row, nil
		},
	}
	return q
}

func (q *reprovisionQuerier) current() db.Workspace {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.row
}

// ResetWorkspaceForReprovision mirrors the real statement: clear the dead
// vm_id, return to 'starting', and open the next provisioning generation.
func (q *reprovisionQuerier) ResetWorkspaceForReprovision(_ context.Context, id string) (db.Workspace, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if id != q.row.ID {
		return db.Workspace{}, pgx.ErrNoRows
	}
	q.resets++
	q.row.VmID = ""
	q.row.Status = "starting"
	q.row.ProvisioningGeneration++
	return q.row, nil
}

// A replacement primary uses a fresh row and idempotency key. The old row and
// VM reference remain available for recovery.
func TestWorkspaceService_ReprovisionAfterNotFound_UsesFreshIdempotencyKey(t *testing.T) {
	t.Parallel()

	row := sampleDBWorkspace("ws-primary")
	row.VmID = ""
	row.Status = "pending"
	q := newReprovisionQuerier(row)

	var (
		mu           sync.Mutex
		createKeys   []string
		createdVMs   []string
		deletedVMs   []string
		vmSequence   int
		vmIsReclaimd bool
	)

	svc := newWorkspaceServiceForTests(
		q,
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				key, err := sandbox.RequestIdempotencyKey(ctx)
				require.NoError(t, err)
				mu.Lock()
				defer mu.Unlock()
				vmSequence++
				createKeys = append(createKeys, key)
				id := "vm-" + string(rune('0'+vmSequence))
				createdVMs = append(createdVMs, id)
				return sandbox.CreateResult{ID: id}, nil
			},
			getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
				mu.Lock()
				reclaimed := vmIsReclaimd
				mu.Unlock()
				if reclaimed {
					// The worker rollout took the VM with it.
					return sandbox.Sandbox{}, &sandbox.StatusError{
						StatusCode: 404,
						ErrorCode:  "not_found",
						Message:    "Microsandbox worker operation failed",
					}
				}
				return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
			},
			deleteVMFn: func(_ context.Context, vmID string) error {
				mu.Lock()
				defer mu.Unlock()
				deletedVMs = append(deletedVMs, vmID)
				return nil
			},
		}),
	)

	input := CreateWorkspaceInput{
		RepositoryID: 101,
		UserID:       1,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
		Name:         "primary",
	}

	first, err := svc.CreateWorkspace(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, "vm-1", first.VMID)
	require.Equal(t, "running", first.Status)

	mu.Lock()
	vmIsReclaimd = true
	mu.Unlock()

	// Reopening the same named identity must retire its missing VM.
	second, err := svc.CreateWorkspace(context.Background(), input)
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, createKeys, 2, "the fresh workspace must issue its own create")
	assert.NotEqual(t, createKeys[0], createKeys[1],
		"the replacement workspace must not replay the old create key")
	assert.Zero(t, q.resets, "a primary's generation and VM reference must be preserved")
	assert.Equal(t, 1, q.creates)
	assert.Equal(t, first.ID, q.old.ID)
	assert.Equal(t, "failed", q.old.Status)
	assert.Equal(t, "vm-1", q.old.VmID)
	assert.Equal(t, int32(0), q.old.ProvisioningGeneration)

	assert.NotEqual(t, first.ID, second.ID)
	assert.Equal(t, "primary", second.Name)
	assert.Equal(t, "vm-2", second.VMID, "the replacement VM must land on the fresh row")
	assert.Equal(t, "running", second.Status, "the workspace must not be left 'failed'")
	assert.NotContains(t, deletedVMs, "vm-1", "the old VM reference remains for recovery")
	assert.NotContains(t, deletedVMs, "vm-2", "the orphan sweep must never reclaim the replacement VM")
}

// Retrying the SAME attempt must converge on one sandbox: the key is derived
// from the persisted generation, so it only moves when a reprovision advances
// that generation. Without this, every retry would allocate a second VM.
func TestWorkspaceProvisionAttempt_RetryOfOneAttemptReusesKey(t *testing.T) {
	t.Parallel()

	var keys []string
	svc := newWorkspaceServiceForTests(
		&mockWorkspaceQuerier{},
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				key, err := sandbox.RequestIdempotencyKey(ctx)
				require.NoError(t, err)
				keys = append(keys, key)
				return sandbox.CreateResult{ID: "vm-retry"}, nil
			},
		}),
	)

	for _, generation := range []int32{0, 0, 1} {
		_, err := svc.createFreshWorkspaceVM(context.Background(), 101, "ws-retry", generation, "container")
		require.NoError(t, err)
	}

	require.Len(t, keys, 3)
	assert.Equal(t, keys[0], keys[1], "an identical retry within one attempt must reuse the attempt's key")
	assert.NotEqual(t, keys[0], keys[2], "the next provisioning generation must be a new logical operation")
}

func TestPrimaryOpenAfterMissingVMKeepsRecoveryRow(t *testing.T) {
	missing := &sandbox.StatusError{StatusCode: 404, ErrorCode: "not_found"}
	serverFailure := &sandbox.StatusError{StatusCode: 500, ErrorCode: "internal"}
	for _, tc := range []struct {
		name        string
		inspect     sandbox.State
		inspectErr  error
		startErrors []error
	}{
		{name: "inspect missing", inspectErr: missing},
		{name: "start missing after stopped inspect", inspect: sandbox.StateStopped, startErrors: []error{missing}},
		{name: "retry start finds missing VM", inspect: sandbox.StateStopped, startErrors: []error{serverFailure, missing}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := sampleDBWorkspace("ws-recoverable")
			row.Status = "suspended"
			row.VmID = "vm-recoverable"
			q := newReprovisionQuerier(row)
			q.mockWorkspaceQuerier.suspendRunningWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
				t.Fatal("primary must not enter reprovision transition")
				return db.Workspace{}, nil
			}
			q.mockWorkspaceQuerier.updateWorkspaceStatusFn = func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
				t.Fatal("primary must not change status on missing VM during open")
				return db.Workspace{}, nil
			}
			starts, deletes, creates := 0, 0, 0
			client := &mockWorkspaceSandboxVMClient{
				getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
					assert.Equal(t, row.VmID, id)
					return sandbox.Sandbox{ID: id, State: tc.inspect}, tc.inspectErr
				},
				startVMFn: func(_ context.Context, id string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
					assert.Equal(t, row.VmID, id)
					defer func() { starts++ }()
					return sandbox.StartResult{}, tc.startErrors[starts]
				},
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					creates++
					return sandbox.CreateResult{}, nil
				},
				deleteVMFn: func(context.Context, string) error { deletes++; return nil },
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))
			got, err := svc.ensureWorkspaceRunningOwned(context.Background(), row, CreateWorkspaceSessionInput{
				RepositoryID: row.RepositoryID, UserID: row.UserID, RepoOwner: "owner", RepoName: "repo",
			})
			require.Error(t, err)
			failure := apiErrorOf(t, err)
			assert.Equal(t, pkgerrors.CodeWorkspaceVMMissing, failure.Code)
			assert.Equal(t, 409, failure.Status)
			assert.Equal(t, row, got)
			assert.Equal(t, row, q.current())
			assert.Zero(t, q.resets)
			assert.Zero(t, creates)
			assert.Zero(t, deletes)
			assert.Equal(t, len(tc.startErrors), starts)
		})
	}
}
