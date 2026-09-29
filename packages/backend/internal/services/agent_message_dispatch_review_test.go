package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// The message, admission, claim, external marker, and terminal receipt use real
// PostgreSQL. Workflow creation and the sandbox are stand-ins because this
// fixture has no live Flow host or sandbox provider.
func reviewDispatchService(base *AgentService, dispatchQ *mockAgentDispatchQuerier) *AgentService {
	fixture := newTestDispatchService(dispatchQ, nil)
	base.dispatchQ = dispatchQ
	base.sandbox = fixture.sandbox
	base.sandboxConfig = fixture.sandboxConfig
	base.guestEntrypointAssumed = fixture.guestEntrypointAssumed
	base.apiBaseURL = fixture.apiBaseURL
	base.gitBaseURL = fixture.gitBaseURL
	return base
}

func reviewDispatchOperation(t *testing.T, service *AgentService, input DispatchAgentRunInput, messageID int64) jobs.Operation {
	t.Helper()
	store, err := jobs.NewStore(service.messagePool)
	require.NoError(t, err)
	operation, err := store.GetByRequest(t.Context(), repositoryJobFlowScope(input.RepositoryID, input.UserID), agentMessageDispatchOperation, fmt.Sprintf("agent-message:%d", messageID))
	require.NoError(t, err)
	return operation
}

func reviewWaitForDispatchState(t *testing.T, service *AgentService, input DispatchAgentRunInput, messageID int64, want jobs.State) jobs.Operation {
	t.Helper()
	var operation jobs.Operation
	require.Eventually(t, func() bool {
		operation = reviewDispatchOperation(t, service, input, messageID)
		return operation.State == want
	}, 5*time.Second, 10*time.Millisecond)
	return operation
}

func TestAgentMessageDispatchReviewCanonicalSuccessReceipt(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	service = reviewDispatchService(service, &mockAgentDispatchQuerier{})
	messageID := appendBoundaryMessage(t, service, input)
	runBoundaryMessageWorker(t, service)
	operation := reviewWaitForDispatchState(t, service, input, messageID, jobs.StateCompleted)
	require.JSONEq(t, fmt.Sprintf(`{"messageId":%d,"workflowRunId":10,"workflowTaskId":30,"operationId":""}`, messageID), string(operation.TerminalReceipt))
	require.NotContains(t, string(operation.TerminalReceipt), "smithers_agent_")
	require.NotContains(t, string(operation.TerminalReceipt), "AgentToken")
	require.NotContains(t, string(operation.TerminalReceipt), "agent_token")
	var externalStarted bool
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, operation.ID).Scan(&externalStarted))
	require.True(t, externalStarted)
}

func TestAgentMessageDispatchReviewShutdownAfterDispatchStillSettles(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	service = reviewDispatchService(service, &mockAgentDispatchQuerier{
		markWorkflowTaskVMRunningFn: func(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error) {
			// This is the last required dispatch mutation. Shutdown now, before
			// handleMessageDispatch writes its terminal receipt.
			stop()
			return 1, nil
		},
	})
	messageID := appendBoundaryMessage(t, service, input)
	done := make(chan error, 1)
	go func() {
		done <- service.RunMessageDispatchWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "review-shutdown", Capacity: 1, Lease: 5 * time.Second,
			PollInterval: 5 * time.Millisecond, RetryDelay: 5 * time.Millisecond,
		})
	}()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not drain after shutdown")
	}
	operation := reviewDispatchOperation(t, service, input, messageID)
	require.Equal(t, jobs.StateCompleted, operation.State)
	var receipt struct {
		MessageID int64 `json:"messageId"`
	}
	require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &receipt))
	require.Equal(t, messageID, receipt.MessageID)
}

type reviewCancelBeforeDispatchPolicy struct {
	BillingPolicy
	stop context.CancelFunc
}

func (p reviewCancelBeforeDispatchPolicy) AuthorizeSandboxStart(ctx context.Context, _ int64) error {
	p.stop()
	return ctx.Err()
}

func TestAgentMessageDispatchReviewPreflightCancellationHasNoExternalMarker(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	service = reviewDispatchService(service, &mockAgentDispatchQuerier{})
	service.billing = reviewCancelBeforeDispatchPolicy{stop: stop}
	messageID := appendBoundaryMessage(t, service, input)
	done := make(chan error, 1)
	go func() {
		done <- service.RunMessageDispatchWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "review-preflight", Capacity: 1, Lease: 5 * time.Second,
			PollInterval: 5 * time.Millisecond, RetryDelay: 5 * time.Millisecond,
		})
	}()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not stop after preflight cancellation")
	}
	operation := reviewDispatchOperation(t, service, input, messageID)
	require.Equal(t, jobs.StateAccepted, operation.State)
	require.Empty(t, operation.TerminalReceipt)
	var externalStarted bool
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, operation.ID).Scan(&externalStarted))
	require.False(t, externalStarted)
}

