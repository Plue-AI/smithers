package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const (
	repositoryJobFlowBindingKind    = "repository-job-dispatch"
	repositoryJobFlowProjectionKind = "repository-job-dispatch"
	repositoryJobFlowModeLaunch     = "launch"
	repositoryJobFlowModeSignal     = "signal"
)

type repositoryJobFlowProjection struct {
	Kind           string `json:"kind"`
	Mode           string `json:"mode"`
	DispatchID     string `json:"dispatchId"`
	RegistrationID string `json:"registrationId"`
	Revision       int64  `json:"revision"`
	SignalAttempt  int32  `json:"signalAttempt,omitempty"`
	PreviousRunID  string `json:"previousRunId,omitempty"`
}

type repositoryJobFlowReceipt struct {
	OperationID     string                          `json:"operationId"`
	State           jobs.State                      `json:"state"`
	RunID           string                          `json:"runId,omitempty"`
	PlanID          string                          `json:"planId,omitempty"`
	PlanDigest      string                          `json:"planDigest,omitempty"`
	FailureCode     string                          `json:"failureCode,omitempty"`
	Receipt         *flowruntime.FlowRuntimeReceipt `json:"receipt,omitempty"`
	MutationReceipt *flowruntime.FlowRuntimeReceipt `json:"mutationReceipt,omitempty"`
}

type repositoryJobPlanProjection struct {
	PlanID          string          `json:"planId"`
	Digest          string          `json:"digest"`
	ExecutionDigest string          `json:"executionDigest"`
	Envelope        json.RawMessage `json:"envelope"`
}

func repositoryJobFlowScope(repositoryID, userID int64) jobs.Scope {
	return jobs.Scope{
		TenantID:    "repository:" + strconv.FormatInt(repositoryID, 10),
		PrincipalID: "user:" + strconv.FormatInt(userID, 10),
	}
}

func repositoryJobFlowRequestID(dispatchID string) string {
	return "repository-job:" + dispatchID
}

func repositoryJobSignalRequestID(dispatchID string, attempt int32) string {
	return fmt.Sprintf("repository-job:%s:signal:%d", dispatchID, attempt)
}

func repositoryJobFlowTarget(registration db.RepositoryJobRegistration, dispatch db.RepositoryJobDispatch) flowruntime.FlowRuntimeTarget {
	return flowruntime.FlowRuntimeTarget{
		WorkspaceID: registration.WorkspaceID,
		BindingKind: repositoryJobFlowBindingKind,
		BindingID:   dispatch.ID,
	}
}

func repositoryJobFlowAuthorization(registration db.RepositoryJobRegistration, dispatch db.RepositoryJobDispatch) json.RawMessage {
	encoded, _ := json.Marshal(map[string]any{
		"repositoryId":   registration.RepositoryID,
		"userId":         registration.UserID,
		"workspaceId":    registration.WorkspaceID,
		"registrationId": registration.ID,
		"dispatchId":     dispatch.ID,
		"revision":       dispatch.Revision,
		"digest":         dispatch.Digest,
	})
	return encoded
}

func repositoryJobProjection(mode string, registration db.RepositoryJobRegistration, dispatch db.RepositoryJobDispatch, previousRunID string) json.RawMessage {
	encoded, _ := json.Marshal(repositoryJobFlowProjection{
		Kind: repositoryJobFlowProjectionKind, Mode: mode, DispatchID: dispatch.ID,
		RegistrationID: registration.ID, Revision: dispatch.Revision,
		SignalAttempt: dispatch.SignalAttempt, PreviousRunID: previousRunID,
	})
	return encoded
}

func repositoryJobLaunchPayload(registration db.RepositoryJobRegistration, dispatch db.RepositoryJobDispatch, config RegisterRepositoryJobInput, connection RepoGatewayConnectionInput) (json.RawMessage, error) {
	var input any
	if config.FactoryRevision != "" {
		input = map[string]any{"args": string(dispatch.Payload), "event": repositoryJobDispatchEvent(registration, dispatch)}
	} else if repositoryFlowJobKey.MatchString(registration.Job) {
		input = json.RawMessage(config.Input)
	} else {
		input = map[string]any{
			"repo": connection.RepoOwner + "/" + connection.RepoName,
			"job":  registration.Job, "revision": registration.Revision,
			"digest": registration.Digest, "sourceRevision": registration.SourceRevision,
			"configuration": config.Input, "event": repositoryJobDispatchEvent(registration, dispatch),
		}
	}
	return json.Marshal(input)
}

