package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const (
	forkQuotaOwnerID   int64 = 10
	forkQuotaGranteeID int64 = 99
)

var errForkQuotaReachedSideEffect = errors.New("fork reached a side effect")

type forkQuotaRuntime struct {
	workspaceapi.WorkspaceRuntime
	starts, creates, snapshots, forks int
}

type forkQuotaBillingPolicy struct {
	BillingPolicy
	authorized []int64
	ownerErr   error
}

func (p *forkQuotaBillingPolicy) AuthorizeSandboxStart(_ context.Context, userID int64) error {
	p.authorized = append(p.authorized, userID)
	if userID == forkQuotaOwnerID {
		return p.ownerErr
	}
	return nil
}

func (*forkQuotaBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}

func (*forkQuotaRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{ColdSnapshots: true}
}

func (*forkQuotaRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceStopped}, nil
}

func (r *forkQuotaRuntime) StartWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	r.starts++
	return workspaceapi.Workspace{}, errForkQuotaReachedSideEffect
}

func (r *forkQuotaRuntime) CreateWorkspace(context.Context, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	r.creates++
	return workspaceapi.Workspace{}, errForkQuotaReachedSideEffect
}

func (r *forkQuotaRuntime) CreateColdSnapshot(context.Context, string, workspaceapi.ColdSnapshotSpec) (workspaceapi.ColdSnapshot, error) {
	r.snapshots++
	return workspaceapi.ColdSnapshot{}, errForkQuotaReachedSideEffect
}

func (r *forkQuotaRuntime) ForkColdSnapshot(context.Context, string, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	r.forks++
	return workspaceapi.Workspace{}, errForkQuotaReachedSideEffect
}

func (*forkQuotaRuntime) DeleteColdSnapshot(context.Context, string) error { return nil }

func forkQuotaSource() db.Workspace {
	source := sampleDBWorkspace("ws-source")
	source.UserID = forkQuotaOwnerID
	source.Status = "suspended"
	return source
}

func forkQuotaInput() ForkWorkspaceInput {
	return ForkWorkspaceInput{RepositoryID: 101, UserID: forkQuotaGranteeID, WorkspaceID: "ws-source", Name: "fork"}
}

// A write share permits a fork, but its new row belongs to the source owner.
// The owner's full quota must reject the request before any provider operation.
func TestForkWorkspace_GranteeCannotBillOwnerPastQuota(t *testing.T) {
	for _, branch := range []string{"sandbox", "runtime"} {
		t.Run(branch, func(t *testing.T) {
			source := forkQuotaSource()
			var counted []int64
			var rowCreates, sandboxStarts, sandboxCreates, sandboxForks, sandboxSnapshots int
			q := &mockWorkspaceQuerier{
				countActiveWorkspacesByUserFn: func(_ context.Context, userID int64) (int64, error) {
					counted = append(counted, userID)
					if userID == forkQuotaOwnerID {
						return MaxActiveWorkspacesPerUser, nil
					}
					return 0, nil
				},
				getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
					require.Equal(t, source.ID, arg.ID)
					require.Equal(t, source.RepositoryID, arg.RepositoryID)
					return source, nil
				},
				getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
					require.Equal(t, source.ID, arg.WorkspaceID)
					require.Equal(t, forkQuotaGranteeID, arg.GranteeUserID)
					return db.WorkspaceShare{WorkspaceID: source.ID, GranteeUserID: arg.GranteeUserID, Level: "write"}, nil
				},
				getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) { return source, nil },
				createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					rowCreates++
					return db.Workspace{}, errForkQuotaReachedSideEffect
				},
			}
			sandboxClient := &mockWorkspaceSandboxVMClient{
				getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
					return sandbox.Sandbox{ID: id, State: sandbox.StateStopped}, nil
				},
				startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
					sandboxStarts++
					return sandbox.StartResult{}, errForkQuotaReachedSideEffect
				},
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					sandboxCreates++
					return sandbox.CreateResult{}, errForkQuotaReachedSideEffect
				},
				forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
					sandboxForks++
					return sandbox.CreateResult{}, errForkQuotaReachedSideEffect
				},
				snapshotVMFn: func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
					sandboxSnapshots++
					return sandbox.SnapshotResult{}, errForkQuotaReachedSideEffect
				},
			}
			runtime := &forkQuotaRuntime{}
			options := []WorkspaceServiceOption{WithWorkspaceSandboxClient(sandboxClient)}
			if branch == "runtime" {
				options = []WorkspaceServiceOption{WithWorkspaceRuntime(runtime)}
			}
			svc := newWorkspaceServiceForTests(q, options...)

			_, err := svc.ForkWorkspace(context.Background(), forkQuotaInput())
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, pkgerrors.CodeQuotaExceeded, apiErr.Code)
			assert.Equal(t, http.StatusTooManyRequests, apiErr.Status)
			assert.Contains(t, counted, forkQuotaOwnerID, "the new row is billed to the source owner")
			assert.Zero(t, rowCreates, "quota rejection must precede row creation")
			assert.Zero(t, sandboxStarts, "quota rejection must not resume the source sandbox")
			assert.Zero(t, sandboxCreates)
			assert.Zero(t, sandboxForks)
			assert.Zero(t, sandboxSnapshots)
			assert.Zero(t, runtime.starts, "quota rejection must not resume the source runtime")
			assert.Zero(t, runtime.creates)
			assert.Zero(t, runtime.snapshots)
			assert.Zero(t, runtime.forks)
		})
	}
}

