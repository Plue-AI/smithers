package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type agentDispatchCovBilling struct {
	err error
}

func (b *agentDispatchCovBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}

func (b *agentDispatchCovBilling) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}

func (b *agentDispatchCovBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	if b.err != nil {
		return b.err
	}
	return commit(ctx, nil)
}

func (b *agentDispatchCovBilling) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}

func (b *agentDispatchCovBilling) AuthorizePairing(context.Context, int64) error {
	return nil
}

func TestAgentDispatch_Cov_AuthorizeTokenAndStepBranches(t *testing.T) {
	ctx := context.Background()
	dispatch := &agentDispatch{svc: &AgentService{}, ctx: ctx, input: DispatchAgentRunInput{RepositoryID: 101}}
	err := dispatch.authorize()
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	dispatch.svc.dispatchQ = &mockAgentDispatchQuerier{}
	err = dispatch.authorize()
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	dispatch.svc.sandbox = &mockSandboxVMClient{}
	dispatch.svc.billing = &agentDispatchCovBilling{err: assert.AnError}
	require.NoError(t, dispatch.authorize())
	var created int
	dispatch.svc.dispatchQ = &mockAgentDispatchQuerier{createWorkflowRunFn: func(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
		created++
		return db.WorkflowRun{ID: 10, RepositoryID: arg.RepositoryID}, nil
	}}
	dispatch.wfDef = db.WorkflowDefinition{ID: 7}
	err = dispatch.createWorkflowRun()
	require.ErrorIs(t, err, assert.AnError)
	assert.Zero(t, created, "billing denial must stop the consuming write")
	dispatch.svc.billing = &agentDispatchCovBilling{}
	require.NoError(t, dispatch.createWorkflowRun())
	assert.Equal(t, 1, created)

	assert.Equal(t, "smithers", normalizeAgentProvider(""))
	assert.Equal(t, "smithers", normalizeAgentProvider(" Smithers "))
	assert.Equal(t, "codex", normalizeAgentProvider(" CODEX "))
	assert.Equal(t, "custom", normalizeAgentProvider(" custom "))
	assert.Equal(t, "workflow", normalizeAgentTransport(""))
	assert.Equal(t, "workflow", normalizeAgentTransport(" WORKFLOW "))
	assert.Equal(t, "http", normalizeAgentTransport(" HTTP "))
	assert.Equal(t, "stdio", normalizeAgentTransport(" stdio "))

	stepDispatch := &agentDispatch{
		svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{
			createWorkflowStepFn: func(context.Context, db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
				return db.WorkflowStep{}, assert.AnError
			},
		}},
		ctx: ctx,
		run: db.WorkflowRun{ID: 22},
	}
	err = stepDispatch.createWorkflowStep()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create workflow step")

	stepDispatch.svc.dispatchQ = &mockAgentDispatchQuerier{
		createWorkflowStepFn: func(_ context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			assert.Equal(t, int64(22), arg.WorkflowRunID)
			assert.Equal(t, "agent", arg.Name)
			assert.Equal(t, int64(0), arg.Position)
			assert.Equal(t, "queued", arg.Status)
			return db.WorkflowStep{ID: 33, WorkflowRunID: arg.WorkflowRunID, Name: arg.Name, Status: arg.Status}, nil
		},
	}
	require.NoError(t, stepDispatch.createWorkflowStep())
	assert.Equal(t, int64(33), stepDispatch.step.ID)

	require.NoError(t, dispatch.generateToken())
	assert.NotEmpty(t, dispatch.plaintext)
	assert.Len(t, dispatch.tokenHash, 64)

	storeDispatch := &agentDispatch{
		svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{
			updateWorkflowRunAgentTokenFn: func(context.Context, db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, assert.AnError
			},
		}},
		ctx:       ctx,
		run:       db.WorkflowRun{ID: 55},
		tokenHash: dispatch.tokenHash,
	}
	err = storeDispatch.storeTokenHash()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "store agent token hash")

	var stored db.UpdateWorkflowRunAgentTokenParams
	storeDispatch.svc.dispatchQ = &mockAgentDispatchQuerier{
		updateWorkflowRunAgentTokenFn: func(_ context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			stored = arg
			return db.WorkflowRun{ID: arg.ID}, nil
		},
	}
	require.NoError(t, storeDispatch.storeTokenHash())
	assert.Equal(t, int64(55), stored.ID)
	assert.True(t, stored.AgentTokenHash.Valid)
	assert.True(t, stored.AgentTokenExpiresAt.Time.After(time.Now()))
}

