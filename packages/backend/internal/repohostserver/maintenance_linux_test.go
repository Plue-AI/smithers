package repohostserver

import (
	"context"
	"os/exec"
	"syscall"
	"testing"

	"github.com/stretchr/testify/require"
)

// On Linux maintenance git gets SIGTERM when repo-host dies.
func TestMaintenanceGitDiesWithRepoHost(t *testing.T) {
	var cmd *exec.Cmd
	maintenanceCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		cmd = exec.CommandContext(ctx, "true")
		return cmd
	}
	t.Cleanup(func() { maintenanceCommandContext = exec.CommandContext })
	require.NoError(t, runMaintenanceGit(context.Background(), t.TempDir(), gcArgs))
	require.Equal(t, syscall.SIGTERM, cmd.SysProcAttr.Pdeathsig)
}
