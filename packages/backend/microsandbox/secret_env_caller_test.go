package microsandbox

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The msb process is a test fake. No root process or repository command runs;
// real installed-helper qualification is separately gated below.
func TestSecretEnvCallerLiteralTransport(t *testing.T) {
	runtime, argv, stdin := egressFakeMSB(t, nil)
	literal := map[string]string{"CANARY_TOKEN": "$(touch /root/canary)\nquote\"literal", "PATH": "/hostile", "PYTHONPATH": "/hostile", "LD_PRELOAD": "/hostile"}
	require.NoError(t, runtime.putSecretEnvironment(t.Context(), "machine", literal))
	body, err := os.ReadFile(stdin)
	require.NoError(t, err)
	var got map[string]string
	require.NoError(t, json.Unmarshal(body, &got))
	require.Equal(t, literal, got)
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Contains(t, string(args), "run put-env")
	require.Contains(t, string(args), "/usr/bin/python3 -I -S")
	require.NotContains(t, string(args), literal["CANARY_TOKEN"])
	require.NotContains(t, string(args), "PATH=/hostile")
	require.NoError(t, runtime.putSecretEnvironment(t.Context(), "machine", nil))
	body, err = os.ReadFile(stdin)
	require.NoError(t, err)
	require.JSONEq(t, `{}`, string(body), "deletion replaces the map rather than retaining old names")
}

func TestSecretEnvCallerRejectsBeforeGuestEffects(t *testing.T) {
	for _, values := range []map[string]string{
		{"": "value"}, {"1TOKEN": "value"}, {"A=B": "value"}, {"é": "value"},
		{"TOKEN": "nul\x00value"}, {"TOKEN": string([]byte{255})}, {"TOKEN": strings.Repeat("v", 1<<20)},
	} {
		// Any CLI effect would panic: validation must happen before transport.
		err := (&Runtime{}).putSecretEnvironment(t.Context(), "machine", values)
		require.Error(t, err)
		require.NotContains(t, err.Error(), "nul")
	}
	many := map[string]string{}
	for i := 0; i < 1001; i++ {
		many["A"+strings.Repeat("a", i)] = "v"
	}
	require.Error(t, (&Runtime{}).putSecretEnvironment(t.Context(), "machine", many))
	require.Error(t, (&Runtime{}).putSecretEnvironment(t.Context(), "", nil))
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, (&Runtime{}).putSecretEnvironment(ctx, "machine", nil), context.Canceled)
}

func TestSecretEnvInstalledWriterFreshWakeReplacement(t *testing.T) {
	runtime, _ := approvedRootBoundaryRuntime(t)
	const id = "secret-env-installed"
	ctx := operation("secret-env-installed")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), id)) }()
	ws, err := runtime.runningWorkspace(id)
	require.NoError(t, err)
	for _, value := range []string{"fresh-literal-$(false)", "live-replacement"} {
		require.NoError(t, runtime.putSecretEnvironment(ctx, ws.Machine, map[string]string{"CANARY_TOKEN": value}))
		result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-c", `import os,stat,json
s=os.stat('/run/smithers/env',follow_symlinks=False)
assert os.geteuid()==19999 and 20000 in os.getgroups()
assert (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_nlink)==(0,20000,0o640,1)
assert 'DEPLOY_KEY' not in os.environ
assert json.load(open('/run/smithers/env'))=={'CANARY_TOKEN':os.environ['CANARY_TOKEN']}
print(os.environ['CANARY_TOKEN'])`}})
		require.NoError(t, err)
		require.Equal(t, 0, result.ExitCode, result.Stderr)
		require.Equal(t, value+"\n", result.Stdout)
	}
	require.NoError(t, runtime.StopWorkspace(ctx, id))
	_, err = runtime.StartWorkspace(ctx, id)
	require.NoError(t, err)
	require.NoError(t, runtime.putSecretEnvironment(ctx, ws.Machine, map[string]string{"CANARY_TOKEN": "wake-replacement"}))
	result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/printenv", "CANARY_TOKEN"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	require.Equal(t, "wake-replacement\n", result.Stdout)
	require.NoError(t, runtime.putSecretEnvironment(ctx, ws.Machine, nil))
	result, err = runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/printenv", "CANARY_TOKEN"}})
	require.NoError(t, err)
	require.Equal(t, 1, result.ExitCode)
	require.Empty(t, result.Stdout)
}
