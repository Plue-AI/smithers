package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

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

func (r *deadPrimaryRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.inspectID = id
	return workspaceapi.Workspace{ID: id, State: r.state}, r.inspectErr
}

// Reserving a branch machine never probes, retires or replaces the machine
// the branch already has. de86a86992 (#3565) deleted the missing-runtime
// retirement that archived a dead primary and allocated a replacement row;
// the open that follows answers a missing VM with the recovery row instead
// (TestPrimaryOpenAfterMissingVMKeepsRecoveryRow).
func TestDeadPrimaryProbeOutcomes(t *testing.T) {
	lost := &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable, Code: "host_lease_lost", Message: "worker retired"}
	cases := []struct {
		name       string
		inspectErr error
		state      workspaceapi.WorkspaceState
	}{
		{name: "missing runtime", inspectErr: workspaceapi.ErrWorkspaceNotFound},
		{name: "typed missing VM", inspectErr: pkgerrors.New(pkgerrors.CodeWorkspaceVMMissing, "VM missing")},
		{name: "retired worker and confirmed missing", inspectErr: errors.Join(lost, workspaceapi.ErrWorkspaceNotFound)},
		{name: "lost worker alone", inspectErr: lost},
		{name: "temporary inspection failure", inspectErr: errors.New("timeout")},
		{name: "healthy running", state: workspaceapi.WorkspaceRunning},
		{name: "stopped runtime remains recoverable", state: workspaceapi.WorkspaceStopped},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newBranchMachineFixture(t)
			for _, status := range []string{"running", "suspended"} {
				branch := "dead/" + status
				old := f.machine(t, db.CreateWorkspaceParams{Name: "old name", TargetBookmark: branch, Status: status})
				f.exec(t, `UPDATE workspaces SET vm_id='vm-old' WHERE id=$1`, old.ID)
				runtime := &deadPrimaryRuntime{inspectErr: tc.inspectErr, state: tc.state}
				svc := f.service(nil, WithWorkspaceRuntime(runtime))
				got, err := svc.findOrCreatePrimaryWorkspace(context.Background(), f.repo, f.user, "new name", branch, workspaceCreateMetadata{})
				require.NoError(t, err)
				assert.Equal(t, old.ID, got.ID, "the branch keeps its machine")
				assert.Empty(t, runtime.inspectID, "reservation never probes the runtime")
				rows := f.branch(t, branch)
				require.Len(t, rows, 1)
				assert.Equal(t, status, rows[0].Status, "an unprobed machine is never archived")
				assert.Equal(t, "vm-old", rows[0].VmID)
				assert.Equal(t, "old name", rows[0].Name)
			}
		})
	}
}