func TestForkWorkspace_GranteeCannotBypassOwnerBillingPolicy(t *testing.T) {
	source := forkQuotaSource()
	source.VmID = "" // Keep the policy assertion independent of resume admission.
	denied := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "owner plan denied")
	policy := &forkQuotaBillingPolicy{ownerErr: denied}
	var rowCreates int
	q := &mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(context.Context, int64) (int64, error) { return 0, nil },
		getWorkspaceByRepoFn:          func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: source.ID, GranteeUserID: forkQuotaGranteeID, Level: "write"}, nil
		},
		createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
			rowCreates++
			return db.Workspace{}, errForkQuotaReachedSideEffect
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(policy), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.ForkWorkspace(context.Background(), forkQuotaInput())
	assert.ErrorIs(t, err, denied)
	assert.Contains(t, policy.authorized, forkQuotaOwnerID)
	assert.Zero(t, rowCreates)
}

// A grantee's full quota cannot block a row that will be owned by someone else.
func TestForkWorkspace_GranteeAtCapBillsSourceOwner(t *testing.T) {
	source := forkQuotaSource()
	source.VmID = "" // No resume is needed before the row insert.
	var counted []int64
	var createdFor int64
	q := &mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(_ context.Context, userID int64) (int64, error) {
			counted = append(counted, userID)
			if userID == forkQuotaGranteeID {
				return MaxActiveWorkspacesPerUser, nil
			}
			return MaxActiveWorkspacesPerUser - 1, nil
		},
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
		getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
			return db.WorkspaceShare{WorkspaceID: source.ID, GranteeUserID: forkQuotaGranteeID, Level: "write"}, nil
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			createdFor = arg.UserID
			return db.Workspace{}, errForkQuotaReachedSideEffect
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.ForkWorkspace(context.Background(), forkQuotaInput())
	require.ErrorContains(t, err, errForkQuotaReachedSideEffect.Error())
	require.Equal(t, forkQuotaOwnerID, createdFor)
	require.Contains(t, counted, forkQuotaOwnerID)
}

// A caller without a write grant cannot probe or spend the source owner's quota.
func TestForkWorkspace_UnauthorizedCallerRejectedBeforeOwnerQuota(t *testing.T) {
	for _, branch := range []string{"sandbox", "runtime"} {
		t.Run(branch, func(t *testing.T) {
			source := forkQuotaSource()
			var counted []int64
			var rowCreates int
			q := &mockWorkspaceQuerier{
				countActiveWorkspacesByUserFn: func(_ context.Context, userID int64) (int64, error) {
					counted = append(counted, userID)
					return MaxActiveWorkspacesPerUser, nil
				},
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
				getWorkspaceShareFn: func(context.Context, db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
					return db.WorkspaceShare{}, pgx.ErrNoRows
				},
				createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					rowCreates++
					return db.Workspace{}, errForkQuotaReachedSideEffect
				},
			}
			options := []WorkspaceServiceOption{WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})}
			if branch == "runtime" {
				options = []WorkspaceServiceOption{WithWorkspaceRuntime(&forkQuotaRuntime{})}
			}
			_, err := newWorkspaceServiceForTests(q, options...).ForkWorkspace(context.Background(), forkQuotaInput())
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			require.Equal(t, pkgerrors.CodeForbidden, apiErr.Code)
			require.Empty(t, counted, "authorization must precede quota checks")
			require.Zero(t, rowCreates)
		})
	}
}

// Legacy hosted fixtures explicitly model repositories without a stack.
func (*mockWorkspaceQuerier) GetMythicalStack(context.Context, int64) (db.MythicalStack, error) {
	return db.MythicalStack{}, pgx.ErrNoRows
}

func TestHostedForkRefusesStackBeforeMachineEffects(t *testing.T) {
	for _, stackErr := range []error{nil, errors.New("stack lookup failed")} {
		t.Run(fmt.Sprint(stackErr), func(t *testing.T) {
			source := forkQuotaSource()
			q := &userRefStackQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
				getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return source, nil },
				createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					t.Fatal("created a fork row")
					return db.Workspace{}, nil
				},
			}, stackErr: stackErr}
			// Tripwires observe row creation and every fork machine operation.
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
					t.Fatal("inspected source")
					return sandbox.Sandbox{}, nil
				},
				startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
					t.Fatal("started source")
					return sandbox.StartResult{}, nil
				},
				forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
					t.Fatal("copied source")
					return sandbox.CreateResult{}, nil
				},
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					t.Fatal("created machine")
					return sandbox.CreateResult{}, nil
				},
			}))
			_, err := svc.ForkWorkspace(context.Background(), ForkWorkspaceInput{RepositoryID: source.RepositoryID, UserID: source.UserID, WorkspaceID: source.ID})
			var failure *pkgerrors.APIError
			require.ErrorAs(t, err, &failure)
			if stackErr == nil {
				require.Equal(t, http.StatusServiceUnavailable, failure.Status)
			} else {
				require.Equal(t, http.StatusInternalServerError, failure.Status)
			}
		})
	}
}

// A compatibility store must prove the absence of a stack, not assume it.
type forkStoreWithoutStackReader struct{ WorkspaceQuerier }

func TestHostedForkRefusesMissingStackReader(t *testing.T) {
	svc := newWorkspaceServiceForTests(forkStoreWithoutStackReader{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.forkSandboxWorkspace(context.Background(), forkQuotaInput(), forkQuotaSource())
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, http.StatusServiceUnavailable, failure.Status)
}