func (s *RepositoryJobService) admitRepositoryJobLaunch(ctx context.Context, registration db.RepositoryJobRegistration, dispatch db.RepositoryJobDispatch) (jobs.RequestReceipt, error) {
	if s == nil || s.flowDispatcher == nil {
		return jobs.RequestReceipt{}, errors.New("repository job Flow dispatcher is unavailable")
	}
	var config RegisterRepositoryJobInput
	if json.Unmarshal(registration.Configuration, &config) != nil {
		return jobs.RequestReceipt{}, fmt.Errorf("invalid repository job registration %s", registration.ID)
	}
	connection, err := s.connectionInput(ctx, registration)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	payload, err := repositoryJobLaunchPayload(registration, dispatch, config, connection)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return s.flowDispatcher.Admit(ctx, flowdispatch.LaunchRequest{
		Scope:     repositoryJobFlowScope(registration.RepositoryID, registration.UserID),
		RequestID: repositoryJobFlowRequestID(dispatch.ID),
		Target:    repositoryJobFlowTarget(registration, dispatch),
		FlowID:    registration.FlowID, Payload: payload,
		AuthorizationContext: repositoryJobFlowAuthorization(registration, dispatch),
		Projection:           repositoryJobProjection(repositoryJobFlowModeLaunch, registration, dispatch, ""),
		// Repository policy is checked against the canonical plan projection
		// before this service admits the exact opaque Control approval.
		ApprovalPolicy: flowdispatch.ApprovalManual,
	})
}

func (s *RepositoryJobService) admitRepositoryJobSignal(ctx context.Context, registration db.RepositoryJobRegistration, dispatch, previous db.RepositoryJobDispatch) (jobs.RequestReceipt, error) {
	if s == nil || s.flowDispatcher == nil {
		return jobs.RequestReceipt{}, errors.New("repository job Flow dispatcher is unavailable")
	}
	payload, err := json.Marshal(repositoryJobDispatchEvent(registration, dispatch))
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return s.flowDispatcher.Signal(ctx, flowdispatch.SignalRequest{
		Scope:     repositoryJobFlowScope(registration.RepositoryID, registration.UserID),
		RequestID: repositoryJobSignalRequestID(dispatch.ID, dispatch.SignalAttempt),
		Target:    repositoryJobFlowTarget(registration, dispatch),
		FlowID:    registration.FlowID, RunID: previous.RunID,
		Name: "repository-job.author-reply", Payload: payload,
		AuthorizationContext: repositoryJobFlowAuthorization(registration, dispatch),
		Projection:           repositoryJobProjection(repositoryJobFlowModeSignal, registration, dispatch, previous.RunID),
	})
}

// RepositoryJobFlowHostTargetResolver authorizes repository automation against
// the dispatch, persisted registration, repository writer, workspace, and pinned
// source revision before the shared flowhost resolver can inspect or start a
// canonical coding host. Paused registrations remain resolvable so an already
// admitted launch can reconnect long enough to deliver its durable cancellation.
type RepositoryJobFlowHostTargetResolver struct {
	jobs *RepositoryJobService
}

func NewRepositoryJobFlowHostTargetResolver(service *RepositoryJobService) (*RepositoryJobFlowHostTargetResolver, error) {
	if service == nil || service.q == nil {
		return nil, errors.New("repository job Flow host target resolver requires the repository job store")
	}
	return &RepositoryJobFlowHostTargetResolver{jobs: service}, nil
}

func (resolver *RepositoryJobFlowHostTargetResolver) ResolveFlowHostTarget(ctx context.Context, target flowruntime.FlowRuntimeTarget) (flowhost.Authority, error) {
	if resolver == nil || resolver.jobs == nil || resolver.jobs.q == nil {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_resolver_unavailable", retryable: true}
	}
	if target.BindingKind != repositoryJobFlowBindingKind || strings.TrimSpace(target.BindingID) == "" {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_target_unsupported"}
	}
	repositoryID, repositoryOK := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	if !repositoryOK || !userOK {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_target_invalid"}
	}
	dispatch, err := resolver.jobs.q.GetRepositoryJobDispatch(ctx, target.BindingID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_target_not_found"}
		}
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_binding_unavailable", retryable: true}
	}
	registration, err := resolver.jobs.q.GetRepositoryJobRegistration(ctx, dispatch.RegistrationID)
	if err != nil {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_binding_unavailable", retryable: !errors.Is(err, pgx.ErrNoRows)}
	}
	if registration.RepositoryID != repositoryID || registration.UserID != userID ||
		registration.ID != dispatch.RegistrationID || registration.Revision != dispatch.Revision ||
		registration.Digest != dispatch.Digest || registration.WorkspaceID == "" {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_target_forbidden"}
	}
	if target.WorkspaceID != "" && target.WorkspaceID != registration.WorkspaceID {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_workspace_replaced"}
	}
	if _, err := resolver.jobs.authorizedRepo(ctx, repositoryID, userID, true); err != nil {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: "runtime_target_forbidden"}
	}
	return flowhost.Authority{
		Target: target, RepositoryID: repositoryID, UserID: userID,
		WorkspaceID: registration.WorkspaceID, CatalogKey: flowhost.CatalogCoding,
		SourceRevision: registration.SourceRevision,
	}, nil
}

