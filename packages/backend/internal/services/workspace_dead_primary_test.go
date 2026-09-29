package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type deadPrimaryRuntime struct {
	workspaceapi.WorkspaceRuntime
	inspectErr error
	state      workspaceapi.WorkspaceState
	inspectID  string
	createFn   func(context.Context, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error)
}

func (*deadPrimaryRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

func (r *deadPrimaryRuntime) CreateWorkspace(ctx context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	return r.createFn(ctx, spec)
}

func TestCreateAsyncAfterMissingRuntimeReturnsFreshNamedRowBeforeProvisionCompletes(t *testing.T) {
	old := sampleDBWorkspace("ws-old-runtime")
	old.Status = "suspended"
	started := make(chan struct{})
	release := make(chan struct{})
	newRow := sampleDBWorkspace("ws-new-runtime")
	newRow.Status, newRow.VmID, newRow.Name = "starting", "", "fresh name"
	q := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
			return old, nil
		},
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			if arg.ID == newRow.ID {
				newRow.Status = arg.Status
				return newRow, nil
			}
			assert.Equal(t, old.ID, arg.ID)
			assert.Equal(t, "failed", arg.Status)
			old.Status = arg.Status
			return old, nil
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			assert.Equal(t, "fresh name", arg.Name)
			assert.Equal(t, "failed", old.Status)
			return newRow, nil
		},
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return newRow, nil },
	}
	runtime := &deadPrimaryRuntime{
		inspectErr: workspaceapi.ErrWorkspaceNotFound,
		createFn: func(_ context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
			assert.Equal(t, newRow.ID, spec.ID)
			close(started)
			<-release
			return workspaceapi.Workspace{}, errors.New("test provision stopped")
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		assert.NoError(t, svc.WaitForProvisioning(ctx))
	})
	response, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{RepositoryID: 101, UserID: 1, Name: "fresh name"})
	require.NoError(t, err)
	assert.Equal(t, newRow.ID, response.ID)
	assert.Equal(t, "fresh name", response.Name)
	assert.Equal(t, "starting", response.Status)
	assert.Equal(t, old.ID, runtime.inspectID)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("background provision never started")
	}
	close(release)
}

func (r *deadPrimaryRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.inspectID = id
	return workspaceapi.Workspace{ID: id, State: r.state}, r.inspectErr
}

func TestCreateAfterDeadPrimaryRetainsOldRowAndHonorsName(t *testing.T) {
	old := sampleDBWorkspace("ws-dead")
	old.Status = "suspended"
	old.VmID = "vm-dead"
	var retained, created db.Workspace
	inspectedID := ""
	base := &mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoKindFn: func(_ context.Context, arg db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
			assert.Equal(t, old.RepositoryID, arg.RepositoryID)
			assert.Equal(t, old.UserID, arg.UserID)
			assert.Equal(t, old.Kind, arg.Kind)
			return old, nil
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			require.Equal(t, "failed", retained.Status, "old row must be archived before allocating its replacement")
			assert.Equal(t, "replacement", arg.Name)
			assert.Equal(t, "main", arg.TargetBookmark)
			assert.False(t, arg.IsFork)
			created = sampleDBWorkspace("ws-replacement")
			created.Name, created.Status, created.VmID = arg.Name, "running", "vm-new"
			return created, nil
		},
		softDeleteWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			t.Fatal("the old workspace must remain recoverable")
			return db.Workspace{}, nil
		},
	}
	q := &conditionalFailureWorkspaceQuerier{
		mockWorkspaceQuerier: base,
		failUnchangedFn: func(_ context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error) {
			require.Equal(t, old.ID, arg.ID)
			require.Equal(t, old.Status, arg.ExpectedStatus)
			require.Equal(t, old.VmID, arg.ExpectedVmID)
			require.Equal(t, old.UpdatedAt, arg.ExpectedUpdatedAt)
			require.Equal(t, string(pkgerrors.CodeWorkspaceVMMissing), arg.FailureCode)
			retained = old
			retained.Status = "failed"
			return retained, nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
			inspectedID = id
			return sandbox.Sandbox{}, sandbox.ErrNotFound
		},
	}))
	got, err := svc.CreateWorkspaceAsync(context.Background(), CreateWorkspaceInput{
		RepositoryID: old.RepositoryID, UserID: old.UserID, Name: "replacement",
	})
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "replacement", got.Name)
	assert.Equal(t, old.ID, retained.ID)
	assert.Equal(t, old.VmID, retained.VmID)
	assert.Equal(t, "failed", retained.Status)
	assert.Equal(t, old.VmID, inspectedID)
}

