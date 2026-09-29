package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// TestDispatchAgentRun_FullVMLifecycleFlow verifies the complete dispatch path:
// creates workflow infra in DB, issues clone token, creates a Microsandbox VM,
// creates systemd service, marks task running, and returns valid result.
func TestDispatchAgentRun_FullVMLifecycleFlow(t *testing.T) {
	t.Parallel()

	var (
		capturedVMRequest      sandbox.CreateRequest
		capturedSystemdService sandbox.ServiceSpec
		capturedTaskPayload    map[string]any
		dbCallOrder            []string
	)

	dq := &mockAgentDispatchQuerier{
		upsertAgentWorkflowDefinitionFn: func(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error) {
			dbCallOrder = append(dbCallOrder, "upsert_definition")
			return db.WorkflowDefinition{ID: 1, RepositoryID: repositoryID}, nil
		},
		createWorkflowRunFn: func(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			dbCallOrder = append(dbCallOrder, "create_run")
			assert.Equal(t, "queued", arg.Status)
			assert.Equal(t, "agent_message", arg.TriggerEvent)
			return db.WorkflowRun{ID: 10, RepositoryID: arg.RepositoryID, WorkflowDefinitionID: arg.WorkflowDefinitionID}, nil
		},
		createWorkflowStepFn: func(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			dbCallOrder = append(dbCallOrder, "create_step")
			assert.Equal(t, "agent", arg.Name)
			return db.WorkflowStep{ID: 20, WorkflowRunID: arg.WorkflowRunID}, nil
		},
		createWorkflowTaskFn: func(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			dbCallOrder = append(dbCallOrder, "create_task")
			assert.Equal(t, "pending", arg.Status)
			assert.Equal(t, int16(3), arg.Priority)

			require.NoError(t, json.Unmarshal(arg.Payload, &capturedTaskPayload))
			return db.WorkflowTask{ID: 30, WorkflowRunID: arg.WorkflowRunID, WorkflowStepID: arg.WorkflowStepID}, nil
		},
		claimAgentSessionForDispatchFn: func(ctx context.Context, sessionID string, workflowRunID int64) (bool, error) {
			dbCallOrder = append(dbCallOrder, "link_session")
			return true, nil
		},
		updateWorkflowRunAgentTokenFn: func(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			dbCallOrder = append(dbCallOrder, "store_token")
			assert.True(t, arg.AgentTokenHash.Valid)
			assert.True(t, arg.AgentTokenExpiresAt.Valid)
			return db.WorkflowRun{ID: arg.ID}, nil
		},
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			if strings.HasPrefix(arg.Scopes, "write:repository") {
				// Per-run scoped jjhub API token minted by mintJJHubToken.
				dbCallOrder = append(dbCallOrder, "create_api_token")
				assert.Equal(t, "sandbox-run-10", arg.Name)
				return db.AccessToken{ID: 77, UserID: arg.UserID, Name: arg.Name}, nil
			}
			dbCallOrder = append(dbCallOrder, "create_clone_token")
			assert.Equal(t, "sandbox-agent-clone", arg.Name)
			assert.Equal(t, "read:repository", arg.Scopes)
			return db.AccessToken{ID: 99, UserID: arg.UserID, Name: arg.Name}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			// The clone token (99) is revoked after VM creation; the API token (77)
			// survives the whole run and is only revoked on terminal paths.
			dbCallOrder = append(dbCallOrder, "revoke_clone_token")
			assert.Equal(t, int64(99), arg.ID)
			return nil
		},
		updateAgentSessionStartedAtFn: func(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error) {
			dbCallOrder = append(dbCallOrder, "set_started_at")
			assert.True(t, arg.StartedAt.Valid)
			return sampleDBAgentSession(arg.ID, 101, 1, "default"), nil
		},
		markWorkflowTaskVMRunningFn: func(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error) {
			dbCallOrder = append(dbCallOrder, "mark_running")
			assert.Equal(t, int64(30), arg.ID)
			assert.True(t, arg.VmID.Valid)
			assert.Equal(t, "vm-lifecycle-test", arg.VmID.String)
			return 1, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.agentSnapshotID = "agent-snap-lifecycle"
	svc.gitBaseURL = "https://smithers.test"
	svc.apiBaseURL = "https://api.smithers.test"
	svc.sandboxConfig = AgentSandboxConfig{
		MemoryMB:     8192,
		VCPUCount:    4,
		RootfsSizeMB: 20480,
		ModelSeats:   []modelproxy.Seat{modelproxy.Seats[2]},
	}
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			capturedVMRequest = req
			return sandbox.CreateResult{ID: "vm-lifecycle-test"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			assert.Equal(t, "vm-lifecycle-test", vmID)
			capturedSystemdService = req
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	result, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-lifecycle",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "myproject",
	})
	require.NoError(t, err)

	// Verify result
	assert.Equal(t, int64(10), result.WorkflowRunID)
	assert.Equal(t, int64(30), result.WorkflowTaskID)
	assert.True(t, strings.HasPrefix(result.AgentToken, "smithers_agent_"))
	require.NotNil(t, capturedVMRequest.IdleTimeoutSeconds)
	assert.Equal(t, int64(300), *capturedVMRequest.IdleTimeoutSeconds)

	// Verify DB call order
	expectedOrder := []string{
		"upsert_definition",
		"create_run",
		"link_session",
		"create_step",
		"store_token",
		"create_task",
		"create_clone_token",
		"create_api_token",
		// started_at is stamped BEFORE the VM is created so a provisioning
		// session counts toward the fleet cap immediately; the clone token is
		// revoked right after CreateSandbox returns.
		"set_started_at",
		"revoke_clone_token",
		"mark_running",
	}
	assert.Equal(t, expectedOrder, dbCallOrder)

	// Verify VM request shape
	assert.Equal(t, "agent-snap-lifecycle", capturedVMRequest.SnapshotID)
	require.NotNil(t, capturedVMRequest.MemSizeMB)
	assert.Equal(t, int32(8192), *capturedVMRequest.MemSizeMB)
	require.NotNil(t, capturedVMRequest.VCPUCount)
	assert.Equal(t, int32(4), *capturedVMRequest.VCPUCount)
	require.NotNil(t, capturedVMRequest.RootfsSizeMB)
	assert.Equal(t, int64(20480), *capturedVMRequest.RootfsSizeMB)
	require.NotNil(t, capturedVMRequest.Persistence)
	assert.Equal(t, sandbox.PersistenceEphemeral, capturedVMRequest.Persistence.Type)
	require.NotNil(t, capturedVMRequest.Persistence.DeleteEvent)
	assert.Equal(t, sandbox.DeleteOnStop, *capturedVMRequest.Persistence.DeleteEvent)
	assert.Equal(t, "/workspace", capturedVMRequest.Workdir)
	require.Len(t, capturedVMRequest.GitRepos, 1)
	assert.Equal(t, "/workspace", capturedVMRequest.GitRepos[0].Path)
	assert.Contains(t, capturedVMRequest.GitRepos[0].Repo, "alice/myproject.git")

	// Verify systemd service shape
	assert.Equal(t, "smithers-agent", capturedSystemdService.Name)
	assert.Equal(t, sandbox.ServiceModeService, capturedSystemdService.Mode)
	// The unit carries no command: the loop it exec'd is deleted and Smithers
	// 1.0 has no per-task entrypoint. Its identity, workdir and environment
	// are what a 1.0 entrypoint will inherit, so they stay asserted.
	assert.Empty(t, capturedSystemdService.Exec)
	assert.Equal(t, "/workspace", capturedSystemdService.Workdir)
	assert.Equal(t, "sess-lifecycle", capturedSystemdService.Env["SMITHERS_AGENT_SESSION_ID"])
	assert.Equal(t, "https://api.smithers.test", capturedSystemdService.Env["SMITHERS_API_BASE_URL"])
	assert.Equal(t, "/workspace", capturedSystemdService.Env["SMITHERS_REPOSITORY_PATH"])
	assert.Equal(t, "10", capturedSystemdService.Env["SMITHERS_WORKFLOW_RUN_ID"])
	assert.NotEmpty(t, capturedSystemdService.Env["SMITHERS_AGENT_TOKEN"])
	// SMITHERS_TASK_PAYLOAD went with the 0.x loop that read it; the history
	// it carried is asserted on the persisted task payload below.
	assert.Empty(t, capturedSystemdService.Env["SMITHERS_TASK_PAYLOAD"])
	assert.Equal(t, "1", capturedSystemdService.Env["SMITHERS_DEBUG"])
	// The per-run scoped jjhub API token + public API url are injected for the
	// REST tools and must not be the same as the internal agent callback token.
	// Both reach the guest as placeholders; the proxy holds the values.
	assert.Equal(t, "SMITHERS_AGENT_TOKEN", capturedSystemdService.Env["SMITHERS_AGENT_TOKEN"])
	assert.Equal(t, "SMITHERS_JJHUB_TOKEN", capturedSystemdService.Env["SMITHERS_JJHUB_TOKEN"])
	require.NotNil(t, capturedVMRequest.EgressProxy)
	proxied := map[string]string{}
	for _, secret := range capturedVMRequest.EgressProxy.Secrets {
		proxied[secret.Name] = secret.Value
		if strings.HasPrefix(secret.Name, "SMITHERS_") {
			assert.Equal(t, []string{"api.smithers.test"}, secret.Hosts, secret.Name)
		}
	}
	assert.True(t, strings.HasPrefix(proxied["SMITHERS_AGENT_TOKEN"], "smithers_agent_"))
	assert.True(t, strings.HasPrefix(proxied["SMITHERS_JJHUB_TOKEN"], "smithers_"))
	assert.NotEqual(t, proxied["SMITHERS_AGENT_TOKEN"], proxied["SMITHERS_JJHUB_TOKEN"])
	assert.Equal(t, "https://api.smithers.test", capturedSystemdService.Env["SMITHERS_JJHUB_API_URL"])

	// Verify task payload contents — the agent_token must NOT appear in the
	// persisted task payload. It is injected into the Microsandbox VM systemd
	// environment directly and is never written to durable storage.
	assert.Equal(t, "agent", capturedTaskPayload["kind"])
	assert.Equal(t, "sess-lifecycle", capturedTaskPayload["session_id"])
	assert.Equal(t, float64(101), capturedTaskPayload["repository_id"])
	assert.Equal(t, float64(10), capturedTaskPayload["workflow_run_id"])
	assert.Equal(t, "https://api.smithers.test", capturedTaskPayload["api_base_url"])
	assert.Equal(t, "alice", capturedTaskPayload["repo_owner"])
	assert.Equal(t, "myproject", capturedTaskPayload["repo_name"])
	assert.Empty(t, capturedTaskPayload["agent_token"], "agent_token must not be persisted in task payload")
}