type repositoryJobFlowFailure struct {
	code      string
	retryable bool
}

func (failure repositoryJobFlowFailure) Error() string {
	return "repository job Flow runtime: " + failure.code
}
func (failure repositoryJobFlowFailure) FlowRuntimeCode() string    { return failure.code }
func (failure repositoryJobFlowFailure) FlowRuntimeRetryable() bool { return failure.retryable }

func decodeRepositoryJobFlowProjection(raw json.RawMessage) (repositoryJobFlowProjection, bool) {
	var projection repositoryJobFlowProjection
	if json.Unmarshal(raw, &projection) != nil || projection.Kind != repositoryJobFlowProjectionKind {
		return repositoryJobFlowProjection{}, false
	}
	return projection, true
}

func repositoryJobRuntimeReceipt(update flowdispatch.ProjectionUpdate) []byte {
	encoded, _ := json.Marshal(repositoryJobFlowReceipt{
		OperationID: update.OperationID, State: update.State, RunID: update.Checkpoint.RunID,
		PlanID: update.Checkpoint.PlanID, PlanDigest: update.Checkpoint.PlanDigest,
		FailureCode: update.Checkpoint.FailureCode, Receipt: update.Checkpoint.Receipt,
		MutationReceipt: update.Checkpoint.MutationReceipt,
	})
	return encoded
}

func repositoryJobRuntimePlan(checkpoint flowdispatch.RuntimeCheckpoint) []byte {
	if checkpoint.PlanID == "" {
		return nil
	}
	encoded, _ := json.Marshal(repositoryJobPlanProjection{
		PlanID: checkpoint.PlanID, Digest: checkpoint.PlanDigest,
		ExecutionDigest: checkpoint.ExecutionDigest, Envelope: checkpoint.Envelope,
	})
	return encoded
}

