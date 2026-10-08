package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestDestroySessionReturnsAfterDurableStopWhileCleanupRuns(t *testing.T) {
	stopped := false
	cleanupErr := make(chan error, 1)
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	q := &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return workspaceExecHSession("session", "ws-1", 1, "running"), nil
		},
		updateWorkspaceSessionStatusFn: func(_ context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error) {
			stopped = arg.Status == "stopped"
			return workspaceExecHSession("session", "ws-1", 1, "stopped"), nil
		},
		getWorkspaceByRepoFn: func(ctx context.Context, _ db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			if stopped {
				close(started)
				<-release
				cleanupErr <- ctx.Err()
			}
			return sampleDBWorkspace("ws-1"), nil
		},
	}
	suspended := make(chan struct{}, 1)
	client := &mockWorkspaceSandboxVMClient{suspendVMFn: func(context.Context, string) (sandbox.SuspendResult, error) {
		suspended <- struct{}{}
		return sandbox.SuspendResult{}, nil
	}}
	svc := NewWorkspaceService(q, WithWorkspaceSandboxClient(client))
	svc.launchSessionCleanup = func(name string, fn func()) { SafeGo(name, func() { defer close(finished); fn() }) }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	require.NoError(t, svc.DestroySession(ctx, "session", 101, 1))
	require.True(t, stopped, "acknowledgment requires the durable session stop")
	cancel()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not start")
	}
	close(release)
	require.NoError(t, <-cleanupErr, "request cancellation must not cancel cleanup")
	select {
	case <-finished:
		require.Empty(t, suspended, "missing admission and final capture cannot use the old VM suspend path")
	case <-time.After(time.Second):
		t.Fatal("cleanup did not finish")
	}
}
