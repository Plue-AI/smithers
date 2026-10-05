package hostexec

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// configure sets c for the test.
func configure(t *testing.T, c Config) {
	t.Helper()
	restore, err := Configure(c)
	require.NoError(t, err)
	t.Cleanup(restore)
}

// Configure takes git only by an absolute path, and a base environment that
// names no loader or git variable.
func TestConfigureRefusesWhatWouldInheritOrSearch(t *testing.T) {
	for name, c := range map[string]Config{
		"git by name":             {Git: "git"},
		"relative helpers":        {Git: "/bin/git", GitExecPath: "libexec/git-core"},
		"git variable in base":    {Git: "/bin/git", Environment: []string{"GIT_CONFIG_PARAMETERS='core.hookspath'='/x'"}},
		"loader variable in base": {Git: "/bin/git", Environment: []string{"DYLD_INSERT_LIBRARIES=/x.dylib"}},
		"malformed entry":         {Git: "/bin/git", Environment: []string{"PATH"}},
	} {
		_, err := Configure(c)
		require.Error(t, err, name)
	}
}

// Configured, every git child runs the configured git by its absolute path,
// with hooks pinned off and an environment built from the base: no system or
// user configuration, the configured helper and template directories, and
// nothing of the process environment.
func TestConfiguredGit(t *testing.T) {
	t.Setenv("GIT_CONFIG_PARAMETERS", "'core.hookspath'='/hostile'")
	t.Setenv("HOSTILE", "1")
	git := filepath.Join(t.TempDir(), "git")
	require.NoError(t, os.WriteFile(git, []byte("#!/bin/sh\n"), 0o755))
	configure(t, Config{Git: git, GitExecPath: "/opt/bundle/libexec/git-core", GitTemplateDir: "/opt/bundle/share/git-core/templates",
		Environment: []string{"PATH=/opt/bundle/bin:/usr/bin:/bin", "HOME=/Users/owner"}})
	cmd := Git(context.Background(), "--git-dir", "/r", "update-ref", "refs/x", "abc")
	require.Equal(t, git, cmd.Path)
	require.Equal(t, []string{git, "-c", "core.hooksPath=/dev/null", "--git-dir", "/r", "update-ref", "refs/x", "abc"}, cmd.Args)
	require.Equal(t, []string{"PATH=/opt/bundle/bin:/usr/bin:/bin", "HOME=/Users/owner", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0", "GIT_EXEC_PATH=/opt/bundle/libexec/git-core", "GIT_TEMPLATE_DIR=/opt/bundle/share/git-core/templates"}, cmd.Env)
	value, ok := Lookup("HOME")
	require.True(t, ok)
	require.Equal(t, "/Users/owner", value)
	_, ok = Lookup("HOSTILE")
	require.False(t, ok)
	// A test may wrap the constructor; the program, arguments and
	// environment are the same.
	var named string
	wrapped := GitWith(context.Background(), func(ctx context.Context, name string, args ...string) *exec.Cmd {
		named = name
		return Git(ctx, args[2:]...)
	}, "status")
	require.Equal(t, git, named)
	require.Equal(t, cmd.Env, wrapped.Env)
}

// Unconfigured (hosted deployments, tests), git is the one PATH names, by
// its absolute path, and the base environment is the process environment
// without any loader or git variable.
func TestUnconfiguredGit(t *testing.T) {
	directory := t.TempDir()
	git := filepath.Join(directory, "git")
	require.NoError(t, os.WriteFile(git, []byte("#!/bin/sh\n"), 0o755))
	mu.Lock()
	previous, previousLookup := configured, lookedUp
	configured, lookedUp = nil, ""
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		configured, lookedUp = previous, previousLookup
		mu.Unlock()
	})
	t.Setenv("PATH", directory)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("DYLD_LIBRARY_PATH", "/x")
	t.Setenv("LD_PRELOAD", "/x.so")
	t.Setenv("KEPT", "yes")
	cmd := Git(context.Background(), "status")
	require.NoError(t, cmd.Err)
	require.Equal(t, git, cmd.Path)
	require.Contains(t, cmd.Env, "KEPT=yes")
	for _, entry := range cmd.Env {
		require.False(t, strings.HasPrefix(entry, "DYLD_") || strings.HasPrefix(entry, "LD_") || entry == "GIT_CONFIG_COUNT=1", entry)
	}
	// Found once: a later PATH does not move it.
	t.Setenv("PATH", t.TempDir())
	require.Equal(t, git, Git(context.Background(), "status").Path)
}

// Without a git to run, the command fails at Start, as git not found, and
// runs nothing: none on PATH unconfigured, or a configured one that is gone.
func TestGitUnavailableFailsAtStart(t *testing.T) {
	configure(t, Config{Git: filepath.Join(t.TempDir(), "gone")})
	gone := Git(context.Background(), "status")
	require.ErrorIs(t, gone.Err, exec.ErrNotFound)
	mu.Lock()
	previous, previousLookup := configured, lookedUp
	configured, lookedUp = nil, ""
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		configured, lookedUp = previous, previousLookup
		mu.Unlock()
	})
	t.Setenv("PATH", t.TempDir())
	cmd := Git(context.Background(), "status")
	require.Error(t, cmd.Err)
	require.ErrorContains(t, cmd.Start(), "locate git")
}

// System tools run only by their fixed absolute paths, with a fixed
// environment.
func TestSystemTools(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("DYLD_INSERT_LIBRARIES", "/x.dylib")
	cmd := System(context.Background(), "/bin/ps", "-p", "1")
	require.NoError(t, cmd.Err)
	require.Equal(t, "/bin/ps", cmd.Path)
	require.Equal(t, SystemEnvironment, cmd.Env)
	for _, program := range []string{"ps", "lsof", "/tmp/ps", "/bin/sh"} {
		cmd := System(context.Background(), program)
		require.True(t, errors.Is(cmd.Err, ErrNotSystemTool), program)
	}
	require.True(t, slices.Contains(SystemEnvironment, "LC_ALL=C"))
}
