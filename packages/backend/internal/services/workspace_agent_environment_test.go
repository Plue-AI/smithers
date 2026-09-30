package services

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type staticAgentEnvironmentProvider struct {
	config AgentEnvironmentProvisioningConfig
	err    error
}

func (p staticAgentEnvironmentProvider) LoadForProvisioning(context.Context, int64) (AgentEnvironmentProvisioningConfig, error) {
	return p.config, p.err
}

type agentEnvironmentStageQuerier struct {
	*mockWorkspaceQuerier
	stages []string
}

func (q *agentEnvironmentStageQuerier) UpdateWorkspaceProvisioningStage(_ context.Context, arg db.UpdateWorkspaceProvisioningStageParams) (db.Workspace, error) {
	q.stages = append(q.stages, arg.ProvisioningStage)
	workspace := sampleDBWorkspace(arg.ID)
	workspace.ProvisioningStage = arg.ProvisioningStage
	return workspace, nil
}

type agentEnvironmentWorkspaceSandbox struct {
	*mockWorkspaceSandboxVMClient
	files          map[string]string
	commands       []string
	setupStatus    int32
	prepareStatus  int32
	cleanupStatus  int32
	setupResponse  sandbox.ExecResult
	setupCallCount int
}

func (s *agentEnvironmentWorkspaceSandbox) WriteFile(_ context.Context, _ string, path string, req sandbox.WriteFileRequest) error {
	if s.files == nil {
		s.files = make(map[string]string)
	}
	s.files[path] = req.Content
	return nil
}

func (s *agentEnvironmentWorkspaceSandbox) Execute(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	s.commands = append(s.commands, req.Command)
	if strings.HasPrefix(strings.TrimPrefix(req.Command, workspaceArtifactGuestPath), "if ! test -L ") {
		return sandbox.ExecResult{StatusCode: new(int32), Stdout: "done"}, nil
	}
	if strings.Contains(req.Command, "mkdir -p") {
		return sandbox.ExecResult{StatusCode: &s.prepareStatus}, nil
	}
	if strings.Contains(req.Command, workspaceAgentEnvironmentWrapperPath) && !strings.Contains(req.Command, "rm -f") {
		s.setupCallCount++
		delete(s.files, workspaceAgentEnvironmentWrapperPath)
		delete(s.files, workspaceAgentEnvironmentSetupPath)
		response := s.setupResponse
		response.StatusCode = &s.setupStatus
		return response, nil
	}
	delete(s.files, workspaceAgentEnvironmentWrapperPath)
	delete(s.files, workspaceAgentEnvironmentSetupPath)
	return sandbox.ExecResult{StatusCode: &s.cleanupStatus}, nil
}

func TestWorkspaceAgentEnvironment_SetupSecretsAreStrippedBeforeSuccess(t *testing.T) {
	t.Parallel()
	queries := &agentEnvironmentStageQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	sandbox := &agentEnvironmentWorkspaceSandbox{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}}
	service := &WorkspaceService{
		q:       queries,
		sandbox: sandbox,
		agentEnvironment: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{
			SetupScript: "test -n \"$SETUP_TOKEN\"",
			Env:         []AgentEnvironmentVariable{{Name: "NODE_ENV", Value: "development"}},
			Secrets:     map[string]string{"SETUP_TOKEN": "setup-only-value"},
		}},
	}

	err := service.runWorkspaceAgentEnvironmentSetup(context.Background(), sampleDBWorkspace("ws-env"), "vm-env")
	require.NoError(t, err)
	assert.Equal(t, []string{"environment_setup", "ready"}, queries.stages)
	assert.Equal(t, 1, sandbox.setupCallCount)
	assert.Contains(t, sandbox.files[workspaceAgentEnvironmentProfilePath], "NODE_ENV")
	assert.NotContains(t, sandbox.files[workspaceAgentEnvironmentProfilePath], "setup-only-value")
	_, wrapperExists := sandbox.files[workspaceAgentEnvironmentWrapperPath]
	_, setupExists := sandbox.files[workspaceAgentEnvironmentSetupPath]
	assert.False(t, wrapperExists)
	assert.False(t, setupExists)
	for _, command := range sandbox.commands {
		assert.NotContains(t, command, "setup-only-value")
		assert.NotContains(t, command, "SETUP_TOKEN=")
	}
}

func TestWorkspaceAgentEnvironment_SetupFailureIsSanitizedAndStaged(t *testing.T) {
	t.Parallel()
	queries := &agentEnvironmentStageQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	sandbox := &agentEnvironmentWorkspaceSandbox{
		mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{},
		setupStatus:                  23,
		setupResponse:                sandbox.ExecResult{Stdout: "setup-only-value", Stderr: "echoed setup-only-value"},
	}
	service := &WorkspaceService{
		q:       queries,
		sandbox: sandbox,
		agentEnvironment: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{
			SetupScript: "exit 23",
			Secrets:     map[string]string{"SETUP_TOKEN": "setup-only-value"},
		}},
	}

	err := service.runWorkspaceAgentEnvironmentSetup(context.Background(), sampleDBWorkspace("ws-env-fail"), "vm-env")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "setup-only-value")
	assert.NotContains(t, err.Error(), "echoed")
	assert.Equal(t, []string{"environment_setup", "environment_setup_failed"}, queries.stages)
	_, wrapperExists := sandbox.files[workspaceAgentEnvironmentWrapperPath]
	assert.False(t, wrapperExists)
}