// TestDispatchAgentRun_VMCreationFailureRevokesTokenAndMarksInfraFailed verifies
// that when sandbox CreateSandbox fails, the clone token is revoked and the workflow
// infra is marked as failed.
func TestDispatchAgentRun_VMCreationFailureRevokesTokenAndMarksInfraFailed(t *testing.T) {
	t.Parallel()

	var (
		revokedIDs   []int64
		markedFailed bool
	)

	dq := &mockAgentDispatchQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			// Clone token → 55, per-run API token → 66.
			if strings.HasPrefix(arg.Scopes, "write:repository") {
				return db.AccessToken{ID: 66, UserID: arg.UserID}, nil
			}
			return db.AccessToken{ID: 55, UserID: arg.UserID}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			revokedIDs = append(revokedIDs, arg.ID)
			return nil
		},
		markWorkflowTaskTerminalByIDFn: func(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			if arg.Status == "failed" {
				markedFailed = true
			}
			return 1, nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.agentSnapshotID = "agent-snap-fail"
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, &sandbox.StatusError{
				StatusCode: 503,
				ErrorCode:  "CAPACITY_EXHAUSTED",
				Message:    "no available hosts",
			}
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-vm-fail",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create sandbox")

	// On VM-creation failure cleanup revokes BOTH the clone token (55) and the
	// per-run scoped API token (66) so neither leaks.
	assert.ElementsMatch(t, []int64{55, 66}, revokedIDs, "clone and api tokens should both be revoked")
	assert.True(t, markedFailed, "workflow infra should be marked failed")
}