func (s *RepositoryJobService) projectRepositoryJobDispatch(ctx context.Context, dispatch db.RepositoryJobDispatch, status, runID, message string, update flowdispatch.ProjectionUpdate) error {
	rows, err := s.q.ProjectRepositoryJobDispatch(ctx, db.ProjectRepositoryJobDispatchParams{
		ID: dispatch.ID, Status: status, RunID: runID,
		Plan: repositoryJobRuntimePlan(update.Checkpoint), Receipt: repositoryJobRuntimeReceipt(update),
		Error: message, NextAttemptAt: s.now().Add(10 * time.Second),
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return errors.New("repository job dispatch is busy; retry receipt projection")
	}
	return nil
}

func repositoryJobPlanAuthorized(registration db.RepositoryJobRegistration, config RegisterRepositoryJobInput, checkpoint flowdispatch.RuntimeCheckpoint) bool {
	if checkpoint.PlanID == "" || checkpoint.PlanDigest == "" || (config.FactoryRevision == "" && checkpoint.ExecutionDigest != config.ExecutionDigest) ||
		!sameRepositoryJobJSON(checkpoint.Envelope, config.Envelope) || len(checkpoint.Approval) == 0 {
		return false
	}
	if config.FactoryRevision == "" && repositoryFlowJobKey.MatchString(registration.Job) && checkpoint.PlanDigest != config.ApprovedPlanDigest {
		return false
	}
	var approval map[string]json.RawMessage
	var target struct {
		Tag      string          `json:"_tag"`
		PlanID   string          `json:"planId"`
		Digest   string          `json:"digest"`
		Envelope json.RawMessage `json:"envelope"`
	}
	return json.Unmarshal(checkpoint.Approval, &approval) == nil && json.Unmarshal(approval["target"], &target) == nil &&
		target.Tag == "Plan" && target.PlanID == checkpoint.PlanID && target.Digest == checkpoint.PlanDigest &&
		sameRepositoryJobJSON(target.Envelope, config.Envelope)
}

func (s *RepositoryJobService) projectRepositoryJobLaunch(ctx context.Context, projection repositoryJobFlowProjection, dispatch db.RepositoryJobDispatch, registration db.RepositoryJobRegistration, config RegisterRepositoryJobInput, update flowdispatch.ProjectionUpdate) error {
	if update.Checkpoint.FlowID != registration.FlowID {
		return s.rejectRepositoryJobPlan(ctx, dispatch, registration, update)
	}
	if update.State == jobs.StateWaiting && update.Checkpoint.RunID == "" && len(update.Checkpoint.Approval) > 0 {
		if !registration.Enabled || registration.Revision != dispatch.Revision || registration.Digest != dispatch.Digest ||
			!repositoryJobPlanAuthorized(registration, config, update.Checkpoint) {
			return s.rejectRepositoryJobPlan(ctx, dispatch, registration, update)
		}
		if _, err := s.authorizedRepo(ctx, registration.RepositoryID, registration.UserID, true); err != nil {
			return s.rejectRepositoryJobPlan(ctx, dispatch, registration, update)
		}
		if err := s.projectRepositoryJobDispatch(ctx, dispatch, "waiting", "", "", update); err != nil {
			return err
		}
		_, err := s.flowDispatcher.Approve(ctx,
			repositoryJobFlowScope(registration.RepositoryID, registration.UserID), update.OperationID,
			update.OperationID+":repository-auto-approve", repositoryJobFlowAuthorization(registration, dispatch))
		return err
	}
	status, runID, message := "waiting", update.Checkpoint.RunID, ""
	if runID != "" {
		status = "submitted"
	}
	switch update.State {
	case jobs.StateCompleted:
		status = "submitted"
	case jobs.StateFailed:
		status, message = "failed", "The canonical Flow run failed"
	case jobs.StateCancelled:
		status, message = "failed", "The canonical Flow run was cancelled"
	}
	return s.projectRepositoryJobDispatch(ctx, dispatch, status, runID, message, update)
}

func (s *RepositoryJobService) rejectRepositoryJobPlan(ctx context.Context, dispatch db.RepositoryJobDispatch, registration db.RepositoryJobRegistration, update flowdispatch.ProjectionUpdate) error {
	const message = "The registered flow or its authority changed; review and apply a new version"
	if err := s.projectRepositoryJobDispatch(ctx, dispatch, "failed", "", message, update); err != nil {
		return err
	}
	_, err := s.flowDispatcher.CancelRequest(ctx,
		repositoryJobFlowScope(registration.RepositoryID, registration.UserID), repositoryJobFlowRequestID(dispatch.ID))
	return err
}

func repositoryJobSignalOperationID(receipt []byte) string {
	var value struct {
		OperationID string `json:"operationId"`
	}
	_ = json.Unmarshal(receipt, &value)
	return value.OperationID
}

func repositoryJobSignalProjectionCurrent(dispatch db.RepositoryJobDispatch, projection repositoryJobFlowProjection, operationID string) bool {
	return dispatch.SignalAttempt == projection.SignalAttempt && dispatch.Status == "waiting" &&
		repositoryJobSignalOperationID(dispatch.Receipt) == operationID
}

func (s *RepositoryJobService) finishRepositoryJobSignalProjection(ctx context.Context, projection repositoryJobFlowProjection, dispatchID, operationID string, rows int64) error {
	if rows == 1 {
		return nil
	}
	current, err := s.q.GetRepositoryJobDispatch(ctx, dispatchID)
	if err != nil {
		return err
	}
	if repositoryJobSignalProjectionCurrent(current, projection, operationID) ||
		(current.Status == "dispatching" && current.SignalAttempt == projection.SignalAttempt) {
		return errors.New("repository job dispatch is busy; retry signal projection")
	}
	return nil
}

func (s *RepositoryJobService) projectRepositoryJobSignalDispatch(ctx context.Context, projection repositoryJobFlowProjection, dispatch db.RepositoryJobDispatch, status, runID, message, expectedOperationID string, update flowdispatch.ProjectionUpdate) error {
	rows, err := s.q.ProjectRepositoryJobSignal(ctx, db.ProjectRepositoryJobSignalParams{
		ID: dispatch.ID, Status: status, RunID: runID,
		Plan: repositoryJobRuntimePlan(update.Checkpoint), Receipt: repositoryJobRuntimeReceipt(update),
		Error: message, NextAttemptAt: s.now().Add(10 * time.Second),
		ExpectedSignalAttempt: projection.SignalAttempt, ExpectedOperationID: expectedOperationID,
	})
	if err != nil {
		return err
	}
	return s.finishRepositoryJobSignalProjection(ctx, projection, dispatch.ID, expectedOperationID, rows)
}

func (s *RepositoryJobService) projectRepositoryJobSignal(ctx context.Context, projection repositoryJobFlowProjection, dispatch db.RepositoryJobDispatch, registration db.RepositoryJobRegistration, update flowdispatch.ProjectionUpdate) error {
	if !repositoryJobSignalProjectionCurrent(dispatch, projection, update.OperationID) {
		if dispatch.Status == "dispatching" && dispatch.SignalAttempt == projection.SignalAttempt {
			return errors.New("repository job dispatch is busy; retry signal projection")
		}
		return nil
	}
	switch update.State {
	case jobs.StateCompleted:
		return s.projectRepositoryJobSignalDispatch(ctx, projection, dispatch, "submitted", projection.PreviousRunID, "", update.OperationID, update)
	case jobs.StateFailed:
		switch update.Checkpoint.FailureCode {
		case "no_matching_wait":
			rows, err := s.q.RetryProjectedRepositoryJobSignal(ctx, db.RetryProjectedRepositoryJobSignalParams{
				ID: dispatch.ID, Receipt: repositoryJobRuntimeReceipt(update), NextAttemptAt: s.now().Add(10 * time.Second),
				ExpectedSignalAttempt: projection.SignalAttempt, ExpectedOperationID: update.OperationID,
			})
			if err != nil {
				return err
			}
			return s.finishRepositoryJobSignalProjection(ctx, projection, dispatch.ID, update.OperationID, rows)
		case "runtime_run_terminal":
			receipt, err := s.admitRepositoryJobLaunch(ctx, registration, dispatch)
			if err != nil {
				return err
			}
			launchUpdate := update
			launchUpdate.OperationID = receipt.OperationID
			launchUpdate.State = jobs.StateAccepted
			launchUpdate.Checkpoint = flowdispatch.RuntimeCheckpoint{
				Version: 1, Target: repositoryJobFlowTarget(registration, dispatch), FlowID: registration.FlowID,
				Projection: repositoryJobProjection(repositoryJobFlowModeLaunch, registration, dispatch, ""),
			}
			return s.projectRepositoryJobSignalDispatch(ctx, projection, dispatch, "waiting", "", "", update.OperationID, launchUpdate)
		}
	}
	return s.projectRepositoryJobSignalDispatch(ctx, projection, dispatch, "failed", projection.PreviousRunID, "The canonical Flow signal failed", update.OperationID, update)
}

// ProjectFlowRuntime makes repository_job_dispatches a receipt projection of
// Control. It never plans, runs, lists, or reconstructs canonical Flow state.
func (s *RepositoryJobService) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	projection, ok := decodeRepositoryJobFlowProjection(update.Checkpoint.Projection)
	if !ok {
		return nil
	}
	if s == nil || s.q == nil || s.flowDispatcher == nil {
		return errors.New("repository job Flow projection is unavailable")
	}
	dispatch, err := s.q.GetRepositoryJobDispatch(ctx, projection.DispatchID)
	if err != nil {
		return err
	}
	registration, err := s.q.GetRepositoryJobRegistration(ctx, projection.RegistrationID)
	if err != nil {
		return err
	}
	if dispatch.RegistrationID != registration.ID || dispatch.Revision != projection.Revision ||
		projection.RegistrationID != dispatch.RegistrationID ||
		update.Scope != repositoryJobFlowScope(registration.RepositoryID, registration.UserID) ||
		update.Checkpoint.Target.BindingKind != repositoryJobFlowBindingKind ||
		update.Checkpoint.Target.BindingID != dispatch.ID {
		return errors.New("repository job Flow projection identity is invalid")
	}
	var config RegisterRepositoryJobInput
	if json.Unmarshal(registration.Configuration, &config) != nil {
		return errors.New("repository job Flow registration is invalid")
	}
	switch projection.Mode {
	case repositoryJobFlowModeLaunch:
		return s.projectRepositoryJobLaunch(ctx, projection, dispatch, registration, config, update)
	case repositoryJobFlowModeSignal:
		return s.projectRepositoryJobSignal(ctx, projection, dispatch, registration, update)
	default:
		return errors.New("repository job Flow projection mode is invalid")
	}
}

var _ flowhost.TargetResolver = (*RepositoryJobFlowHostTargetResolver)(nil)
var _ flowruntime.FlowRuntimeFailure = repositoryJobFlowFailure{}
var _ flowdispatch.Projector = (*RepositoryJobService)(nil)
