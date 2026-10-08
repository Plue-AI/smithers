//go:build unix

package faultprocess

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/stretchr/testify/require"
)

// KillMachine selects only a workspace created in this test's owned runtime
// directory. In pinned msb 0.6.16, stop --force calls local kill_sandbox and
// sends SIGKILL to the libkrun runtime, without the clean shutdown path:
// https://github.com/microsandbox/microsandbox/blob/v0.6.16/sdk/rust/lib/backend/local/sandbox/mod.rs#L293
func KillMachine(t *testing.T, stateRoot, workspace, bundleRoot string) {
	t.Helper()
	require.Equal(t, filepath.Base(workspace), workspace)
	require.NotEmpty(t, workspace)
	raw, err := os.ReadFile(filepath.Join(stateRoot, "workspaces", workspace, "metadata.json"))
	require.NoError(t, err)
	var metadata struct {
		Machine string `json:"machine"`
	}
	require.NoError(t, json.Unmarshal(raw, &metadata))
	require.NotEmpty(t, metadata.Machine)
	bundle, err := installbundle.Open(bundleRoot)
	require.NoError(t, err, "machine faults require the approved installed bundle")
	msb := bundle.Program("bin/msb")
	require.NoError(t, msb.Check())
	account, err := user.LookupId(fmt.Sprint(os.Getuid()))
	require.NoError(t, err)
	command := exec.CommandContext(t.Context(), msb.Path(), "stop", "--force", "--quiet", metadata.Machine)
	command.Env = []string{"HOME=" + account.HomeDir, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
}