func TestDeadPrimaryProbeOutcomes(t *testing.T) {
	lost := &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable, Code: "host_lease_lost", Message: "worker retired"}
	cases := []struct {
		name       string
		inspectErr error
		state      workspaceapi.WorkspaceState
		replace    bool
		code       pkgerrors.Code
	}{
		{name: "missing runtime", inspectErr: workspaceapi.ErrWorkspaceNotFound, replace: true},
		{name: "typed missing VM", inspectErr: pkgerrors.New(pkgerrors.CodeWorkspaceVMMissing, "VM missing"), replace: true},
		{name: "retired worker and confirmed missing", inspectErr: errors.Join(lost, workspaceapi.ErrWorkspaceNotFound), replace: true},
		{name: "lost worker alone", inspectErr: lost, code: pkgerrors.CodeHostLeaseLost},
		{name: "temporary inspection failure", inspectErr: errors.New("timeout")},
		{name: "healthy running", state: workspaceapi.WorkspaceRunning},
		{name: "stopped runtime remains recoverable", state: workspaceapi.WorkspaceStopped},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			old := sampleDBWorkspace("ws-old")
			old.Status = "running"
			failures, creates := 0, 0
			base := &mockWorkspaceQuerier{
				getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
					return old, nil
				},
				createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
					creates++
					assert.Equal(t, "new name", arg.Name)
					return sampleDBWorkspace("ws-new"), nil
				},
			}
			q := &conditionalFailureWorkspaceQuerier{
				mockWorkspaceQuerier: base,
				failUnchangedFn: func(_ context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error) {
					failures++
					assert.Equal(t, old.ID, arg.ID)
					assert.Equal(t, old.Status, arg.ExpectedStatus)
					if tc.name == "retired worker and confirmed missing" {
						assert.Equal(t, string(pkgerrors.CodeHostLeaseLost), arg.FailureCode)
					} else {
						assert.Equal(t, string(pkgerrors.CodeWorkspaceVMMissing), arg.FailureCode)
					}
					old.Status = "failed"
					return old, nil
				},
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&deadPrimaryRuntime{inspectErr: tc.inspectErr, state: tc.state}))
			got, err := svc.findOrCreatePrimaryWorkspace(context.Background(), 101, 1, "new name", "main", workspaceCreateMetadata{})
			switch {
			case tc.replace:
				require.NoError(t, err)
				assert.Equal(t, "ws-new", got.ID)
				assert.Equal(t, 1, failures)
				assert.Equal(t, 1, creates)
			case tc.inspectErr == nil:
				require.NoError(t, err)
				assert.Equal(t, "ws-old", got.ID)
				assert.Zero(t, failures)
				assert.Zero(t, creates)
			default:
				require.Error(t, err)
				if tc.code != "" {
					assert.Equal(t, tc.code, apiErrorOf(t, err).Code)
				}
				assert.Zero(t, failures)
				assert.Zero(t, creates)
			}
		})
	}
}

func TestDeadPrimarySandboxMissingVMAndFailedArchiveFence(t *testing.T) {
	for _, status := range []string{"running", "suspended"} {
		t.Run(status, func(t *testing.T) {
			old := sampleDBWorkspace("ws-old")
			old.Status = status
			created := false
			base := &mockWorkspaceQuerier{
				getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
					return old, nil
				},
				createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					created = true
					return sampleDBWorkspace("ws-new"), nil
				},
			}
			q := &conditionalFailureWorkspaceQuerier{
				mockWorkspaceQuerier: base,
				failUnchangedFn: func(_ context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error) {
					assert.Equal(t, old.ID, arg.ID)
					assert.Equal(t, old.Status, arg.ExpectedStatus)
					assert.Equal(t, old.VmID, arg.ExpectedVmID)
					return db.Workspace{}, pgx.ErrNoRows
				},
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				getVMFn: func(_ context.Context, id string) (sandbox.Sandbox, error) {
					assert.Equal(t, old.VmID, id)
					return sandbox.Sandbox{}, sandbox.ErrNotFound
				},
			}))
			_, err := svc.findOrCreatePrimaryWorkspace(context.Background(), 101, 1, "new", "main", workspaceCreateMetadata{})
			require.Error(t, err, "a stale archive fence must prevent replacement")
			assert.False(t, created)
		})
	}
}

func TestDeadPrimaryRetirementGaugeOnlyChangesForArchivedRunningRow(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      string
		casLost     bool
		wantDeltas  []float64
		wantCreates int
	}{
		{name: "running archived", status: "running", wantDeltas: []float64{-1}, wantCreates: 1},
		{name: "suspended archived", status: "suspended", wantCreates: 1},
		{name: "running CAS lost", status: "running", casLost: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row := sampleDBWorkspace("ws-old")
			row.Status = tc.status
			metrics := &workspaceRaceMetricsRecorder{}
			creates := 0
			base := &mockWorkspaceQuerier{
				getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
					return row, nil
				},
				createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					creates++
					return sampleDBWorkspace("ws-fresh"), nil
				},
			}
			q := &conditionalFailureWorkspaceQuerier{
				mockWorkspaceQuerier: base,
				failUnchangedFn: func(_ context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error) {
					assert.Equal(t, row.ID, arg.ID)
					if tc.casLost {
						return db.Workspace{}, pgx.ErrNoRows
					}
					archived := row
					archived.Status = "failed"
					return archived, nil
				},
			}
			svc := newWorkspaceServiceForTests(q,
				WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
					getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
						return sandbox.Sandbox{}, sandbox.ErrNotFound
					},
				}),
				WithWorkspaceSandboxMetrics(metrics),
			)
			got, err := svc.findOrCreatePrimaryWorkspace(context.Background(), row.RepositoryID, row.UserID, "fresh", "main", workspaceCreateMetadata{})
			if tc.casLost {
				require.Error(t, err)
				assert.Equal(t, pkgerrors.CodeConflict, apiErrorOf(t, err).Code)
			} else {
				require.NoError(t, err)
				assert.Equal(t, "ws-fresh", got.ID)
			}
			assert.Equal(t, tc.wantCreates, creates)
			assert.Equal(t, tc.wantDeltas, metrics.deltas)
		})
	}
}
