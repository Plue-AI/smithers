package compose

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// trustedImageRuntime claims trusted-process isolation but builds images.
type trustedImageRuntime struct{ isolatedRuntime }

func (trustedImageRuntime) ResolveWorkspaceLayer(context.Context, workspace.WorkspaceSpec) (microsandbox.Layer, error) {
	return microsandbox.Layer{}, errors.New("not called: binding only")
}

// #3781: the trusted-process branch machines and machine images compose only
// in a single-owner test composition: the trusted-process runtime beside the
// Flow host test exception. A microVM install, a hosted deployment and any
// composition without the test exception refuse to start with them.
func TestTrustedProcessMachinesComposeOnlyForTests(t *testing.T) {
	trusted := isolatedRuntime{isolation: workspace.IsolationTrustedProcess}
	microVM := guestMicroVM{isolatedRuntime{isolation: workspace.IsolationSandboxed}}
	tests := flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}
	engine := &repohost.Client{}
	selected := func(change func(*Options)) Options {
		options := Options{Workspace: trusted, FlowHostConfig: tests, Repository: engine, TrustedProcessMachines: true}
		if change != nil {
			change(&options)
		}
		return options
	}
	t.Run("the test composition", func(t *testing.T) {
		images, err := installMachineImages(selected(nil))
		require.NoError(t, err)
		require.Equal(t, trustedProcessImages{sources: repositorySourceFiles{client: engine}}, images)
		providers, err := composeBranchMachines(selected(nil), false, ownerOnly{owner: 7})
		require.NoError(t, err)
		require.NotNil(t, providers)
		ctx := context.Background()
		require.NoError(t, providers.MicroVM(ctx))
		require.NoError(t, providers.SessionIdentity(ctx))
		require.NoError(t, providers.Authorize(ctx, nil, "branch.join", 1, "scratch/owner/a", 7))
		require.Error(t, providers.Authorize(ctx, nil, "branch.join", 1, "scratch/owner/a", 8), "the install's member boundary still decides")
		require.NotNil(t, providers.Membership)
		require.NotNil(t, providers.LaneBinding)
	})
	for name, options := range map[string]Options{
		"a microVM install":                selected(func(o *Options) { o.Workspace = microVM }),
		"no workspace runtime":             selected(func(o *Options) { o.Workspace = nil }),
		"a runtime that builds its images": selected(func(o *Options) { o.Workspace = trustedImageRuntime{trusted} }),
		"no Flow host test exception":      selected(func(o *Options) { o.FlowHostConfig = flowhost.WorkspaceLauncherConfig{} }),
		"beside the install's providers":   selected(func(o *Options) { o.InstallBranchMachines = true }),
		"beside hosted providers":          selected(func(o *Options) { o.HostedBranchMachines = true }),
		"beside injected providers":        selected(func(o *Options) { o.BranchMachines = &services.BranchMachineProviders{} }),
		"beside injected images":           selected(func(o *Options) { o.MachineImages = injectedImages{} }),
		"no repository engine":             selected(func(o *Options) { o.Repository = nil }),
	} {
		t.Run(name, func(t *testing.T) {
			images, err := installMachineImages(options)
			require.ErrorIs(t, err, errTrustedProcessMachines)
			require.Nil(t, images)
			providers, err := composeBranchMachines(options, false, ownerOnly{owner: 7})
			require.ErrorIs(t, err, errTrustedProcessMachines)
			require.Nil(t, providers)
		})
	}
	t.Run("a hosted deployment", func(t *testing.T) {
		providers, err := composeBranchMachines(selected(nil), true, ownerOnly{owner: 7})
		require.ErrorIs(t, err, errTrustedProcessMachines)
		require.Nil(t, providers)
	})
	t.Run("unselected", func(t *testing.T) {
		providers, err := composeBranchMachines(Options{Workspace: trusted, FlowHostConfig: tests, Repository: engine}, false, ownerOnly{owner: 7})
		require.NoError(t, err)
		require.Nil(t, providers, "the trusted-process runtime alone keeps machines dark")
	})
}

// The refusal precedes configuration, storage and the listener.
func TestStartRefusesTrustedProcessMachinesOnAMicroVMInstall(t *testing.T) {
	served := false
	microVM := guestMicroVM{isolatedRuntime{isolation: workspace.IsolationSandboxed}}
	tests := flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}
	err := StartWithOptions(t.Context(), []string{"-unknown-flag"}, io.Discard, io.Discard,
		Options{Workspace: microVM, FlowHostConfig: tests, Repository: &repohost.Client{}, TrustedProcessMachines: true}, func(http.Handler) { served = true })
	require.ErrorIs(t, err, errTrustedProcessMachines)
	require.False(t, served)
	// Control: the test composition passes the guard and stops at the next
	// startup check, the flag parser.
	err = StartWithOptions(t.Context(), []string{"-unknown-flag"}, io.Discard, io.Discard,
		Options{Workspace: isolatedRuntime{isolation: workspace.IsolationTrustedProcess}, FlowHostConfig: tests, Repository: &repohost.Client{}, TrustedProcessMachines: true}, func(http.Handler) { served = true })
	var parse *flagParseError
	require.ErrorAs(t, err, &parse)
	require.False(t, served)
}