func TestWorkspaceAgentEnvironment_CleanupMustBeConfirmedBeforeReady(t *testing.T) {
	t.Parallel()
	queries := &agentEnvironmentStageQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	sandbox := &agentEnvironmentWorkspaceSandbox{
		mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{},
		cleanupStatus:                17,
	}
	service := &WorkspaceService{
		q:       queries,
		sandbox: sandbox,
		agentEnvironment: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{
			SetupScript: "true",
			Secrets:     map[string]string{"SETUP_TOKEN": "setup-only-value"},
		}},
	}

	err := service.runWorkspaceAgentEnvironmentSetup(context.Background(), sampleDBWorkspace("ws-env-cleanup-fail"), "vm-env")
	require.Error(t, err)
	assert.Equal(t, []string{"environment_setup", "environment_setup_failed"}, queries.stages)
	assert.NotContains(t, err.Error(), "setup-only-value")
}

func TestWorkspaceAgentEnvironment_BoundSecretsReachTheGuestOnlyAsPlaceholders(t *testing.T) {
	t.Parallel()
	queries := &agentEnvironmentStageQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	sandbox := &agentEnvironmentWorkspaceSandbox{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}}
	service := &WorkspaceService{
		q:       queries,
		sandbox: sandbox,
		agentEnvironment: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{
			SetupScript: "test -n \"$API_KEY\" && test -n \"$SETUP_TOKEN\"",
			Env:         []AgentEnvironmentVariable{{Name: "NODE_ENV", Value: "development"}},
			Secrets:     map[string]string{"SETUP_TOKEN": "setup-only-value"},
			ProxyBound:  []string{"API_KEY"},
		}},
	}

	err := service.runWorkspaceAgentEnvironmentSetup(context.Background(), sampleDBWorkspace("ws-bound"), "vm-bound")
	require.NoError(t, err)
	assert.Equal(t, []string{"environment_setup", "ready"}, queries.stages)

	profile := sandbox.files[workspaceAgentEnvironmentProfilePath]
	assert.Contains(t, profile, "export NODE_ENV='development'")
	assert.Contains(t, profile, "export API_KEY='API_KEY'", "the persistent profile carries the placeholder for every shell")
	assert.NotContains(t, profile, "SETUP_TOKEN", "unbound setup secrets never persist")
	for _, command := range sandbox.commands {
		assert.NotContains(t, command, "setup-only-value")
	}
}

func TestWorkspaceAgentEnvironment_PlaceholdersOnlyProfileIsWrittenWithoutASetupScript(t *testing.T) {
	t.Parallel()
	queries := &agentEnvironmentStageQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	sandbox := &agentEnvironmentWorkspaceSandbox{mockWorkspaceSandboxVMClient: &mockWorkspaceSandboxVMClient{}}
	service := &WorkspaceService{
		q:                queries,
		sandbox:          sandbox,
		agentEnvironment: staticAgentEnvironmentProvider{config: AgentEnvironmentProvisioningConfig{ProxyBound: []string{"API_KEY"}}},
	}
	require.NoError(t, service.runWorkspaceAgentEnvironmentSetup(context.Background(), sampleDBWorkspace("ws-ph"), "vm-ph"))
	assert.Equal(t, []string{"environment_setup", "ready"}, queries.stages)
	assert.Contains(t, sandbox.files[workspaceAgentEnvironmentProfilePath], "export API_KEY='API_KEY'")
	assert.Equal(t, 0, sandbox.setupCallCount)
}

func TestRenderWorkspaceAgentEnvironmentSetupWrapperExportsPlaceholdersForBoundSecrets(t *testing.T) {
	t.Parallel()
	wrapper, err := renderWorkspaceAgentEnvironmentSetupWrapper(AgentEnvironmentProvisioningConfig{
		Secrets:    map[string]string{"SETUP_TOKEN": "setup-only-value"},
		ProxyBound: []string{"API_KEY"},
	})
	require.NoError(t, err)
	assert.Contains(t, wrapper, "export API_KEY='API_KEY'")
	assert.Contains(t, wrapper, "export SETUP_TOKEN='setup-only-value'")

	_, err = renderWorkspaceAgentEnvironmentSetupWrapper(AgentEnvironmentProvisioningConfig{
		Env:        []AgentEnvironmentVariable{{Name: "API_KEY", Value: "plain"}},
		ProxyBound: []string{"API_KEY"},
	})
	require.Error(t, err, "a bound secret cannot share a name with a plain variable")
	_, err = renderWorkspaceAgentEnvironmentProfile(nil, []string{"bad name"})
	require.Error(t, err)
}