// TestDispatchAgentRun_SystemdServiceFailureDeletesVM verifies that when
// CreateService fails (non-INTERNAL_ERROR), the VM is cleaned up.
func TestDispatchAgentRun_SystemdServiceFailureDeletesVM(t *testing.T) {
	t.Parallel()

	var (
		vmCreated bool
		vmDeleted bool
	)

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			vmCreated = true
			return sandbox.CreateResult{ID: "vm-systemd-fail"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			return sandbox.CreateServiceResult{}, &sandbox.StatusError{
				StatusCode: 400,
				ErrorCode:  "INVALID_ARGUMENT",
				Message:    "invalid service spec",
			}
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			vmDeleted = true
			assert.Equal(t, "vm-systemd-fail", vmID)
			return nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-systemd-fail",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create microsandbox systemd service")

	assert.True(t, vmCreated, "VM should have been created")
	assert.True(t, vmDeleted, "VM should be cleaned up after systemd failure")
}

// TestDispatchAgentRun_SystemdServiceSuccessFalseDeletesVM verifies that when
// CreateService returns Success=false, the VM is cleaned up.
func TestDispatchAgentRun_SystemdServiceSuccessFalseDeletesVM(t *testing.T) {
	t.Parallel()

	var vmDeleted bool

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-sys-false"}, nil
		},
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			return sandbox.CreateServiceResult{
				Success: false,
				Message: "service already exists",
			}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			vmDeleted = true
			return nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-sys-false",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "service already exists")
	assert.True(t, vmDeleted)
}

