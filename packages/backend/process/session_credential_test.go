//go:build unix

package process

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A signed-in terminal's credential is its session's own file, mode 0600 in a
// 0700 directory under the workspace's run/smithers/sessions; a replacement
// is atomic and the session's close removes it (T-TRM-02).
func TestRuntimeSessionTokenFile(t *testing.T) {
	ctx := context.Background()
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "session-token"})
	require.NoError(t, err)
	_, err = runtime.PutSessionToken(ctx, workspace.ID, "5e55-a", []byte("smithers_first"))
	require.Error(t, err, "a stopped workspace has no session to sign in")
	_, err = runtime.StartWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	path, err := runtime.PutSessionToken(ctx, workspace.ID, "5e55-a", []byte("smithers_first"))
	require.NoError(t, err)
	assert.Equal(t, filepath.Join("run", "smithers", "sessions", "5e55-a", "token"), path[len(path)-len(filepath.Join("run", "smithers", "sessions", "5e55-a", "token")):])
	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	directory, err := os.Stat(filepath.Dir(path))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o700), directory.Mode().Perm())
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "smithers_first\n", string(data))

	again, err := runtime.PutSessionToken(ctx, workspace.ID, "5e55-a", []byte("smithers_second"))
	require.NoError(t, err)
	assert.Equal(t, path, again, "a session keeps one file; no alias names another")
	data, err = os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "smithers_second\n", string(data))
	entries, err := os.ReadDir(filepath.Dir(path))
	require.NoError(t, err)
	assert.Len(t, entries, 1, "no temporary file is left behind")

	other, err := runtime.PutSessionToken(ctx, workspace.ID, "5e55-b", []byte("smithers_other"))
	require.NoError(t, err)
	require.NoError(t, runtime.DeleteSessionToken(ctx, workspace.ID, "5e55-a"))
	_, err = os.Stat(filepath.Dir(path))
	assert.True(t, os.IsNotExist(err), "closing session A removes A's credential")
	_, err = os.Stat(other)
	assert.NoError(t, err, "closing A leaves B's credential")
	require.NoError(t, runtime.DeleteSessionToken(ctx, workspace.ID, "5e55-a"), "a second close is a no-op")
	require.NoError(t, runtime.DeleteSessionToken(ctx, "no-such-workspace", "5e55-a"))
}

func TestRuntimeSessionTokenRefusesUnsafeInput(t *testing.T) {
	ctx := context.Background()
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "session-token-refusals"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	for _, session := range []string{"", "../escape", "a/b", "UPPER", "-lead", string(make([]byte, 65))} {
		_, err := runtime.PutSessionToken(ctx, workspace.ID, session, []byte("smithers_x"))
		assert.Error(t, err, "session %q", session)
		assert.Error(t, runtime.DeleteSessionToken(ctx, workspace.ID, session), "session %q", session)
	}
	for _, token := range [][]byte{{}, []byte("two words"), []byte("line\nbreak"), make([]byte, 513)} {
		_, err := runtime.PutSessionToken(ctx, workspace.ID, "5e55-a", token)
		assert.Error(t, err, "token %q", token)
	}
	_, err = runtime.PutSessionToken(ctx, "no-such-workspace", "5e55-a", []byte("smithers_x"))
	assert.Error(t, err)
	_, err = os.Stat(filepath.Join(filepath.Dir(workspace.Root), "run"))
	assert.True(t, os.IsNotExist(err), "a refused write creates nothing")
}
