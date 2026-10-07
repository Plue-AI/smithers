package faultprocess

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCrashEnvironmentChild(t *testing.T) {
	if os.Getenv(ChildEnv) != "environment" {
		return
	}
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID", "SMITHERS_PLATFORM_MODEL_KEYS_FILE", "HOME"} {
		require.Empty(t, os.Getenv(key), "child inherited %s", key)
	}
	require.Equal(t, "UTC", os.Getenv("TZ"))
	require.Equal(t, "http://127.0.0.1:47401", os.Getenv("SMITHERS_GITHUB_APP_API_BASE_URL"))
	require.Equal(t, os.DevNull, os.Getenv("GIT_CONFIG_GLOBAL"))
	require.Equal(t, "1", os.Getenv("GIT_CONFIG_NOSYSTEM"))
	require.Equal(t, "0", os.Getenv("GIT_TERMINAL_PROMPT"))
	require.NotEmpty(t, os.Getenv("PATH"))
	config := os.Getenv("XDG_CONFIG_HOME")
	require.NotEmpty(t, config)
	_, err := os.Stat(filepath.Join(config, "issue-claim", "app.json"))
	require.True(t, os.IsNotExist(err), "child found the lane's issue-claim configuration")
	fmt.Println("ENVIRONMENT isolated")
	Reached("pre-launch")
}

func TestCrashChildDoesNotInheritCredentials(t *testing.T) {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID", "SMITHERS_PLATFORM_MODEL_KEYS_FILE"} {
		t.Setenv(key, "parent-only-test-sentinel")
	}
	config := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(config, "issue-claim"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(config, "issue-claim", "app.json"), []byte(`{"app_id":"parent-only-test"}`), 0600))
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("TZ", "UTC")
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", "http://127.0.0.1:47401")
	child := Start(t, "TestCrashEnvironmentChild", "environment", "pre-launch", "")
	child.Await(t, "ENVIRONMENT isolated")
	child.Await(t, Marker+"pre-launch")
	child.Kill(t)
}

func TestCrashEndpointRefusalChild(t *testing.T) {
	if os.Getenv(ChildEnv) != "endpoint-refusal" {
		return
	}
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", os.Getenv(ArgsEnv))
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", "http://127.0.0.1:47401")
	Start(t, "TestCrashMarkerChild", "todo-merge", "pre-launch", "")
	t.Fatal("unsafe endpoint reached child launch")
}

func TestCrashChildRefusesMissingOrExternalFakeEndpoint(t *testing.T) {
	for _, endpoint := range []string{"", "https://api.github.com", "http://127.0.0.1:47401?token=member", "http://member:secret@127.0.0.1:47401"} {
		t.Run(fmt.Sprintf("endpoint-%d", len(endpoint)), func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestCrashEndpointRefusalChild$", "-test.count=1")
			cmd.Env = append(childEnvironment(t), ChildEnv+"=endpoint-refusal", ArgsEnv+"="+endpoint)
			output, err := cmd.CombinedOutput()
			var exited *exec.ExitError
			require.ErrorAs(t, err, &exited)
			require.Contains(t, string(output), "loopback fake")
			require.NotContains(t, string(output), "unsafe endpoint reached child launch")
			require.NotContains(t, string(output), Marker)
		})
	}
}
