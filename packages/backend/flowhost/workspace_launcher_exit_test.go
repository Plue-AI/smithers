//go:build unix

package flowhost

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func TestWorkspaceLauncherEarlyExitRetainsOperatorExitStatus(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runtime, err := process.New(process.Config{Root: t.TempDir(), OutputLimit: 128})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: uuid.NewString()})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspace.ID)
	require.NoError(t, err)
	executable := filepath.Join(t.TempDir(), "exiting-host")
	require.NoError(t, os.WriteFile(executable, []byte("#!/bin/sh\nprintf 'private-startup-detail' >&2\nprintf '%0200d' 0 >&2\nexit 23\n"), 0700))
	revision := strings.Repeat("a", 40)
	digest := strings.Repeat("b", 64)
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: uuid.NewString()}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: workspace.ID, CatalogKey: CatalogCoding, SourceRevision: revision}
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, SystemFlows: []string{"merge"}, Executable: executable, ArtifactDigest: digest, ServiceName: "coding-host", ReadyTimeout: 10 * time.Second}
	binding := Binding{ID: uuid.NewString(), TenantID: target.TenantID, PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID, RepositoryID: 5, UserID: 9, WorkspaceID: workspace.ID, CatalogKey: CatalogCoding, ServiceName: catalog.ServiceName, RuntimeArtifactDigest: digest, SourceRevision: revision, OwnerGeneration: 1, State: "starting"}
	launcher, err := NewWorkspaceLauncher(runtime, WorkspaceLauncherConfig{AllowTrustedProcessForTests: true})
	require.NoError(t, err)
	_, startupErr := launcher.StartFlowHost(ctx, HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "private-bearer"})
	require.ErrorContains(t, startupErr, "exit status 23")
	require.NotContains(t, startupErr.Error(), "private-startup-detail")
	require.NotContains(t, startupErr.Error(), "private-bearer")
	require.NotContains(t, startupErr.Error(), executable)
	observation, err := runtime.InspectService(ctx, workspace.ID, catalog.ServiceName)
	require.NoError(t, err)
	require.Equal(t, 23, observation.ExitCode)
	require.Contains(t, observation.Stderr, "private-startup-detail")
	require.LessOrEqual(t, len(observation.Stderr), 128)
	require.True(t, observation.OutputTruncated)
	require.NoError(t, launcher.(RetirementStopper).StopFlowHost(ctx, binding))
	require.NoError(t, os.WriteFile(executable, []byte("#!/bin/sh\nprintf 'private-detail source_revision_mismatch' >&2\nexit 23\n"), 0700))
	binding.OwnerGeneration++
	_, startupErr = launcher.StartFlowHost(ctx, HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "private-bearer"})
	var failure flowruntime.Failure
	require.ErrorAs(t, startupErr, &failure)
	require.Equal(t, "source_revision_mismatch", failure.FlowRuntimeCode())
	require.True(t, failure.FlowRuntimeRetryable())
	require.NotContains(t, startupErr.Error(), "private-detail")
	require.NoError(t, launcher.(RetirementStopper).StopFlowHost(ctx, binding))
	require.NoError(t, os.WriteFile(executable, []byte("#!/bin/sh\nprintf '/cli/Refused: Flow host source revision does not match its authorized workspace binding'\nexit 23\n"), 0700))
	binding.OwnerGeneration++
	_, startupErr = launcher.StartFlowHost(ctx, HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "private-bearer"})
	require.ErrorAs(t, startupErr, &failure)
	require.Equal(t, "source_revision_mismatch", failure.FlowRuntimeCode())

}
