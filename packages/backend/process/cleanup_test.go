package process

import (
	"context"
	"errors"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestFinalCaptureExcludesRuntimeWritersThroughRemoval(t *testing.T) {
	r, err := New(Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	ctx := t.Context()
	_, err = r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "one"})
	require.NoError(t, err)
	_, err = r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "other"})
	require.NoError(t, err)
	require.NoError(t, r.WriteFile(ctx, "one", "saved", []byte("saved"), 0600))
	entered, finish := make(chan struct{}), make(chan struct{})
	r.BindCleanupCapture(func(ctx context.Context, binding workspaceapi.CleanupWorkspace, consume func(workspaceapi.DiskReclaimCapture) error) error {
		return r.WithCaptureWritersExcluded(ctx, binding.ID, func(ctx context.Context) error {
			close(entered)
			<-finish
			return consume(workspaceapi.DiskReclaimCapture{WorkspaceID: binding.ID})
		})
	})
	done := make(chan error, 1)
	go func() {
		done <- r.WithFinalCapture(ctx, workspaceapi.CleanupWorkspace{ID: "one"}, func(workspaceapi.DiskReclaimCapture) error { return r.ReclaimWorkspaceDisk(ctx, "one") })
	}()
	<-entered
	require.ErrorIs(t, r.WriteFile(ctx, "one", "saved", []byte("lost"), 0600), workspaceapi.ErrCleanupBusy)
	require.ErrorIs(t, r.WriteFile(ctx, " one ", "saved", []byte("lost"), 0600), workspaceapi.ErrCleanupBusy)
	require.ErrorIs(t, r.RemoveFile(ctx, "one", "saved"), workspaceapi.ErrCleanupBusy)
	_, err = r.StartWorkspace(ctx, "one")
	require.ErrorIs(t, err, workspaceapi.ErrCleanupBusy)
	_, err = r.ExecuteCommand(ctx, "one", workspaceapi.Command{Args: []string{"/bin/true"}})
	require.ErrorIs(t, err, workspaceapi.ErrCleanupBusy)
	_, err = r.OpenWorkspaceTerminal(ctx, "one", workspaceapi.Command{Args: []string{"/bin/sh"}})
	require.ErrorIs(t, err, workspaceapi.ErrCleanupBusy)
	require.ErrorIs(t, r.DeleteWorkspace(ctx, "one"), workspaceapi.ErrCleanupBusy)
	require.NoError(t, r.WriteFile(ctx, "other", "independent", []byte("ok"), 0600))
	close(finish)
	require.NoError(t, <-done)
	ws, err := r.StartWorkspace(ctx, "one")
	require.NoError(t, err)
	require.DirExists(t, ws.Root)
	require.NoFileExists(t, ws.Root+"/saved")
}

func TestFinalCaptureRefusesUnavailableBusyAndCancelledContracts(t *testing.T) {
	r, err := New(Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, r.Close()) })
	ctx := t.Context()
	_, err = r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "one"})
	require.NoError(t, err)
	consume := func(workspaceapi.DiskReclaimCapture) error {
		t.Error("missing contract authorized deletion")
		return nil
	}
	require.ErrorContains(t, r.WithFinalCapture(ctx, workspaceapi.CleanupWorkspace{ID: "one"}, consume), "authority unavailable")
	r.BindCleanupCapture(func(context.Context, workspaceapi.CleanupWorkspace, func(workspaceapi.DiskReclaimCapture) error) error {
		return errors.New("capture failed")
	})
	require.ErrorContains(t, r.WithFinalCapture(ctx, workspaceapi.CleanupWorkspace{ID: "one"}, consume), "capture failed")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	require.ErrorIs(t, r.WithFinalCapture(cancelled, workspaceapi.CleanupWorkspace{ID: "one"}, consume), context.Canceled)
	_, release, err := r.CleanupGate.Enter(ctx, "one")
	require.NoError(t, err)
	require.ErrorIs(t, r.WithFinalCapture(ctx, workspaceapi.CleanupWorkspace{ID: "one"}, consume), workspaceapi.ErrCleanupBusy)
	release()
	require.NoError(t, r.WriteFile(ctx, "one", "retained", []byte("safe"), 0600))
}
