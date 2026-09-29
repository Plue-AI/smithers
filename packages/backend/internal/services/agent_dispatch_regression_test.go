package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// Regression: every role=user message used to dispatch a fresh run even while
// the previous one was still active, re-pointing agent_sessions.workflow_run_id
// and 401-locking the still-running agent's callbacks (leaking its VM).
func TestDispatchAgentRun_RejectsWhenSessionHasActiveRun(t *testing.T) {
	t.Parallel()

	for _, status := range []string{"queued", "running"} {
		createRunCalled := false
		dq := &mockAgentDispatchQuerier{
			getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
				return db.WorkflowRun{ID: runID, Status: status}, nil
			},
			createWorkflowRunFn: func(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
				createRunCalled = true
				return db.WorkflowRun{ID: 10}, nil
			},
		}
		svc := newTestDispatchService(dq, nil)
		svc.q = &mockAgentQuerier{
			getAgentSessionWorkflowRunIDFn: func(_ context.Context, _ string) (pgtype.Int8, error) {
				return pgtype.Int8{Int64: 42, Valid: true}, nil
			},
		}

		_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
			SessionID:    "sess-active",
			RepositoryID: 101,
			UserID:       7,
		})
		require.Error(t, err, "status=%s", status)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, "status=%s", status)
		assert.Equal(t, 409, apiErr.Status, "status=%s", status)
		assert.False(t, createRunCalled, "no new run should be created while one is active (status=%s)", status)
	}
}

func TestDispatchAgentRun_AllowsWhenPreviousRunIsTerminal(t *testing.T) {
	t.Parallel()

	dq := &mockAgentDispatchQuerier{
		getWorkflowRunByRunIDFn: func(_ context.Context, runID int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: runID, Status: "success"}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.q = &mockAgentQuerier{
		getAgentSessionWorkflowRunIDFn: func(_ context.Context, _ string) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: 42, Valid: true}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-terminal",
		RepositoryID: 101,
		UserID:       7,
	})
	require.NoError(t, err)
}

// Regression: when dispatch failed before the workflow task was created,
// cleanup called MarkWorkflowTaskTerminalByID with task ID 0 (no-op) and
// UpdateWorkflowRunStatusBasedOnTasks matched zero tasks, leaving the run
// queued forever. The run must be failed directly.
func TestDispatchAgentRun_TaskCreationFailureFailsRunDirectly(t *testing.T) {
	t.Parallel()

	failedRunID := int64(0)
	taskTerminalCalled := false
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(_ context.Context, _ db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, errors.New("boom")
		},
		failWorkflowRunFn: func(_ context.Context, id int64) error {
			failedRunID = id
			return nil
		},
		markWorkflowTaskTerminalByIDFn: func(_ context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			taskTerminalCalled = true
			return 0, nil
		},
	}
	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-task-fail",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	assert.Equal(t, int64(10), failedRunID, "run should be failed directly when no task exists")
	assert.False(t, taskTerminalCalled, "no task terminal update should be attempted for task ID 0")
}

