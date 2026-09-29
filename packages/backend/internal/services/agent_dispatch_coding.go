package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const (
	codingDispatchFlowID = "coding/dispatch"
	codingDispatchRole   = "coding/dispatch"
)

// AgentFlowDispatcher is the durable product boundary used by agent runs. Its
// implementation is flowdispatch.Service in both single-owner and Plue
// composition; runtime selection stays behind flowruntime.FlowRuntimeResolver.
type AgentFlowDispatcher interface {
	Admit(context.Context, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
	CancelRequest(context.Context, jobs.Scope, string) (jobs.Operation, error)
}

func WithAgentFlowDispatcher(dispatcher AgentFlowDispatcher) AgentServiceOption {
	return func(service *AgentService) { service.flowDispatcher = dispatcher }
}

// SetFlowDispatcher completes the intentional construction cycle: the agent
// service is the product projector supplied to flowdispatch, then receives the
// constructed dispatcher. App composition owns the call.
func (service *AgentService) SetFlowDispatcher(dispatcher AgentFlowDispatcher) {
	if service != nil {
		service.flowDispatcher = dispatcher
	}
}

func (dispatch *agentDispatch) codingDispatchEnabled() bool {
	return dispatch.svc != nil && dispatch.svc.flowDispatcher != nil && dispatch.workspaceMode()
}

type codingTurnMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// codingTurnTrigger is the message that started a turn, as admission
// authenticated it: who posted it, in which conversation, and its exact text.
// The Steps view renders it as the run's trigger (#2115).
type codingTurnTrigger struct {
	Kind           string `json:"kind"`
	Author         string `json:"author"`
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId"`
	Text           string `json:"text"`
	Origin         string `json:"origin"`
}

type codingTurnInput struct {
	TurnID  string              `json:"turnId"`
	Prompt  string              `json:"prompt"`
	History []codingTurnMessage `json:"history"`
	Role    string              `json:"role"`
	Model   string              `json:"model,omitempty"`
	Trigger *codingTurnTrigger  `json:"trigger,omitempty"`
}

type agentFlowProjection struct {
	Kind           string `json:"kind"`
	SessionID      string `json:"sessionId"`
	WorkflowRunID  int64  `json:"workflowRunId"`
	WorkflowTaskID int64  `json:"workflowTaskId"`
}

func (dispatch *agentDispatch) codingTurnRequest() (codingTurnInput, error) {
	var payload agentTaskPayload
	if err := json.Unmarshal(dispatch.payload, &payload); err != nil {
		return codingTurnInput{}, fmt.Errorf("read dispatched turn history: %w", err)
	}
	history := make([]codingTurnMessage, 0, len(payload.MessageHistory))
	prompt := ""
	for index, message := range payload.MessageHistory {
		if index == len(payload.MessageHistory)-1 && message.Role == "user" {
			prompt = message.Content
			break
		}
		if strings.TrimSpace(message.Content) == "" {
			continue
		}
		history = append(history, codingTurnMessage{Role: message.Role, Content: message.Content})
	}
	if strings.TrimSpace(prompt) == "" {
		return codingTurnInput{}, errors.New("a dispatched turn needs a user message to answer")
	}
	return codingTurnInput{
		TurnID:  fmt.Sprintf("run-%d", dispatch.run.ID),
		Prompt:  prompt,
		History: history,
		Role:    codingDispatchRole,
		Trigger: dispatch.messageTrigger(prompt),
	}, nil
}

// messageTrigger records the authenticated message a turn answers. A turn
// with no authenticated author or no admitted message records none.
func (dispatch *agentDispatch) messageTrigger(text string) *codingTurnTrigger {
	author := strings.TrimSpace(dispatch.input.MessageAuthor)
	if author == "" || dispatch.input.TriggerMessageID <= 0 || dispatch.input.SessionID == "" {
		return nil
	}
	return &codingTurnTrigger{
		Kind:           "message",
		Author:         author,
		ConversationID: dispatch.input.SessionID,
		MessageID:      strconv.FormatInt(dispatch.input.TriggerMessageID, 10),
		Text:           text,
		Origin:         "chat",
	}
}

func agentFlowScope(repositoryID, userID int64) jobs.Scope {
	return jobs.Scope{
		TenantID:    "repository:" + strconv.FormatInt(repositoryID, 10),
		PrincipalID: "user:" + strconv.FormatInt(userID, 10),
	}
}

func agentFlowRequestID(workflowRunID int64) string {
	return "agent-run:" + strconv.FormatInt(workflowRunID, 10)
}

// admitCodingTurn commits the durable product request before repository
// preparation, credential delivery, workspace provisioning, or any runtime
// network request. The shared jobs worker resolves the workspace host later.
func (dispatch *agentDispatch) admitCodingTurn() error {
	if !dispatch.codingDispatchEnabled() {
		return nil
	}
	turn, err := dispatch.codingTurnRequest()
	if err != nil {
		return dispatch.markInfraFailed("build dispatched turn: " + err.Error())
	}
	payload, err := json.Marshal(turn)
	if err != nil {
		return dispatch.markInfraFailed("encode dispatched turn: " + err.Error())
	}
	projection, err := json.Marshal(agentFlowProjection{
		Kind: "agent-workflow-run", SessionID: dispatch.input.SessionID,
		WorkflowRunID: dispatch.run.ID, WorkflowTaskID: dispatch.task.ID,
	})
	if err != nil {
		return dispatch.markInfraFailed("encode dispatched turn projection: " + err.Error())
	}
	authorization, err := json.Marshal(map[string]any{
		"repositoryId": dispatch.input.RepositoryID,
		"userId":       dispatch.input.UserID,
		"sessionId":    dispatch.input.SessionID,
	})
	if err != nil {
		return dispatch.markInfraFailed("encode dispatched turn authorization: " + err.Error())
	}
	receipt, err := dispatch.svc.flowDispatcher.Admit(dispatch.ctx, flowdispatch.LaunchRequest{
		Scope:     agentFlowScope(dispatch.input.RepositoryID, dispatch.input.UserID),
		RequestID: agentFlowRequestID(dispatch.run.ID),
		Target: flowruntime.FlowRuntimeTarget{
			BindingKind: "agent-session", BindingID: dispatch.input.SessionID,
		},
		FlowID: codingDispatchFlowID, Payload: payload,
		AuthorizationContext: authorization, Projection: projection,
		ApprovalPolicy: flowdispatch.ApprovalAuto,
	})
	if err != nil {
		return dispatch.markInfraFailed("admit dispatched turn: " + err.Error())
	}
	dispatch.flowOperationID = receipt.OperationID
	return nil
}

// cancelAgentFlowRun cancels the canonical Flow request for a session's
// workflow run. It reports false with no error when there is no dispatcher,
// no run, or Flow has no such request.
func (service *AgentService) cancelAgentFlowRun(ctx context.Context, session db.AgentSession) (bool, error) {
	if service.flowDispatcher == nil || !session.WorkflowRunID.Valid {
		return false, nil
	}
	_, err := service.flowDispatcher.CancelRequest(
		ctx,
		agentFlowScope(session.RepositoryID, session.UserID),
		agentFlowRequestID(session.WorkflowRunID.Int64),
	)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, jobs.ErrNotFound) {
		return false, nil
	}
	return false, err
}

