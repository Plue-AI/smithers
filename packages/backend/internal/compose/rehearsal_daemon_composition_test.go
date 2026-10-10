package compose

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

func TestRehearsalDaemonRefusesProductionComposition(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	binary := filepath.Join(t.TempDir(), "daemon")
	require.NoError(t, os.WriteFile(binary, []byte("fixture"), 0700))
	valid := Options{Workspace: runtime, Repository: &repohost.Client{}, TrustedProcessMachines: true, FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}, RehearsalDaemon: binary}
	require.NoError(t, validateRehearsalDaemon(valid))
	for name, change := range map[string]func(*Options){
		"production flow host": func(o *Options) { o.FlowHostConfig.AllowTrustedProcessForTests = false },
		"production machines":  func(o *Options) { o.TrustedProcessMachines = false },
		"install microVM":      func(o *Options) { o.InstallBranchMachines = true },
		"hosted machines":      func(o *Options) { o.HostedBranchMachines = true },
	} {
		t.Run(name, func(t *testing.T) {
			options := valid
			change(&options)
			served := false
			err := StartWithOptions(context.Background(), nil, io.Discard, io.Discard, options, func(http.Handler) { served = true })
			require.Error(t, err)
			require.Contains(t, err.Error(), "test", "refuse before reading configuration or opening a listener")
			require.False(t, served)
		})
	}
}
