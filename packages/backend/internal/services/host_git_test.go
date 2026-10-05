package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/hostexec"
)

// Ruling §17.3 (b) and (c), Fable round 3 B1, Astra round 3 X1 and X2: every
// git the services start (mirror sync, GitHub main pull, source retention
// and import, wiki sync, repository sync) is the configured git by its
// absolute path, with hooks pinned off and an environment built for it. A
// git first on PATH never runs, and a GIT_* variable of the process never
// reaches git.
func TestServicesRunOnlyTheConfiguredGit(t *testing.T) {
	log := filepath.Join(t.TempDir(), "invocations")
	configured := filepath.Join(t.TempDir(), "git")
	require.NoError(t, os.WriteFile(configured, []byte(`#!/bin/sh
printf 'argv %s\n' "$*" >> '`+log+`'
env | grep '^GIT_CONFIG_PARAMETERS=\|^GIT_SSH_COMMAND=' | sed 's/^/ambient /' >> '`+log+`'
exit 0
`), 0o755))
	restore, err := hostexec.Configure(hostexec.Config{Git: configured, Environment: []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + t.TempDir()}})
	require.NoError(t, err)
	t.Cleanup(restore)

	markers, hostile := t.TempDir(), t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(hostile, "git"), []byte("#!/bin/sh\necho ran > '"+filepath.Join(markers, "git")+"'\n"), 0o755))
	t.Setenv("PATH", hostile+string(filepath.ListSeparator)+os.Getenv("PATH"))
	t.Setenv("GIT_CONFIG_PARAMETERS", "'core.hookspath'='"+hostile+"'")
	t.Setenv("GIT_SSH_COMMAND", filepath.Join(hostile, "git"))

	ctx := context.Background()
	runs := map[string]func() error{
		"mirror sync": func() error {
			return mirrorCommand(ctx, "ls-remote", "--refs", "https://user:secret@example.invalid/a.git").Run()
		},
		"GitHub main pull": func() error {
			return gitHubMainPullCommand(ctx, "ls-remote", "--refs", "https://example.invalid/a.git", "main").Run()
		},
		"source retention": func() error {
			return sourceRetentionGitCommand(ctx, sourceRetentionGitEnv("https://example.invalid/a.git", "Bearer t"), "fetch", "https://example.invalid/a.git").Run()
		},
		"repository sync": func() error {
			return NewRepoSyncService(t.TempDir(), nil).runGit(ctx, "init", "--bare", filepath.Join(t.TempDir(), "r.git"))
		},
		"wiki sync": func() error {
			sync, err := NewObsidianSync(t.TempDir())
			if err != nil {
				return err
			}
			defer sync.Close()
			_, err = sync.git(ctx, nil, "rev-parse", "--is-inside-work-tree")
			return err
		},
	}
	for name, run := range runs {
		require.NoError(t, run(), name)
	}

	entries, err := os.ReadDir(markers)
	require.NoError(t, err)
	require.Empty(t, entries, "a git found through PATH ran")
	raw, err := os.ReadFile(log)
	require.NoError(t, err)
	var argv []string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		require.False(t, strings.HasPrefix(line, "ambient "), "a process GIT_* variable reached git: %s", line)
		argv = append(argv, line)
	}
	require.Len(t, argv, len(runs), "each service ran the configured git once")
	for _, line := range argv {
		require.True(t, strings.HasPrefix(line, "argv -c core.hooksPath=/dev/null "), "hooks are pinned off: %s", line)
	}
}