// TestDispatchAgentRun_MarkTaskRunningFailureDeletesVM verifies that when
// MarkWorkflowTaskVMRunning fails, the VM is cleaned up.
func TestDispatchAgentRun_MarkTaskRunningFailureDeletesVM(t *testing.T) {
	t.Parallel()

	var vmDeleted bool

	dq := &mockAgentDispatchQuerier{
		markWorkflowTaskVMRunningFn: func(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error) {
			return 0, errors.New("db connection lost")
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-mark-fail"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			vmDeleted = true
			assert.Equal(t, "vm-mark-fail", vmID)
			return nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-mark-fail",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "mark workflow task running")
	assert.True(t, vmDeleted)
}

// TestDispatchAgentRun_SecretInjectionFailureRevokesTokenAndDeletesVM verifies
// that when secret injection fails, both the clone token and VM are cleaned up.
func TestDispatchAgentRun_SecretInjectionFailureRevokesTokenAndDeletesVM(t *testing.T) {
	t.Parallel()

	var (
		cloneTokenRevoked bool
		vmCreated         bool
	)

	dq := &mockAgentDispatchQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 77, UserID: arg.UserID}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			cloneTokenRevoked = true
			return nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.secretService = &mockAgentSecretReader{
		listDecryptedSecretsForRepoFn: func(ctx context.Context, repositoryID int64) (map[string]string, error) {
			return nil, errors.New("kms unavailable")
		},
	}
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			vmCreated = true
			return sandbox.CreateResult{ID: "vm-should-not-exist"}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-secret-fail",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load repository secrets")
	assert.True(t, cloneTokenRevoked, "clone token should be revoked on secret failure")
	assert.False(t, vmCreated, "VM should not be created if secrets fail")
}

