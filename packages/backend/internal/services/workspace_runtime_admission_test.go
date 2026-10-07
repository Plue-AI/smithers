package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type admissionWorkspaceRuntime struct {
	workspaceapi.WorkspaceRuntime
	starts   int
	startErr error
}

func (r *admissionWorkspaceRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceStopped}, nil
}
func (r *admissionWorkspaceRuntime) StartWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	r.starts++
	return workspaceapi.Workspace{}, r.startErr
}

func TestWorkspaceRuntimeResumeRequiresAdmission(t *testing.T) {
	denied := errors.New("new sandbox slot denied")
	startFailed := errors.New("runtime start reached")
	for _, status := range []string{"running", "suspended"} {
		t.Run(status, func(t *testing.T) {
			policy := &countedResumePolicy{startErr: denied}
			runtime := &admissionWorkspaceRuntime{startErr: startFailed}
			row := sampleDBWorkspace("ws-runtime-admission")
			row.Status = status
			row.VmID = "vm-counted"
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceBillingPolicy(policy), WithWorkspaceRuntime(runtime))
			_, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), row, row.UserID)
			require.ErrorContains(t, err, "branch wake requires admission and validated privileged entry")
			require.Zero(t, runtime.starts)
			require.Zero(t, policy.countedCalls)

		})
	}
}

// A failed person wake must not cancel the TODO sharing its branch, even when
// the person owns that workspace. Cover both sides of the lifecycle lock.
func TestWorkspaceRuntimeFailedOwnerWakeCancelsPersonOnly(t *testing.T) {
	for _, boundary := range []string{"refresh", "locked"} {
		t.Run(boundary, func(t *testing.T) {
			row := sampleDBWorkspace("failed-owner-wake")
			row.Status = "failed"
			runtime := new(microsandbox.Runtime)
			holder := machineQueueHolder(row.ID)
			person := fmt.Sprintf("person:%d", row.UserID)
			_, err := runtime.Request("todo", holder, holder, "machine")
			require.NoError(t, err)
			_, err = runtime.Request("person", "workspace:other", "person:999", "terminal")
			require.NoError(t, err)
			_, err = runtime.Request("person", holder, person, "terminal")
			require.NoError(t, err)
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
				return db.Workspace{}, errors.New("refresh unavailable")
			}}
			service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			service.EnableMachineAdmission(nil)
			ctx := personMachineDemand(t.Context())
			if boundary == "refresh" {
				_, err = service.ensureRuntimeWorkspaceRunning(ctx, row, row.UserID)
			} else {
				_, err = service.ensureRuntimeWorkspaceRunningLocked(ctx, row, row.UserID)
			}
			require.Error(t, err)
			rows := runtime.AdmissionSnapshot()
			require.Len(t, rows, 3)
			require.Equal(t, "waiting", rows[0].State, "TODO demand survives the person's failure")
			require.Equal(t, 2, rows[0].Position)
			require.Equal(t, "waiting", rows[1].State)
			require.Equal(t, 1, rows[1].Position)
			require.Equal(t, "cancelled", rows[2].State)
			require.Zero(t, rows[2].Position)
			require.Zero(t, runtime.InUse())
		})
	}
}
