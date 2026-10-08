package compose

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestRehearsalAdmissionOrderingAndHandoff(t *testing.T) {
	r := &rehearsalAdmissionRuntime{aliases: map[string]string{}}
	require.Error(t, r.SyncTodoAdmission("", []string{"todo:1"}, 1))
	require.False(t, r.TodoAdmissionEligible("todo:1"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:1", "todo:2"}, 1))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.False(t, r.TodoAdmissionEligible("todo:2"))
	require.NoError(t, r.TransferTodoAdmission("todo:2", "workspace:2"), "waiting demand can transfer without an eligible grant")
	require.False(t, r.TodoAdmissionEligible("workspace:2"))
	require.Error(t, r.TransferTodoAdmission("todo:1", ""))
	require.NoError(t, r.TransferTodoAdmission("todo:1", "workspace:1"))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.True(t, r.TodoAdmissionEligible("workspace:1"))
	require.Error(t, r.TransferTodoAdmission("todo:1", "workspace:3"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:2", "todo:1"}, 1))
	require.True(t, r.TodoAdmissionEligible("todo:2"))
	require.False(t, r.TodoAdmissionEligible("workspace:1"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:1"}, 0))
	require.False(t, r.TodoAdmissionEligible("todo:1"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", nil, 2))
	require.False(t, r.TodoAdmissionEligible("workspace:1"))
	r.releaseTodoAdmission("workspace:1")
	require.False(t, r.TodoAdmissionEligible("todo:1"))
	require.NoError(t, r.TransferTodoAdmission("todo:1", "workspace:3"), "production permits handing off a confirmed released demand")
	require.False(t, r.TodoAdmissionEligible("workspace:1"), "handoff alone never grants released demand")
	require.False(t, r.TodoAdmissionEligible("workspace:3"))
	require.Error(t, r.TransferTodoAdmission("workspace:1", "workspace:4"), "a retained origin cannot transfer an active grant")
}

// The assisted runtime must account for a real process stop just as the VM
// scheduler accounts for confirmed stop. It cannot invent a safe-idle release.
func TestRehearsalAdmissionReviewConfirmedStop(t *testing.T) {
	p, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, p.Close()) })
	ctx := t.Context()
	_, err = p.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "review"})
	require.NoError(t, err)
	_, err = p.StartWorkspace(ctx, "review")
	require.NoError(t, err)
	_, err = p.StartService(ctx, "review", workspaceapi.ServiceSpec{Name: "review-host", Command: workspaceapi.Command{Args: []string{"/bin/sleep", "60"}}})
	require.NoError(t, err)
	r := &rehearsalAdmissionRuntime{Runtime: p, aliases: map[string]string{}, reviewRequests: map[string]microsandbox.AdmissionRequest{
		"workspace:review": {Holder: "workspace:review", Class: "background", Actor: "review:1", State: "granted"},
	}}
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:1", "todo:2"}, 2))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.False(t, r.TodoAdmissionEligible("todo:2"))
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	require.ErrorIs(t, r.StopWorkspace(cancelled, "review"), context.Canceled)
	require.Equal(t, "granted", r.reviewRequests["workspace:review"].State, "failed stop retains review demand")
	host, err := p.InspectService(ctx, "review", "review-host")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.ServiceRunning, host.State)
	require.NoError(t, r.StopWorkspace(ctx, "review"))
	observed, err := p.InspectWorkspace(ctx, "review")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
	host, err = p.InspectService(ctx, "review", "review-host")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.ServiceStopped, host.State)
	require.Equal(t, "released", r.reviewRequests["workspace:review"].State)
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:1", "todo:2"}, 2))
	require.True(t, r.TodoAdmissionEligible("todo:2"), "a stopped review no longer consumes parallel")
	require.NoError(t, r.StopWorkspace(ctx, "review"), "repeated confirmed stop is idempotent")
	require.Equal(t, "released", r.reviewRequests["workspace:review"].State)
}