func TestAgentDispatch_Cov_LoadHistoryPrepareCloneAndMarkRunning(t *testing.T) {
	ctx := context.Background()
	sessionID := "11111111-1111-1111-1111-111111111111"
	svc := newTestDispatchService(&mockAgentDispatchQuerier{}, nil)
	svc.q = &mockAgentQuerier{
		listAgentMessagesFn: func(_ context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			assert.Equal(t, sessionID, arg.SessionID)
			return []db.AgentMessage{
				sampleDBAgentMessage(1, sessionID, "user", 0),
				sampleDBAgentMessage(2, sessionID, "assistant", 1),
			}, nil
		},
		listAgentMessagePartsFn: func(_ context.Context, messageID int64) ([]db.AgentPart, error) {
			return []db.AgentPart{sampleDBAgentPart(messageID, messageID, 0, "text", json.RawMessage(`{"text":"hello"}`))}, nil
		},
	}
	dispatch := &agentDispatch{
		svc: svc,
		ctx: ctx,
		input: DispatchAgentRunInput{
			SessionID:        sessionID,
			RepositoryID:     101,
			RepoOwner:        "Acme",
			RepoName:         "Demo",
			AgentProvider:    " CODEX ",
			AgentTransport:   " HTTP ",
			TriggerMessageID: 2,
		},
		run: db.WorkflowRun{ID: 44},
	}
	require.NoError(t, dispatch.loadMessageHistory())
	assert.NotContains(t, string(dispatch.payload), "agent_token")
	var payload agentTaskPayload
	require.NoError(t, json.Unmarshal(dispatch.payload, &payload))
	assert.Equal(t, "agent", payload.Kind)
	assert.Equal(t, int64(44), payload.WorkflowRunID)
	assert.Equal(t, "codex", payload.AgentProvider)
	assert.Equal(t, "http", payload.AgentTransport)
	require.Len(t, payload.MessageHistory, 2)
	assert.Empty(t, dispatch.triggerText, "an assistant message id records no message trigger")

	svc.q = &mockAgentQuerier{
		listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return nil, assert.AnError
		},
	}
	err := dispatch.loadMessageHistory()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load agent message history")

	blankClone := &agentDispatch{
		svc:   newTestDispatchService(&mockAgentDispatchQuerier{}, nil),
		ctx:   ctx,
		input: DispatchAgentRunInput{UserID: 7, RepoOwner: " ", RepoName: "demo"},
	}
	require.NoError(t, blankClone.prepareRepoClone())
	assert.False(t, blankClone.hasCloneToken)
	assert.Empty(t, blankClone.repositoryPath)

	cloneDispatch := &agentDispatch{
		svc:   newTestDispatchService(&mockAgentDispatchQuerier{}, nil),
		ctx:   ctx,
		input: DispatchAgentRunInput{SessionID: sessionID, UserID: 7, RepoOwner: "alice", RepoName: "demo"},
		run:   db.WorkflowRun{ID: 10},
		step:  db.WorkflowStep{ID: 20},
		task:  db.WorkflowTask{ID: 30},
	}
	require.NoError(t, cloneDispatch.prepareRepoClone())
	assert.True(t, cloneDispatch.hasCloneToken)
	assert.Equal(t, "/workspace", cloneDispatch.repositoryPath)
	require.Len(t, cloneDispatch.gitRepos, 1)
	assert.Contains(t, cloneDispatch.gitRepos[0].Repo, "x-access-token")
	assert.Equal(t, "/workspace", cloneDispatch.gitRepos[0].Path)

	badClone := &agentDispatch{
		svc:   newTestDispatchService(&mockAgentDispatchQuerier{}, nil),
		ctx:   ctx,
		input: DispatchAgentRunInput{SessionID: sessionID, UserID: 7, RepoOwner: "alice", RepoName: "demo"},
		run:   db.WorkflowRun{ID: 10},
		step:  db.WorkflowStep{ID: 20},
		task:  db.WorkflowTask{ID: 30},
	}
	badClone.svc.gitBaseURL = ""
	err = badClone.prepareRepoClone()
	require.Error(t, err)
	assert.True(t, badClone.infraFailedMarked)

	var runningArg db.MarkWorkflowTaskVMRunningParams
	markDispatch := &agentDispatch{
		svc: &AgentService{dispatchQ: &mockAgentDispatchQuerier{
			markWorkflowTaskVMRunningFn: func(_ context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error) {
				runningArg = arg
				return 1, nil
			},
			updateWorkflowStepStatusRunningFn: func(context.Context, int64) (int64, error) {
				return 0, assert.AnError
			},
			updateWorkflowRunStatusBasedOnTasksFn: func(context.Context, int64) (string, error) {
				return "", assert.AnError
			},
		}},
		ctx:   ctx,
		input: DispatchAgentRunInput{SessionID: sessionID},
		run:   db.WorkflowRun{ID: 10},
		step:  db.WorkflowStep{ID: 20},
		task:  db.WorkflowTask{ID: 30},
		vm:    agentDispatchCovVM("vm-123"),
	}
	require.NoError(t, markDispatch.markTaskRunning())
	assert.Equal(t, int64(30), runningArg.ID)
	assert.Equal(t, pgtype.Text{String: "vm-123", Valid: true}, runningArg.VmID)

	markDispatch.svc.dispatchQ = &mockAgentDispatchQuerier{
		markWorkflowTaskVMRunningFn: func(context.Context, db.MarkWorkflowTaskVMRunningParams) (int64, error) {
			return 0, assert.AnError
		},
	}
	err = markDispatch.markTaskRunning()
	require.Error(t, err)
	assert.True(t, markDispatch.infraFailedMarked)
}

