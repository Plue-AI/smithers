package services

// A primary whose VM disappeared keeps its row for recovery and never replays
// its create. Each provisioning generation is its own create operation and
// idempotency key.
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
// de86a86992 (#3565) removed that replacement: a missing VM now answers the
// recovery row (workspace_vm_missing) and no second create is sent.

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
		_, err := svc.createFreshWorkspaceVM(context.Background(), db.Workspace{RepositoryID: 101, ID: "ws-retry", ProvisioningGeneration: generation, Kind: "container"})
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
			// c240bd3cf7 (#3568): a stopped VM's wake passes machine admission
			// and the activation providers before it reaches the start.
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client),
				WithWorkspaceTransactions(unopenedBranchTransactions{t}), WithBranchMachineProviders(branchMachineTestProviders()))
			svc.EnableMachineAdmission(nil)
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

// Reopening a branch machine whose VM a worker rollout took answers the
// recovery row and never replays the first create. de86a86992 (#3565) deleted
// the replacement-primary path this file once pinned, so no second create,
// key or row exists to collide with the first.
func TestWorkspaceService_ReopenAfterNotFound_NeverReplaysTheCreate(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	var (
		mu         sync.Mutex
		createKeys []string
		deletedVMs []string
		reclaimed  bool
	)

	svc := f.service(nil,
		WithWorkspaceGitBaseURL("https://api.smithers.sh"),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
				key, err := sandbox.RequestIdempotencyKey(ctx)
				require.NoError(t, err)
				mu.Lock()
				defer mu.Unlock()
				createKeys = append(createKeys, key)
				return sandbox.CreateResult{ID: "vm-1"}, nil
			},
			getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
				mu.Lock()
				gone := reclaimed
				mu.Unlock()
				if gone {
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
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "roninjin10",
		RepoName:     "smithers",
		Name:         "primary",
	}

	first, err := svc.CreateWorkspace(context.Background(), input)
	require.NoError(t, err)
	require.Equal(t, "vm-1", first.VMID)
	require.Equal(t, "running", first.Status)

	mu.Lock()
	reclaimed = true
	mu.Unlock()

	_, err = svc.CreateWorkspace(context.Background(), input)
	require.Error(t, err)
	assert.Equal(t, pkgerrors.CodeWorkspaceVMMissing, apiErrorOf(t, err).Code)

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, createKeys, 1, "the reopen never replays the first create")
	assert.Empty(t, deletedVMs, "the old VM reference remains for recovery")
	rows := f.branch(t, "main")
	require.Len(t, rows, 1, "no replacement row")
	assert.Equal(t, first.ID, rows[0].ID)
	assert.Equal(t, "vm-1", rows[0].VmID)
	assert.Equal(t, int32(0), rows[0].ProvisioningGeneration)
}