func TestAgentMessageDispatchReviewUncertainBlocksUntilFailedResolution(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	firstID := appendBoundaryMessage(t, service, input)
	store, err := jobs.NewStore(service.messagePool)
	require.NoError(t, err)
	claim, err := store.ClaimForOperations(t.Context(), "review-ambiguous", time.Minute, []string{agentMessageDispatchOperation})
	require.NoError(t, err)
	require.Equal(t, "agent-message:"+strconv.FormatInt(firstID, 10), claim.RequestID)
	_, err = store.BeginExternal(t.Context(), claim, json.RawMessage(`{"phase":"dispatching"}`))
	require.NoError(t, err)
	_, err = service.messagePool.Exec(t.Context(), `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, claim.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpiredForOperations(t.Context(), []string{agentMessageDispatchOperation}, 1)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	first := reviewDispatchOperation(t, service, input, firstID)
	require.Equal(t, jobs.StateUncertain, first.State)
	_, err = service.AppendMessageAndDispatch(t.Context(), input, boundaryMessageParts())
	require.Error(t, err)
	require.NoError(t, store.ResolveUncertain(t.Context(), repositoryJobFlowScope(input.RepositoryID, input.UserID), first.ID, jobs.ResolveFailed, json.RawMessage(`{"code":"operator_confirmed_failure"}`)))
	secondID := appendBoundaryMessage(t, service, input)
	require.Greater(t, secondID, firstID)
	second := reviewDispatchOperation(t, service, input, secondID)
	require.Equal(t, jobs.StateAccepted, second.State)
}

type reviewTemporaryCapacity struct {
	BillingPolicy
	attempts atomic.Int32
}

func (p *reviewTemporaryCapacity) AuthorizeSandboxStart(ctx context.Context, userID int64) error {
	if p.attempts.Add(1) == 1 {
		return pkgerrors.QuotaExceeded("concurrent agent session limit reached")
	}
	return p.BillingPolicy.AuthorizeSandboxStart(ctx, userID)
}
func TestAgentMessageDispatchReviewTemporaryCapacityRetriesBeforeEffects(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	var runs atomic.Int32
	service = reviewDispatchService(service, &mockAgentDispatchQuerier{upsertAgentWorkflowDefinitionFn: func(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error) {
		runs.Add(1)
		return db.WorkflowDefinition{ID: 1}, nil
	}})
	policy := &reviewTemporaryCapacity{BillingPolicy: NewUnlimitedBillingPolicy()}
	service.billing = policy
	messageID := appendBoundaryMessage(t, service, input)
	runBoundaryMessageWorker(t, service)
	operation := reviewWaitForDispatchState(t, service, input, messageID, jobs.StateCompleted)
	require.Equal(t, int32(2), policy.attempts.Load())
	require.Equal(t, int32(1), runs.Load(), "capacity retry must not duplicate workflow creation")
	require.Equal(t, 2, operation.Attempt)
}
func TestAgentMessageDispatchReviewPostMarkerFailureIsUncertain(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	service = reviewDispatchService(service, &mockAgentDispatchQuerier{createWorkflowRunFn: func(context.Context, db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, errors.New("database acknowledgement lost")
	}})
	messageID := appendBoundaryMessage(t, service, input)
	runBoundaryMessageWorker(t, service)
	operation := reviewWaitForDispatchState(t, service, input, messageID, jobs.StateUncertain)
	require.NotContains(t, string(operation.TerminalReceipt), "database acknowledgement lost")
	_, err := service.AppendMessageAndDispatch(t.Context(), input, boundaryMessageParts())
	require.Error(t, err, "unreconciled effects must block a second execution")
}

type reviewPlanLimit struct{ BillingPolicy }

func (p reviewPlanLimit) AuthorizeAgentRunCommitted(context.Context, int64, func(context.Context, db.DBTX) error) error {
	return pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "monthly agent run limit reached")
}
func TestAgentMessageDispatchReviewDeterministicRefusalsHaveNoExternalMarker(t *testing.T) {
	for _, retired := range []bool{false, true} {
		t.Run(fmt.Sprint("retired=", retired), func(t *testing.T) {
			service, input := newBoundaryMessageSession(t)
			service = reviewDispatchService(service, &mockAgentDispatchQuerier{})
			if retired {
				service.guestEntrypointAssumed = false
			} else {
				service.billing = reviewPlanLimit{BillingPolicy: NewUnlimitedBillingPolicy()}
			}
			messageID := appendBoundaryMessage(t, service, input)
			runBoundaryMessageWorker(t, service)
			operation := reviewWaitForDispatchState(t, service, input, messageID, jobs.StateFailed)
			var started bool
			require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, operation.ID).Scan(&started))
			require.False(t, started, "a deterministic refusal must not require reconciliation")
			appendBoundaryMessage(t, service, input)
		})
	}
}

func TestAgentMessageDispatchReviewWorkspaceCapacityStaysBeforeEffects(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	service = reviewDispatchService(service, &mockAgentDispatchQuerier{})
	q := db.New(service.messagePool)
	service.dispatchQ = q
	for i := range MaxActiveWorkspacesPerUser {
		_, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: input.RepositoryID, UserID: input.UserID, Name: fmt.Sprintf("quota-%d", i), IsFork: true, TargetBookmark: fmt.Sprintf("quota-%d", i), Kind: "agent", EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: "suspended"})
		require.NoError(t, err)
	}
	service.SetWorkspaceBackend(NewWorkspaceService(q, WithWorkspaceSandboxClient(service.sandbox)))
	messageID := appendBoundaryMessage(t, service, input)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- service.RunMessageDispatchWorker(ctx, jobs.WorkerConfig{WorkerID: "workspace-quota", Capacity: 1, Lease: time.Second, PollInterval: 5 * time.Millisecond, RetryDelay: 20 * time.Millisecond})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("quota worker did not stop")
		}
	})
	require.Eventually(t, func() bool {
		operation := reviewDispatchOperation(t, service, input, messageID)
		return operation.State == jobs.StateAccepted && operation.Attempt > 0
	}, 5*time.Second, 10*time.Millisecond)
	var started bool
	operation := reviewDispatchOperation(t, service, input, messageID)
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT external_started_at IS NOT NULL FROM product_job_dispatches WHERE operation_id=$1`, operation.ID).Scan(&started))
	require.False(t, started)
	var runs int
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, input.RepositoryID).Scan(&runs))
	require.Zero(t, runs, "workspace refusal must not create a partial execution")
}