func TestAgentDispatch_Cov_CleanupRevokesDeletesAndFailsRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var deletedToken db.DeleteAccessTokenParams
	var deletedVM string
	var terminal db.MarkWorkflowTaskTerminalByIDParams
	var failedRun int64
	dq := &mockAgentDispatchQuerier{
		deleteAccessTokenFn: func(_ context.Context, arg db.DeleteAccessTokenParams) error {
			deletedToken = arg
			return nil
		},
		markWorkflowTaskTerminalByIDFn: func(_ context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			terminal = arg
			return 1, nil
		},
		failWorkflowRunFn: func(_ context.Context, id int64) error {
			failedRun = id
			return nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		deleteVMFn: func(_ context.Context, vmID string) error {
			deletedVM = vmID
			return nil
		},
	}
	dispatch := &agentDispatch{
		svc:               svc,
		ctx:               ctx,
		input:             DispatchAgentRunInput{SessionID: "22222222-2222-2222-2222-222222222222", UserID: 77},
		run:               db.WorkflowRun{ID: 88},
		step:              db.WorkflowStep{ID: 99},
		task:              db.WorkflowTask{ID: 100},
		tempCloneToken:    temporaryRepoCloneToken{ID: 123, Plaintext: "secret"},
		hasCloneToken:     true,
		vm:                agentDispatchCovVM("vm-cleanup"),
		vmCreated:         true,
		watchdogStarted:   true,
		infraFailedMarked: false,
	}
	dispatch.cleanup()
	assert.Equal(t, db.DeleteAccessTokenParams{ID: 123, UserID: 77}, deletedToken)
	assert.Equal(t, "vm-cleanup", deletedVM)
	assert.False(t, dispatch.hasCloneToken)
	assert.Equal(t, int64(100), terminal.ID)
	assert.Equal(t, "dispatch failed", terminal.LastError.String)
	assert.Zero(t, failedRun, "task-backed cleanup should advance through task status, not direct fail")

	taskless := *dispatch
	taskless.task = db.WorkflowTask{}
	taskless.infraFailedMarked = false
	taskless.hasCloneToken = false
	taskless.vmCreated = false
	taskless.watchdogStarted = false
	taskless.cleanup()
	assert.Equal(t, int64(88), failedRun)
}

func agentDispatchCovVM(id string) sandbox.CreateResult {
	return sandbox.CreateResult{ID: id}
}

func (*agentDispatchCovBilling) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (*agentDispatchCovBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