// cancelAgentFlowRunBestEffort is cancelAgentFlowRun for paths that must
// finish tearing the session down even when Flow is unreachable.
func (service *AgentService) cancelAgentFlowRunBestEffort(ctx context.Context, session db.AgentSession, cause string) {
	if _, err := service.cancelAgentFlowRun(ctx, session); err != nil {
		slog.Warn("cancel canonical agent Flow run failed",
			"agent_session_id", session.ID,
			"workflow_run_id", session.WorkflowRunID.Int64,
			"cause", cause,
			"error", err)
	}
}

func (dispatch *agentDispatch) cancelCodingTurn(ctx context.Context) {
	if dispatch.svc == nil || dispatch.svc.flowDispatcher == nil || dispatch.run.ID == 0 {
		return
	}
	_, _ = dispatch.svc.flowDispatcher.CancelRequest(
		ctx,
		agentFlowScope(dispatch.input.RepositoryID, dispatch.input.UserID),
		agentFlowRequestID(dispatch.run.ID),
	)
}

// ProjectFlowRuntime keeps legacy workflow/session rows as idempotent product
// projections. It never reads or constructs Flow graph state, and it leaves
// assistant/model frames to the issue08 durable turn journal.
func (service *AgentService) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	if service == nil || service.dispatchQ == nil {
		return errors.New("agent Flow projection store unavailable")
	}
	var projection agentFlowProjection
	if err := json.Unmarshal(update.Checkpoint.Projection, &projection); err != nil {
		return fmt.Errorf("decode agent Flow projection: %w", err)
	}
	if projection.Kind != "agent-workflow-run" {
		return nil
	}
	if projection.SessionID == "" || projection.WorkflowRunID <= 0 || projection.WorkflowTaskID <= 0 {
		return errors.New("agent Flow projection identity is invalid")
	}
	// Check the task as well as the run before projecting a host receipt. This
	// also avoids reading a replacement turn's workspace for an older receipt.
	owner, err := service.dispatchQ.GetAgentSessionForFlowProjection(ctx, db.GetAgentSessionForFlowProjectionParams{
		SessionID: projection.SessionID, WorkflowRunID: projection.WorkflowRunID, WorkflowTaskID: projection.WorkflowTaskID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load agent Flow projection owner: %w", err)
	}
	if update.Checkpoint.RunID != "" {
		workspaceID := ""
		if service.workspaces != nil {
			workspaceID = UUIDString(owner.WorkspaceID)
		}
		if workspaceID == "" {
			return errors.New("agent workspace is not ready for Flow receipt projection")
		}
		if _, err := service.dispatchQ.RecordWorkflowRunCodingHost(ctx, db.RecordWorkflowRunCodingHostParams{
			WorkflowRunID: projection.WorkflowRunID,
			WorkspaceID:   workspaceID,
			HostRunID:     update.Checkpoint.RunID,
			FlowID:        update.Checkpoint.FlowID,
		}); err != nil {
			return fmt.Errorf("record canonical Flow run receipt: %w", err)
		}
	}
	if !update.State.Terminal() {
		return nil
	}
	finalStatus := "failed"
	lastError := "the canonical Flow run failed"
	switch update.State {
	case jobs.StateCompleted:
		finalStatus, lastError = "completed", ""
	case jobs.StateCancelled:
		finalStatus, lastError = "cancelled", "the canonical Flow run was cancelled"
	}
	session, err := service.dispatchQ.UpdateAgentSessionTerminalStatusForFlow(ctx, db.UpdateAgentSessionTerminalStatusForFlowParams{
		SessionID: projection.SessionID, WorkflowRunID: pgtype.Int8{Int64: projection.WorkflowRunID, Valid: true}, WorkflowTaskID: projection.WorkflowTaskID,
		Status: finalStatus, FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("project canonical Flow terminal status: %w", err)
	}
	meterSandboxUsage(ctx, service.dispatchQ, session.UserID, "agent", session.ID, false)
	service.notifyAgentSessionStatus(ctx, session)
	service.finalizeAgentSession(ctx, session, finalStatus, lastError)
	return nil
}

var _ flowdispatch.Projector = (*AgentService)(nil)
