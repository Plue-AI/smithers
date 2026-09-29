package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type agentWorkspaceBackendStub struct {
	createFn  func(ctx context.Context, input CreateAgentWorkspaceInput) (AgentWorkspaceResult, error)
	suspended []string
	failed    []string
}

func (s *agentWorkspaceBackendStub) CheckAgentWorkspaceQuota(context.Context, int64) error {
	return nil
}

func (s *agentWorkspaceBackendStub) CreateAgentWorkspace(ctx context.Context, input CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
	if s.createFn != nil {
		return s.createFn(ctx, input)
	}
	return AgentWorkspaceResult{WorkspaceID: "ws-1", VMID: "vm-1"}, nil
}
func (s *agentWorkspaceBackendStub) SuspendAgentWorkspace(_ context.Context, id string) error {
	s.suspended = append(s.suspended, id)
	return nil
}
func (s *agentWorkspaceBackendStub) FailAgentWorkspace(_ context.Context, id string) error {
	s.failed = append(s.failed, id)
	return nil
}
func (s *agentWorkspaceBackendStub) SnapshotAgentWorkspace(context.Context, string, string) (string, error) {
	return "snap-1", nil
}

func newWorkspaceModeDispatch(t *testing.T, backend AgentWorkspaceBackend) *agentDispatch {
	t.Helper()
	d := newEgressDispatch(t, &mockSandboxVMClient{})
	d.svc.workspaces = backend
	d.input.RepoOwner = "alice"
	d.input.RepoName = "demo"
	d.input.UserID = 7
	return d
}

func TestAgentDispatch_WorkspaceMode_ServiceRunsAsWorkspaceUser(t *testing.T) {
	t.Parallel()
	d := newWorkspaceModeDispatch(t, &agentWorkspaceBackendStub{})
	require.True(t, d.workspaceMode())
	require.NoError(t, d.buildServiceSpec())
	assert.Equal(t, defaultWorkspaceUser, d.agentServiceSpec.User)
	assert.Equal(t, defaultWorkspaceHome, d.agentServiceSpec.Env["HOME"])
	assert.Contains(t, d.agentServiceSpec.Env["PATH"], defaultWorkspaceHome+"/.bun/bin")
	assert.Equal(t, "/workspace/demo", d.agentServiceSpec.Workdir)

	ephemeral := newEgressDispatch(t, &mockSandboxVMClient{})
	require.False(t, ephemeral.workspaceMode(), "no backend keeps the ephemeral VM path")
	require.NoError(t, ephemeral.buildServiceSpec())
	assert.Empty(t, ephemeral.agentServiceSpec.User)
	assert.Equal(t, "/root", ephemeral.agentServiceSpec.Env["HOME"])
}

func TestAgentDispatch_WorkspaceMode_RepositoryPathIsWorkspaceClone(t *testing.T) {
	t.Parallel()
	d := newWorkspaceModeDispatch(t, &agentWorkspaceBackendStub{})
	d.svc.gitBaseURL = "https://git.example"
	require.NoError(t, d.prepareRepoClone())
	assert.Equal(t, defaultWorkspaceClonePath, d.repositoryPath)
	require.Len(t, d.gitRepos, 1)
	assert.Equal(t, defaultWorkspaceClonePath, d.gitRepos[0].Path)
}

func TestAgentDispatch_WorkspaceMode_CreateVMUsesBackendAndMergesBindings(t *testing.T) {
	t.Parallel()
	var got CreateAgentWorkspaceInput
	backend := &agentWorkspaceBackendStub{createFn: func(_ context.Context, input CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
		got = input
		return AgentWorkspaceResult{WorkspaceID: "ws-9", VMID: "vm-9", Forked: true, SourceWorkspaceID: "ws-primary"}, nil
	}}
	d := newWorkspaceModeDispatch(t, backend)
	d.svc.gitBaseURL = "https://git.example"
	d.svc.sandboxMetrics = &egressMetricsStub{}
	require.NoError(t, d.prepareRepoClone())
	require.NoError(t, d.buildServiceSpec())
	require.NoError(t, d.injectSecrets())
	d.gitRepos = append(d.gitRepos, sandbox.GitRepositorySpec{Repo: "https://git.example/acme/lib", Path: defaultWorkspaceClonePath + "/acme/lib", Rev: "abc"})
	require.NoError(t, d.createVM())
	assert.Equal(t, "ws-9", d.workspaceID)
	assert.Equal(t, "vm-9", d.vm.ID)
	assert.True(t, d.vmCreated)
	assert.True(t, d.watchdogStarted)
	assert.Equal(t, "alice", got.RepoOwner)
	assert.Equal(t, "demo", got.RepoName)
	assert.Equal(t, "sess-1", got.SessionID)
	require.Len(t, got.Members, 1, "only changeset members are handed over; the primary clone is the workspace's job")
	assert.Equal(t, "abc", got.Members[0].Rev)
	for _, secret := range got.EgressSecrets {
		if secret.Name == "ANTHROPIC_API_KEY" {
			assert.Equal(t, "agent-token", secret.Value, "a platform seat is metered, never an egress-bound provider key")
		}
	}
	assert.Equal(t, "ANTHROPIC_API_KEY", d.agentServiceSpec.Env["ANTHROPIC_API_KEY"])
	d.svc.cancelAgentRuntimeWatchdog(d.input.SessionID)
}

func TestAgentDispatch_WorkspaceMode_CreateFailureMarksInfraFailed(t *testing.T) {
	t.Parallel()
	backend := &agentWorkspaceBackendStub{createFn: func(context.Context, CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
		return AgentWorkspaceResult{}, errors.New("quota exceeded")
	}}
	d := newWorkspaceModeDispatch(t, backend)
	require.NoError(t, d.buildServiceSpec())
	err := d.createVM()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create agent workspace")
	assert.False(t, d.vmCreated)
	assert.Empty(t, d.workspaceID)
}

func TestAgentDispatch_WorkspaceMode_CleanupFailsUnstartedAndSuspendsStarted(t *testing.T) {
	t.Parallel()
	t.Run("agent never started: workspace failed, quota released", func(t *testing.T) {
		backend := &agentWorkspaceBackendStub{}
		d := newWorkspaceModeDispatch(t, backend)
		d.workspaceID = "ws-1"
		d.vmCreated = true
		d.vm = sandbox.CreateResult{ID: "vm-1"}
		d.cleanup()
		assert.Equal(t, []string{"ws-1"}, backend.failed)
		assert.Empty(t, backend.suspended)
	})
	t.Run("agent started: workspace suspended and kept", func(t *testing.T) {
		backend := &agentWorkspaceBackendStub{}
		d := newWorkspaceModeDispatch(t, backend)
		d.workspaceID = "ws-1"
		d.vmCreated = true
		d.serviceStarted = true
		d.vm = sandbox.CreateResult{ID: "vm-1"}
		d.cleanup()
		assert.Equal(t, []string{"ws-1"}, backend.suspended)
		assert.Empty(t, backend.failed)
	})
}
