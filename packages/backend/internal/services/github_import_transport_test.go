package services

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestGitHubImportComposedTransportReusesNativeSeam(t *testing.T) {
	service := NewGitHubImportService(nil, nil, nil, nil, nil, "")
	WithGitHubImportGitRunner(nil)(service)
	// Nil cannot disable the real, policy-enforcing native runner.
	output, err := service.runGit(t.Context(), nil, "--version")
	require.NoError(t, err)
	require.Contains(t, output, "git version")
	called := false
	WithGitHubImportGitRunner(func(ctx context.Context, env []string, args ...string) (string, error) {
		called = true
		require.Equal(t, []string{"GIT_TERMINAL_PROMPT=0"}, env)
		require.Equal(t, []string{"clone", "--mirror", "http://fixture/repo.git"}, args)
		return "fixture receipt", nil
	})(service)
	output, err = service.runGit(t.Context(), []string{"GIT_TERMINAL_PROMPT=0"}, "clone", "--mirror", "http://fixture/repo.git")
	require.NoError(t, err)
	require.True(t, called)
	require.Equal(t, "fixture receipt", output)
	output, err = RunGitImportCommand(t.Context(), nil, "--version")
	require.NoError(t, err)
	require.Contains(t, output, "git version")
}