// TestDispatchAgentRun_SandboxMetricsRecordedOnSuccess verifies that
// Microsandbox VM creation metrics are recorded on success.
func TestDispatchAgentRun_SandboxMetricsRecordedOnSuccess(t *testing.T) {
	t.Parallel()

	var (
		metricsObserved bool
		metricsVMType   string
		metricsStatus   string
		metricsActiveVM bool
	)

	metrics := &mockSandboxMetricsRecorder{
		observeVMCreateFn: func(vmType, status string, seconds float64) {
			metricsObserved = true
			metricsVMType = vmType
			metricsStatus = status
		},
		addActiveVMsFn: func(vmType string, delta float64) {
			metricsActiveVM = true
			assert.Equal(t, "agent", vmType)
			assert.Equal(t, float64(1), delta)
		},
	}

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandboxMetrics = metrics
	svc.sandbox = &mockSandboxVMClient{}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-metrics",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)

	assert.True(t, metricsObserved, "VM create metrics should be observed")
	assert.Equal(t, "agent", metricsVMType)
	assert.Equal(t, "success", metricsStatus)
	assert.True(t, metricsActiveVM, "active VM count should be incremented")
}

// TestDispatchAgentRun_SandboxMetricsRecordedOnError verifies that
// Microsandbox VM creation metrics are recorded on error.
func TestDispatchAgentRun_SandboxMetricsRecordedOnError(t *testing.T) {
	t.Parallel()

	var metricsStatus string

	metrics := &mockSandboxMetricsRecorder{
		observeVMCreateFn: func(vmType, status string, seconds float64) {
			metricsStatus = status
		},
	}

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.sandboxMetrics = metrics
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, errors.New("microsandbox down")
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-metrics-fail",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Equal(t, "error", metricsStatus)
}

// TestDispatchAgentRun_SecretInjectorMergesWithSystemdEnv verifies that
// repository secrets from SecretInjector are merged into the systemd service
// environment but do not overwrite reserved keys.
func TestDispatchAgentRun_SecretInjectorMergesWithSystemdEnv(t *testing.T) {
	t.Parallel()

	var capturedEnv map[string]string

	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.secretInjector = NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, repositoryID int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("claude-token-value")},
				{Name: "OPENAI_API_KEY", ValueEncrypted: []byte("openai-key-value")},
				{Name: "CUSTOM_SECRET", ValueEncrypted: []byte("custom-value")},
			}, nil
		},
	}, webhook.NoopSecretCodec{})
	svc.sandbox = &mockSandboxVMClient{
		createSystemdServiceFn: func(ctx context.Context, vmID string, req sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
			capturedEnv = req.Env
			return sandbox.CreateServiceResult{Success: true, ServiceName: req.Name}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-injector-merge",
		RepositoryID: 101,
		UserID:       1,
	})
	require.NoError(t, err)
	require.NotNil(t, capturedEnv)

	// Verify secrets are injected
	assert.Equal(t, "claude-token-value", capturedEnv["ANTHROPIC_AUTH_TOKEN"])
	assert.Equal(t, "openai-key-value", capturedEnv["OPENAI_API_KEY"])
	assert.Equal(t, "custom-value", capturedEnv["CUSTOM_SECRET"])

	// Verify reserved keys are still present (not overwritten)
	assert.Equal(t, "/root", capturedEnv["HOME"])
	assert.Equal(t, "SMITHERS_AGENT_TOKEN", capturedEnv["SMITHERS_AGENT_TOKEN"], "the callback token is a proxy placeholder")
	// SMITHERS_TASK_PAYLOAD went with the 0.x loop that read it.
	assert.Empty(t, capturedEnv["SMITHERS_TASK_PAYLOAD"])
}

