package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestGitCloneAuthenticationFailurePostgres(t *testing.T) {
	f := newSetupFixture(t, "source")
	s := NewGitHubImportService(nil, nil, nil, nil, nil, "")
	s.pool = f.pool
	id := uuid.NewString()
	_, err := f.pool.Exec(t.Context(), `INSERT INTO import_jobs(id,user_id,github_owner,github_repo,repo_owner,repo_name,branch,target_bookmark,status) VALUES($1,$2,'acme','app','acme','app','main','main','cloning')`, id, f.owner.ID)
	require.NoError(t, err)
	job, found, err := s.claimDurableImport(t.Context(), newRepositoryProvisionClaimToken())
	require.NoError(t, err)
	require.True(t, found)
	// A controlled Git executable makes authentication fail without an outside
	// account, while exercising the real child-process env and durable worker.
	directory := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(directory, "git"), []byte("#!/bin/sh\n[ \"$HTTPS_PROXY\" = http://127.0.0.1:9 ] && [ \"$GIT_EXEC_PATH\" = \""+directory+"\" ] || exit 139\nprintf '%s\\n' 'fatal: Authentication failed' >&2\nexit 128\n"), 0700))
	t.Setenv("PATH", directory+":/usr/bin:/bin")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("GIT_EXEC_PATH", directory)
	failure := s.cloneAndPushMirror(t.Context(), "acme", "app", "", "http://localhost/repo.git", "", id)
	require.Error(t, failure)
	require.NoError(t, s.handleDurableImportFailure(job, failure))
	var status string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT status FROM import_jobs WHERE id=$1`, id).Scan(&status))
	require.Equal(t, "failed", status)
}

func TestSourceGitUsesLauncherPathAndProxy(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "git")
	require.NoError(t, os.WriteFile(executable, []byte("#!/bin/sh\nprintf '%s\\n' \"$HTTPS_PROXY\" \"$GIT_EXEC_PATH\"\n"), 0700))
	t.Setenv("PATH", directory+":/usr/bin:/bin")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("GIT_EXEC_PATH", directory)
	output, err := RunGitImportCommand(t.Context(), nonInteractiveGitEnv(), "--version")
	require.NoError(t, err)
	require.Equal(t, "http://127.0.0.1:9\n"+directory+"\n", output)
}

func TestGitHubGitOriginOverride(t *testing.T) {
	t.Setenv(envGitHubAppAPIBaseURL, "https://enterprise.example/api/v3")
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", "https://git.enterprise.example/")
	require.Equal(t, "https://git.enterprise.example/", githubGitBaseURL())
	require.Contains(t, gitGitHubAuthEnv("token"), "GIT_CONFIG_KEY_0=http.https://git.enterprise.example/.extraHeader")
}

func TestGitHubCloneUsesConfiguredHost(t *testing.T) {
	for _, tc := range []struct{ api, want string }{
		{"https://api.github.com", "https://github.com/"},
		{"https://enterprise.example/api/v3", "https://enterprise.example/"},
		{"http://127.0.0.1:4010", "http://127.0.0.1:4010/"},
	} {
		t.Run(tc.api, func(t *testing.T) {
			t.Setenv(envGitHubAppAPIBaseURL, tc.api)
			t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", "")
			s := NewGitHubImportService(nil, nil, nil, nil, nil, "")
			s.runGit = func(_ context.Context, env []string, args ...string) (string, error) {
				require.Contains(t, args, tc.want+"acme/app.git")
				require.Contains(t, strings.Join(env, "\n"), "http."+tc.want+".extraHeader")
				return "", errors.New("stop after clone")
			}
			require.Error(t, s.cloneAndPushMirror(t.Context(), "acme", "app", "token", "http://local/repo.git", "", ""))
		})
	}
}
