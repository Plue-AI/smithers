package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// InstallFlowRuns admits the same coding-host launches as the browser relay.
// HTTP only persists an intent; the shared Flow worker contacts the machine.
type InstallFlowRuns struct {
	Queries    *db.Queries
	Dispatcher *flowdispatch.Service
	Jobs       *jobs.Store
}

type InstallFlowRunInput struct {
	Name        string         `json:"name"`
	WorkspaceID string         `json:"workspaceId"`
	Input       map[string]any `json:"input,omitempty"`
}

var installFlowName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$`)

func flowRunError(status int, code, class, message string) error {
	return &TodoControlError{Status: status, Code: code, Class: class, Message: message}
}

func (s *InstallFlowRuns) Request(ctx context.Context, repositoryID, userID int64, input InstallFlowRunInput, key string) (jobs.RequestReceipt, error) {
	empty := jobs.RequestReceipt{}
	if len(input.Name) > 128 || !installFlowName.MatchString(input.Name) || len(key) > 255 || strings.TrimSpace(key) == "" || key != strings.TrimSpace(key) {
		return empty, flowRunError(400, "invalid_flow_run", "user", "Name and Idempotency-Key are required")
	}
	if !Overridable(input.Name) {
		return empty, flowRunError(403, "reserved_name", "permission", "This flow is install-owned")
	}
	if input.Name == "review" {
		return empty, flowRunError(403, "review_requires_pr", "permission", "Select a pull request to review")
	}
	if flowdispatch.IsTodoFlow(input.Name) {
		return empty, flowRunError(403, "todo_requires_stack_admission", "permission", "File a TODO")
	}
	id, err := uuid.Parse(input.WorkspaceID)
	if err != nil || id.String() != input.WorkspaceID {
		return empty, flowRunError(400, "invalid_flow_run", "user", "Select a branch machine")
	}
	if s == nil || s.Queries == nil || s.Dispatcher == nil || s.Jobs == nil {
		return empty, flowRunError(503, "flows_unavailable", "infra", "Flows unavailable")
	}
	machine, err := s.Queries.GetFlowWorkspaceForUserRepo(ctx, db.GetFlowWorkspaceForUserRepoParams{ID: input.WorkspaceID, RepositoryID: repositoryID, UserID: userID})
	if err != nil || machine.RebuildRequiredAt.Valid {
		return empty, flowRunError(404, "branch_not_found", "user", "Branch unavailable")
	}
	if machine.Status != "running" {
		return empty, flowRunError(409, "machine_not_running", "conflict", "Wake the branch machine")
	}
	binding, err := s.Queries.ReadInstallRepositoryBinding(ctx)
	if err != nil {
		return empty, err
	}
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repositoryID), PrincipalID: fmt.Sprintf("user:%d", userID)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, BindingKind: "browser-flow", BindingID: binding.Owner + "/" + binding.Name, WorkspaceID: machine.ID}
	plan, _ := json.Marshal(map[string]string{"flowId": input.Name})
	if err := s.Dispatcher.RefuseRelay(ctx, target, "Plan", plan); err != nil {
		return empty, flowRunError(403, "engine_only_flow", "permission", "File a TODO")
	}
	if input.Input == nil {
		input.Input = map[string]any{}
	}
	payload, err := json.Marshal(input.Input)
	if err != nil {
		return empty, flowRunError(400, "invalid_flow_run", "user", "Invalid flow input")
	}
	receipt, err := s.Dispatcher.Admit(ctx, flowdispatch.LaunchRequest{
		Scope: scope, RequestID: "install-flow-run:" + key, Target: target, FlowID: input.Name,
		Payload: payload, ApprovalPolicy: flowdispatch.ApprovalAuto,
	})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		return empty, flowRunError(409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request")
	}
	return receipt, err
}

// InstallFlowRunStatus is safe to reconnect to; authority and payloads stay private.
type InstallFlowRunStatus struct {
	jobs.RequestReceipt
	RunID string `json:"runId,omitempty"`
	Code  string `json:"code,omitempty"`
	Class string `json:"class,omitempty"`
}

// Status follows the shared dispatcher's real completion or failure receipt.
func (s *InstallFlowRuns) Status(ctx context.Context, repositoryID, userID int64, id string) (InstallFlowRunStatus, error) {
	empty := InstallFlowRunStatus{}
	if s == nil || s.Jobs == nil {
		return empty, flowRunError(503, "flows_unavailable", "infra", "Flows unavailable")
	}
	if parsed, err := uuid.Parse(id); err != nil || parsed.String() != id {
		return empty, flowRunError(404, "flow_run_not_found", "user", "Run unavailable")
	}
	op, err := s.Jobs.Get(ctx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repositoryID), PrincipalID: fmt.Sprintf("user:%d", userID)}, id)
	if errors.Is(err, jobs.ErrNotFound) || (err == nil && (op.Operation != flowdispatch.OperationLaunch || !strings.HasPrefix(op.RequestID, "install-flow-run:"))) {
		return empty, flowRunError(404, "flow_run_not_found", "user", "Run unavailable")
	}
	if err != nil {
		return empty, err
	}
	var result InstallFlowRunStatus
	if err := json.Unmarshal(op.RequestReceipt, &result.RequestReceipt); err != nil {
		return empty, err
	}
	result.State = op.State
	if len(op.ExternalReceipt) > 0 {
		var checkpoint flowdispatch.RuntimeCheckpoint
		if err := json.Unmarshal(op.ExternalReceipt, &checkpoint); err != nil {
			return empty, err
		}
		result.RunID, result.Code, result.Class = checkpoint.RunID, checkpoint.FailureCode, checkpoint.FailureClass
	}
	if len(op.TerminalReceipt) > 0 {
		var terminal struct {
			Code  string           `json:"errorCode"`
			Class string           `json:"errorClass"`
			Run   *flowruntime.Run `json:"run"`
		}
		if err := json.Unmarshal(op.TerminalReceipt, &terminal); err != nil {
			return empty, err
		}
		result.Code, result.Class = terminal.Code, terminal.Class
		if terminal.Run != nil {
			result.RunID = terminal.Run.RunID
		}
	}
	return result, nil
}
