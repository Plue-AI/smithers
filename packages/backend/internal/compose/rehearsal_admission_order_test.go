package compose

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestRehearsalDaemonProbeWaitsForRepositorySetup(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	machine, err := runtime.CreateWorkspace(t.Context(), workspaceapi.WorkspaceSpec{ID: uuid.NewString()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.DeleteWorkspace(context.WithoutCancel(t.Context()), machine.ID)) })
	observed, err := runtime.InspectWorkspace(t.Context(), machine.ID)
	require.NoError(t, err)
	rehearsal := bindingProcessRuntime{rehearsalAdmissionRuntime: &rehearsalAdmissionRuntime{Runtime: runtime}, t: t}
	for range 5 {
		require.ErrorIs(t, rehearsal.EnsureMachined(t.Context(), machine.ID), machined.ErrNotReady)
		require.NoDirExists(t, filepath.Join(observed.Root, ".jj"), "a presence probe cannot initialize the repository ahead of normal setup")
	}
}

func TestRehearsalMainReplacementKeepsValidTree(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "rehearsal-owner", "app.git")
	require.NoError(t, os.MkdirAll(filepath.Dir(dir), 0700))
	git := func(input string, args ...string) string {
		t.Helper()
		cmd := exec.Command("/usr/bin/git", append([]string{"--git-dir", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_AUTHOR_NAME=Outside", "GIT_AUTHOR_EMAIL=outside@example.com", "GIT_COMMITTER_NAME=Outside", "GIT_COMMITTER_EMAIL=outside@example.com")
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("", "init", "--bare", dir)
	tree := git("", "mktree")
	seed := git("", "commit-tree", tree, "-m", "seed")
	git("", "update-ref", "refs/heads/main", seed)
	r := &rehearsal{gitRoot: root}
	for _, content := range []string{"original\n", "replacement\n", "latest\n"} {
		head, err := r.pushMain("JOURNEY.md", content, "external main")
		require.NoError(t, err)
		require.Equal(t, strings.TrimSpace(content), git("", "show", head+":JOURNEY.md"))
		require.Len(t, strings.Split(git("", "ls-tree", head), "\n"), 1)
	}
	git("", "fsck", "--no-reflogs")
}