// TestDispatchAgentRun_CloneTokenBuildFailureRevokesToken verifies that when
// buildAuthenticatedRepoCloneURL fails, the clone token is revoked.
func TestDispatchAgentRun_CloneTokenBuildFailureRevokesToken(t *testing.T) {
	t.Parallel()

	var cloneTokenRevoked bool

	dq := &mockAgentDispatchQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 66, UserID: arg.UserID}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			cloneTokenRevoked = true
			return nil
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.gitBaseURL = "" // empty base URL will cause buildAuthenticatedRepoCloneURL to fail

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-clone-url-fail",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "build repo clone url")
	assert.True(t, cloneTokenRevoked)
}

// TestDispatchAgentRun_SetStartedAtFailurePreventsVMCreation verifies that when
// UpdateAgentSessionStartedAt fails, no VM is provisioned at all: the stamp now
// runs BEFORE CreateSandbox so provisioning sessions count toward the fleet cap.
func TestDispatchAgentRun_SetStartedAtFailurePreventsVMCreation(t *testing.T) {
	t.Parallel()

	var vmCreated bool

	dq := &mockAgentDispatchQuerier{
		updateAgentSessionStartedAtFn: func(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("db write failed")
		},
	}

	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			vmCreated = true
			return sandbox.CreateResult{ID: "vm-should-not-exist"}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-started-fail",
		RepositoryID: 101,
		UserID:       1,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "set agent session start time")
	assert.False(t, vmCreated, "no VM may be provisioned when the session cannot be stamped started")
}

// TestDispatchAgentRun_WatchdogCancelledOnIngestDone verifies the full lifecycle:
// dispatch -> watchdog starts -> IngestRunnerEvent(done) -> watchdog cancelled.
func TestDispatchAgentRun_WatchdogCancelledOnIngestDone(t *testing.T) {
	t.Parallel()

	deletedVM := make(chan string, 1)

	dq := &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.Status = arg.Status
			s.FinishedAt = arg.FinishedAt
			s.WorkflowRunID = pgtype.Int8{Valid: false}
			return s, nil
		},
	}

	svc := &AgentService{
		q:             &mockAgentQuerier{},
		dispatchQ:     dq,
		sandboxConfig: AgentSandboxConfig{MaxRuntime: 50 * time.Millisecond},
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(ctx context.Context, vmID string) error {
				deletedVM <- vmID
				return nil
			},
		},
	}

	// Start watchdog
	svc.startAgentRuntimeWatchdog("sess-cancel-test", "vm-cancel-test", 99, 0)

	// Immediately complete via IngestRunnerEvent
	err := svc.IngestRunnerEvent(context.Background(), IngestRunnerEventInput{
		SessionID: "sess-cancel-test",
		EventType: "done",
		Content:   json.RawMessage(`{"status":"completed"}`),
	})
	require.NoError(t, err)

	// Watchdog should NOT fire (we cancelled it)
	select {
	case vmID := <-deletedVM:
		t.Fatalf("watchdog should have been cancelled, but deleted VM %s", vmID)
	case <-time.After(200 * time.Millisecond):
		// Expected: watchdog was cancelled
	}
}

// mockSandboxMetricsRecorder captures sandbox lifecycle metrics for tests.
type mockSandboxMetricsRecorder struct {
	observeVMCreateFn func(vmType, status string, seconds float64)
	addActiveVMsFn    func(vmType string, delta float64)
	observeSuspendFn  func(seconds float64)
}

func (m *mockSandboxMetricsRecorder) ObserveSandboxVMCreate(vmType, status string, seconds float64) {
	if m.observeVMCreateFn != nil {
		m.observeVMCreateFn(vmType, status, seconds)
	}
}

func (m *mockSandboxMetricsRecorder) AddSandboxActiveVMs(vmType string, delta float64) {
	if m.addActiveVMsFn != nil {
		m.addActiveVMsFn(vmType, delta)
	}
}

func (m *mockSandboxMetricsRecorder) ObserveSandboxVMSuspend(seconds float64) {
	if m.observeSuspendFn != nil {
		m.observeSuspendFn(seconds)
	}
}
