//go:build unix

package process

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestRuntimeReadFileRejectsNamedPipesWithoutWaitingForWriter(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "special-files"})
	require.NoError(t, err)
	pipe := filepath.Join(workspace.Root, "pipe")
	require.NoError(t, syscall.Mkfifo(pipe, 0o600))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := runtime.ReadFile(ctx, workspace.ID, "pipe")
		finished <- err
	}()
	select {
	case err = <-finished:
	case <-time.After(100 * time.Millisecond):
		// Release an old implementation blocked in open so failure does not
		// leave a goroutine or named-pipe descriptor behind.
		writer, openErr := os.OpenFile(pipe, os.O_WRONLY, 0)
		require.NoError(t, openErr)
		require.NoError(t, writer.Close())
		err = <-finished
		t.Error("ReadFile waited for a named-pipe writer after its context expired")
	}
	require.ErrorContains(t, err, "regular file")
}

func TestFilePathsPreserveWhitespace(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
	}{
		{name: "spaces", path: " report "},
		{name: "tabs", path: "\treport\t"},
		{name: "newlines", path: "\nreport\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			runtime := newTestRuntime(t, t.TempDir())
			workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "whitespace"})
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(workspace.Root, "report"), []byte("plain"), 0o600))
			require.NoError(t, os.WriteFile(filepath.Join(workspace.Root, test.path), []byte("spaced"), 0o600))

			entries, err := runtime.ListFiles(ctx, workspace.ID, ".")
			require.NoError(t, err)
			require.Len(t, entries, 2)
			require.ElementsMatch(t, []string{"report", test.path}, []string{entries[0].Name, entries[1].Name})

			contents, err := runtime.ReadFile(ctx, workspace.ID, test.path)
			require.NoError(t, err)
			require.Equal(t, []byte("spaced"), contents)

			require.NoError(t, runtime.WriteFile(ctx, workspace.ID, test.path, []byte("updated"), 0o600))
			contents, err = os.ReadFile(filepath.Join(workspace.Root, test.path))
			require.NoError(t, err)
			require.Equal(t, []byte("updated"), contents)
			contents, err = os.ReadFile(filepath.Join(workspace.Root, "report"))
			require.NoError(t, err)
			require.Equal(t, []byte("plain"), contents)

			require.NoError(t, runtime.RemoveFile(ctx, workspace.ID, test.path))
			_, err = os.Stat(filepath.Join(workspace.Root, test.path))
			require.ErrorIs(t, err, os.ErrNotExist)
			contents, err = os.ReadFile(filepath.Join(workspace.Root, "report"))
			require.NoError(t, err)
			require.Equal(t, []byte("plain"), contents)
		})
	}

	t.Run("directory", func(t *testing.T) {
		ctx := context.Background()
		runtime := newTestRuntime(t, t.TempDir())
		workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "whitespace-directory"})
		require.NoError(t, err)
		require.NoError(t, runtime.WriteFile(ctx, workspace.ID, " dir /report", []byte("nested"), 0o600))
		contents, err := os.ReadFile(filepath.Join(workspace.Root, " dir ", "report"))
		require.NoError(t, err)
		require.Equal(t, []byte("nested"), contents)
		_, err = os.Stat(filepath.Join(workspace.Root, "dir "))
		require.ErrorIs(t, err, os.ErrNotExist)
	})
}
