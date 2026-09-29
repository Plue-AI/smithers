package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const agentMessageDispatchOperation = "agent-run-dispatch"

// AppendMessageAndDispatch commits the user message and its execution request
// together. No workflow, runtime, or provider call occurs on this boundary.
func (s *AgentService) AppendMessageAndDispatch(ctx context.Context, input DispatchAgentRunInput, parts []db.CreateAgentPartParams) (AgentMessageResponse, error) {
	if s == nil || s.q == nil || s.messageJobs == nil || s.appendTxManager == nil {
		return AgentMessageResponse{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Message dispatch unavailable")
	}
	s.touchAgentWorkspaceActivity(ctx, input.SessionID)
	return s.appendMessageWithTx(ctx, input.SessionID, "user", parts, &input)
}

// The append transaction already holds the session row lock. Repeated sends
// serialize here, including the interval before a worker creates its run.
func (s *AgentService) validateMessageDispatch(ctx context.Context, tx agentAppendTx, input DispatchAgentRunInput) error {
	productTx, ok := tx.(*pgxAgentAppendTx)
	if !ok {
		return pkgerrors.Internal("message admission requires a PostgreSQL transaction")
	}
	session, err := productTx.q.GetAgentSession(ctx, input.SessionID)
	if err != nil {
		return err
	}
	if session.RepositoryID != input.RepositoryID || session.UserID != input.UserID {
		return pkgerrors.Forbidden("chat does not belong to this repository and user")
	}
	var pending bool
	err = productTx.tx.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM product_job_requests WHERE tenant_id=$1 AND principal_id=$2
 AND operation=$3 AND payload->>'SessionID'=$4
 AND state NOT IN ('completed','failed','cancelled')) OR EXISTS (
 SELECT 1 FROM workflow_runs WHERE id=$5 AND status IN ('queued','running'))`,
		fmt.Sprintf("repository:%d", input.RepositoryID), fmt.Sprintf("user:%d", input.UserID),
		agentMessageDispatchOperation, input.SessionID, session.WorkflowRunID).Scan(&pending)
	if err != nil {
		return err
	}
	if pending {
		return pkgerrors.Conflict("chat already has pending execution")
	}
	return nil
}

func (s *AgentService) admitMessageDispatch(ctx context.Context, tx agentAppendTx, input DispatchAgentRunInput, messageID int64) error {
	productTx, ok := tx.(*pgxAgentAppendTx)
	if !ok {
		return pkgerrors.Internal("message admission requires a PostgreSQL transaction")
	}
	input.TriggerMessageID = messageID
	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}
	_, err = s.messageJobs.AdmitInTx(ctx, productTx.tx, jobs.Admission{
		Scope:     repositoryJobFlowScope(input.RepositoryID, input.UserID),
		Operation: agentMessageDispatchOperation, RequestID: fmt.Sprintf("agent-message:%d", messageID),
		Payload: payload, EffectPolicy: jobs.EffectUnsafe,
	})
	return err
}

// RunMessageDispatchWorker is independent of Flow composition: it must also
// settle accepted messages when a runtime is unavailable. Unsafe-effect fencing
// recovers unstarted claims but never replays an ambiguous provisioning call.
func (s *AgentService) RunMessageDispatchWorker(ctx context.Context, config jobs.WorkerConfig) error {
	if s == nil || s.messageJobs == nil {
		return errors.New("message dispatch store unavailable")
	}
	config.Operations = []string{agentMessageDispatchOperation}
	return s.messageJobs.RunWorker(ctx, config, s.handleMessageDispatch)
}

func (s *AgentService) handleMessageDispatch(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var input DispatchAgentRunInput
	if err := json.Unmarshal(claim.Payload, &input); err != nil {
		return settleMessageDispatch(ctx, func(receiptCtx context.Context) error {
			return lease.Fail(receiptCtx, json.RawMessage(`{"code":"invalid_message_dispatch"}`))
		})
	}
	fail := func(code string) error {
		receipt, _ := json.Marshal(map[string]any{"code": code, "messageId": input.TriggerMessageID})
		return settleMessageDispatch(ctx, func(receiptCtx context.Context) error { return lease.Fail(receiptCtx, receipt) })
	}
	if claim.Operation != agentMessageDispatchOperation || claim.Scope != repositoryJobFlowScope(input.RepositoryID, input.UserID) || claim.RequestID != fmt.Sprintf("agent-message:%d", input.TriggerMessageID) {
		return fail("invalid_message_dispatch")
	}
	// Recheck the saved authority and ownership immediately before dispatch;
	// the request may have waited through permission or account changes.
	q := db.New(s.messagePool)
	session, err := q.GetAgentSession(ctx, input.SessionID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return errors.New("message dispatch authority unavailable")
	}
	if err != nil || session.RepositoryID != input.RepositoryID || session.UserID != input.UserID || session.Status != "active" {
		return fail("chat_unavailable")
	}
	actor, err := q.GetUserByIDNotDeleted(ctx, input.UserID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return errors.New("message dispatch authority unavailable")
	}
	if err != nil || !actor.IsActive || actor.ProhibitLogin {
		return fail("dispatch_permission_denied")
	}
	repo, err := q.GetRepoByID(ctx, input.RepositoryID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return errors.New("message dispatch authority unavailable")
	}
	if err != nil || repo.IsArchived {
		return fail("repository_unavailable")
	}
	allowed, err := canWriteRepo(ctx, q, repo, input.UserID)
	if err != nil {
		return errors.New("message dispatch authority unavailable")
	}
	if !allowed {
		return fail("dispatch_permission_denied")
	}
	namedRepo, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(input.RepoOwner), LowerName: strings.ToLower(input.RepoName)})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return errors.New("message dispatch authority unavailable")
	}
	if err != nil || namedRepo.ID != input.RepositoryID {
		return fail("repository_changed")
	}
	var messageExists bool
	if err := s.messagePool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_messages WHERE id=$1 AND session_id=$2 AND role='user')`, input.TriggerMessageID, input.SessionID).Scan(&messageExists); err != nil {
		return errors.New("message dispatch authority unavailable")
	}
	if !messageExists {
		return fail("message_unavailable")
	}
	// Honor shutdown, requested cancellation, and lost leases during dispatch.
	// Receipt writes below have a separate bounded context.
	dispatchCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	started := false
	result, err := s.dispatchAgentRun(dispatchCtx, input, func(effectCtx context.Context) error {
		if err := lease.StartExternal(effectCtx, json.RawMessage(`{"phase":"dispatching"}`)); err != nil {
			return err
		}
		started = true
		return nil
	})
	if err != nil {
		middleware.LoggerWithAgentSession(ctx, input.SessionID).Error("durable message dispatch failed", "message_id", input.TriggerMessageID, "error", err)
		if started {
			// Cleanup is best effort; a failed or interrupted dispatch is not
			// evidence that every provider/database effect was undone.
			return errors.New("message dispatch outcome uncertain")
		}
		if ctx.Err() != nil {
			return errors.New("message dispatch interrupted before execution")
		}
		var apiErr *pkgerrors.APIError
		if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeQuotaExceeded {
			return errors.New("message dispatch waiting for capacity")
		}
		return fail("dispatch_failed")
	}
	// DispatchAgentRunResult also contains a plaintext token: never serialize it.
	receipt, _ := json.Marshal(map[string]any{"messageId": input.TriggerMessageID, "workflowRunId": result.WorkflowRunID, "workflowTaskId": result.WorkflowTaskID, "operationId": result.OperationID})
	return settleMessageDispatch(ctx, func(receiptCtx context.Context) error { return lease.Complete(receiptCtx, receipt) })
}

// Receipt settlement must survive a shutdown between dispatch and persistence.
// The jobs store still enforces the claim token and lease on this detached ctx.
func settleMessageDispatch(ctx context.Context, settle func(context.Context) error) error {
	receiptCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return settle(receiptCtx)
}
