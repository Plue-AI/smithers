package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
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

// Legacy hosted fixtures explicitly model repositories without a stack.
func (*mockWorkspaceQuerier) GetMythicalStack(context.Context, int64) (db.MythicalStack, error) {
	return db.MythicalStack{}, pgx.ErrNoRows
}

func TestHostedForkRefusesMissingAdmissionBeforeMachineEffects(t *testing.T) {
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
			require.Equal(t, http.StatusServiceUnavailable, failure.Status)
			require.Contains(t, failure.Message, "branch machine providers unavailable")
		})
	}
}

// A store without the stack contract cannot fall back to copying a machine.
type forkStoreWithoutStackReader struct{ WorkspaceQuerier }

func TestHostedForkRefusesMissingStackReader(t *testing.T) {
	svc := newWorkspaceServiceForTests(forkStoreWithoutStackReader{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err := svc.ForkWorkspace(context.Background(), forkQuotaInput())
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, http.StatusServiceUnavailable, failure.Status)
}