// Regression: cleanup ran on the already-cancelled dispatch context, so VM
// deletion, token revocation, and status writes all failed. Cleanup must use
// a detached context.
func TestDispatchAgentRun_CleanupUsesDetachedContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // dispatch context is already dead

	var cleanupCtxErr error = errors.New("not called")
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(_ context.Context, _ db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, errors.New("boom")
		},
		failWorkflowRunFn: func(cleanupCtx context.Context, _ int64) error {
			cleanupCtxErr = cleanupCtx.Err()
			return nil
		},
	}
	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(ctx, DispatchAgentRunInput{
		SessionID:    "sess-cancelled",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	assert.NoError(t, cleanupCtxErr, "cleanup must run on a context detached from the cancelled dispatch context")
}

// Regression: message-history load errors were silently discarded, dispatching
// the agent with an empty conversation.
func TestDispatchAgentRun_MessageHistoryErrorFailsDispatch(t *testing.T) {
	t.Parallel()

	createTaskCalled := false
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(_ context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			createTaskCalled = true
			return db.WorkflowTask{ID: 30}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.q = &mockAgentQuerier{
		listAgentMessagesFn: func(_ context.Context, _ db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return nil, errors.New("db down")
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-history-fail",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "message history")
	assert.False(t, createTaskCalled, "dispatch must not proceed with empty history")
}

// Regression (issue #110): loadMessageHistory always read page 1 of an
// ascending listing, so sessions with more than 200 messages shipped the OLDEST
// 200 to the runner and silently dropped the newest — including the user
// message that triggered the dispatch. The payload must contain the latest
// window instead.
func TestDispatchAgentRun_LongSessionHistoryKeepsNewestMessages(t *testing.T) {
	t.Parallel()

	const totalMessages = 450

	var capturedPayload []byte
	dq := &mockAgentDispatchQuerier{
		createWorkflowTaskFn: func(_ context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			capturedPayload = arg.Payload
			return db.WorkflowTask{ID: 30, WorkflowRunID: arg.WorkflowRunID, WorkflowStepID: arg.WorkflowStepID}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.q = &mockAgentQuerier{
		countAgentMessagesBySessionFn: func(_ context.Context, _ string) (int64, error) {
			return totalMessages, nil
		},
		listAgentMessagesFn: func(_ context.Context, arg db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			// Simulate the real ascending-sequence pagination over 450 messages,
			// with message ID == sequence.
			msgs := make([]db.AgentMessage, 0, arg.PageSize)
			for seq := int64(arg.PageOffset); seq < int64(arg.PageOffset)+int64(arg.PageSize) && seq < totalMessages; seq++ {
				msgs = append(msgs, sampleDBAgentMessage(seq, arg.SessionID, "user", seq))
			}
			return msgs, nil
		},
		listAgentMessagePartsFn: func(_ context.Context, messageID int64) ([]db.AgentPart, error) {
			content, err := json.Marshal(fmt.Sprintf("msg-%d", messageID))
			require.NoError(t, err)
			return []db.AgentPart{sampleDBAgentPart(1, messageID, 0, "text", content)}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-long-history",
		RepositoryID: 101,
		UserID:       7,
	})
	require.NoError(t, err)

	var payload struct {
		MessageHistory []agentTaskPayloadMessage `json:"message_history"`
	}
	require.NoError(t, json.Unmarshal(capturedPayload, &payload))
	require.Len(t, payload.MessageHistory, 200, "history window must be exactly 200 messages")
	assert.Equal(t, "msg-250", payload.MessageHistory[0].Content, "window must start at the 200th-newest message")
	assert.Equal(t, "msg-449", payload.MessageHistory[len(payload.MessageHistory)-1].Content,
		"the newest (triggering) message must be included")
}

// Regression (issue #28): the session-run link used to be an unconditional
// UPDATE after an unlocked precheck, so two concurrent dispatches could both
// pass ensureNoActiveRun, both provision VMs, and race on the re-point. The
// link is now an atomic claim; a lost claim must abort the dispatch with 409
// and terminalize only the loser's newly-created taskless run.
func TestDispatchAgentRun_LostClaimRejectsWithConflict(t *testing.T) {
	t.Parallel()

	vmCreated := false
	createdStep := false
	createdTask := false
	failedRunID := int64(0)
	winnerSessionTerminated := false
	dq := &mockAgentDispatchQuerier{
		claimAgentSessionForDispatchFn: func(_ context.Context, _ string, runID int64) (bool, error) {
			assert.Equal(t, int64(10), runID)
			return false, nil // a concurrent dispatch already claimed the session
		},
		createWorkflowStepFn: func(context.Context, db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
			createdStep = true
			return db.WorkflowStep{}, nil
		},
		createWorkflowTaskFn: func(context.Context, db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
			createdTask = true
			return db.WorkflowTask{}, nil
		},
		failWorkflowRunFn: func(_ context.Context, runID int64) error {
			failedRunID = runID
			return nil
		},
		updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			winnerSessionTerminated = true
			return db.AgentSession{}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			vmCreated = true
			return sandbox.CreateResult{ID: "vm-loser"}, nil
		},
	}

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-claim-race",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
	assert.False(t, vmCreated, "the losing dispatch must never provision a VM")
	assert.False(t, createdStep, "the loser must stop before creating a step")
	assert.False(t, createdTask, "the loser must stop before creating a task")
	assert.Equal(t, int64(10), failedRunID, "the loser's taskless run must be terminalized")
	assert.False(t, winnerSessionTerminated, "the winning session must remain active")
}

// Regression (issue #112): markInfraFailed ran the terminal DB writes on the
// (possibly already cancelled) dispatch context while setting the
// infraFailedMarked flag first, so cleanup skipped its detached-context retry
// and the failure was never persisted. The writes must run detached.
func TestMarkInfraFailed_UsesDetachedContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // dispatch context is already dead when the failing step runs

	var infraFailCtxErr error = errors.New("not called")
	dq := &mockAgentDispatchQuerier{
		// Fail prepareRepoClone's token mint, which reports through markInfraFailed.
		createAccessTokenFn: func(_ context.Context, _ db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{}, errors.New("token mint failed")
		},
		markWorkflowTaskTerminalByIDFn: func(failCtx context.Context, _ db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			infraFailCtxErr = failCtx.Err()
			return 1, nil
		},
	}
	svc := newTestDispatchService(dq, nil)

	_, err := svc.DispatchAgentRun(ctx, DispatchAgentRunInput{
		SessionID:    "sess-infra-cancelled",
		RepositoryID: 101,
		UserID:       7,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.Error(t, err)
	assert.NoError(t, infraFailCtxErr,
		"markInfraFailed must persist the terminal state on a context detached from the cancelled dispatch context")
}

// Regression (issue #338): started_at used to be stamped only AFTER the slow
// CreateSandbox call, and the fleet cap counted only started_at IS NOT NULL rows —
// so a burst of concurrent dispatches all passed the cap and overshot it
// without bound. The hard gate is now an atomic reserve BEFORE CreateSandbox.
func TestDispatchAgentRun_ReserveFleetSlotRejectsAtCapBeforeVM(t *testing.T) {
	t.Parallel()

	vmCreated := false
	dq := &mockAgentDispatchQuerier{}
	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			vmCreated = true
			return sandbox.CreateResult{ID: "vm-over-cap"}, nil
		},
	}
	// Precheck passes (count below cap), but the atomic reserve loses the race.
	counter := &mockAgentConcurrencyCounter{
		count: 4,
		reserveFn: func(_ string, _ int) (bool, error) {
			return false, nil
		},
	}
	svc.concurrencyCounter = counter
	svc.concurrencyMax = 5

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-reserve-cap",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 429, apiErr.Status)
	assert.Equal(t, 1, counter.reserveCalls)
	assert.False(t, vmCreated, "no VM may be provisioned when the fleet slot reservation is rejected")
}

// A reservation error must fail closed. Falling back to a plain started_at
// stamp would admit a dispatch without proving that it owns a fleet slot.
func TestDispatchAgentRun_ReserveFleetSlotFailsClosedOnError(t *testing.T) {
	t.Parallel()

	startedAtStamped := false
	vmCreated := false
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionStartedAtFn: func(_ context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error) {
			startedAtStamped = true
			s := sampleDBAgentSession(arg.ID, 101, 1, "default")
			s.StartedAt = arg.StartedAt
			return s, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.sandbox = &mockSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			vmCreated = true
			return sandbox.CreateResult{ID: "vm-reservation-error"}, nil
		},
	}
	counter := &mockAgentConcurrencyCounter{
		count: 0,
		reserveFn: func(_ string, _ int) (bool, error) {
			return false, errors.New("db unavailable")
		},
	}
	svc.concurrencyCounter = counter
	svc.concurrencyMax = 5

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-reserve-err",
		RepositoryID: 101,
		UserID:       7,
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.Status)
	assert.Equal(t, 1, counter.reserveCalls)
	assert.False(t, startedAtStamped, "reservation errors must not fall back to a plain started_at stamp")
	assert.False(t, vmCreated, "no VM may be provisioned without a reserved fleet slot")
}

// A successful reservation already stamps started_at atomically; the plain
// stamp must not run a second time.
func TestDispatchAgentRun_ReserveFleetSlotSkipsPlainStamp(t *testing.T) {
	t.Parallel()

	startedAtStamped := false
	dq := &mockAgentDispatchQuerier{
		updateAgentSessionStartedAtFn: func(_ context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error) {
			startedAtStamped = true
			return sampleDBAgentSession(arg.ID, 101, 1, "default"), nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	counter := &mockAgentConcurrencyCounter{count: 0}
	svc.concurrencyCounter = counter
	svc.concurrencyMax = 5

	_, err := svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-reserve-ok",
		RepositoryID: 101,
		UserID:       7,
	})
	require.NoError(t, err)
	assert.Equal(t, 1, counter.reserveCalls)
	assert.False(t, startedAtStamped, "a successful atomic reserve must not be followed by a second stamp")
}
