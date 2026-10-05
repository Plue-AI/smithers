package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type safeFailure struct {
	code      string
	retryable bool
}

func (failure safeFailure) Error() string { return "flow dispatch: " + failure.code }

func (service *Service) Handle(ctx context.Context, lease *jobs.Lease) error {
	if lease == nil {
		return errors.New("flow dispatch: lease is required")
	}
	switch lease.Claim().Operation {
	case OperationLaunch:
		return service.handleLaunch(ctx, lease)
	case OperationApprove:
		return service.handleApproval(ctx, lease)
	case OperationSignal:
		return service.handleSignal(ctx, lease)
	case OperationSteer:
		return service.handleSteer(ctx, lease)
	default:
		return errors.New("flow dispatch: unsupported product operation")
	}
}

func (service *Service) handleLaunch(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var payload launchPayload
	if err := json.Unmarshal(claim.Payload, &payload); err != nil {
		return service.fail(lease, "invalid_product_request", RuntimeCheckpoint{})
	}
	checkpoint, err := decodeCheckpoint(claim.ExternalReceipt)
	if err != nil {
		return service.fail(lease, "invalid_checkpoint", RuntimeCheckpoint{Projection: payload.Projection})
	}
	if checkpoint.Version == 0 {
		checkpoint = RuntimeCheckpoint{
			Version: 1, Target: payload.Target, FlowID: payload.FlowID, Projection: payload.Projection,
		}
	}
	if checkpoint.FlowID != payload.FlowID || checkpoint.Target != payload.Target {
		return service.fail(lease, "checkpoint_request_mismatch", checkpoint)
	}
	// The todo composition runs only from a pinned stack launch. Refuse any
	// other before a machine wakes, a host starts or a token is minted.
	if (payload.Pin != nil && !payload.Pin.Valid()) || !todoLaunchAllowed(payload.FlowID, payload.Target, payload.Pin) {
		return service.fail(lease, "todo_requires_stack_admission", checkpoint)
	}
	// No external checkpoint means Control has never seen this launch. A
	// cancellation already present on the claim can therefore settle locally;
	// it must not wait for (or accidentally start) an unavailable host.
	if claim.CancellationRequested && len(claim.ExternalReceipt) == 0 {
		return service.settleBeforeLaunchCancellation(ctx, lease, checkpoint)
	}
	runtime, identity, err := service.resolve(ctx, checkpoint.Target, checkpoint.Identity)
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	checkpoint.FailureCode = ""
	checkpoint.FailureClass = ""
	checkpoint.FailureObservedAt = 0
	checkpoint.Identity = identity
	marker, err := json.Marshal(checkpoint)
	if err != nil {
		return err
	}
	if err := lease.StartExternal(ctx, marker); err != nil {
		if errors.Is(err, jobs.ErrCancellationRequested) {
			return service.settleBeforeLaunchCancellation(ctx, lease, checkpoint)
		}
		return err
	}

	// A durable run id means launch acceptance already happened. Reconnect only
	// through Observe; never infer progress from product rows or host readiness.
	if checkpoint.RunID != "" {
		if !payload.Pin.Admits(payload.FlowID, checkpoint.ExecutionDigest) {
			return service.refusePin(ctx, runtime, lease, checkpoint)
		}
		if claim.CancellationRequested {
			if err := service.cancelRun(ctx, runtime, lease, &checkpoint); err != nil {
				return err
			}
		}
		return service.observe(ctx, runtime, lease, checkpoint)
	}

	// A pinned launch runs on its lane's host, which serves the lane's working
	// copy: the host reads the pinned flow from the pin's source commit, never
	// from that working copy, and plans nothing else (spec §11.4.1).
	result, err := service.launch(ctx, runtime, identity, claim.OperationID, int64(lease.DeliveryAttempt()), payload)
	if err != nil {
		if claim.CancellationRequested && runtimeCode(err) == "plan_denied" {
			return service.settleDenied(ctx, lease, checkpoint, "plan_denied")
		}
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validLaunchResult(result, identity, claim.OperationID) {
		return service.fail(lease, "runtime_launch_identity_mismatch", checkpoint)
	}
	checkpoint.PlanID = result.PlanID
	checkpoint.PlanDigest = result.PlanDigest
	checkpoint.ExecutionDigest = result.ExecutionDigest
	checkpoint.Envelope = result.Envelope
	checkpoint.Approval = result.Approval
	checkpoint.Receipt = &result.Receipt
	checkpoint.RunID = result.Receipt.RunID
	// A host that planned other code than the pin, or named none, never
	// runs for the attempt: its plan is denied or its run cancelled.
	if !payload.Pin.Admits(payload.FlowID, result.ExecutionDigest) {
		return service.refusePin(ctx, runtime, lease, checkpoint)
	}

	switch result.Receipt.Tag {
	case "Parked":
		if checkpoint.PlanID == "" || len(checkpoint.Approval) == 0 {
			return service.fail(lease, "invalid_parked_receipt", checkpoint)
		}
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if claim.CancellationRequested {
			return service.denyPlan(ctx, runtime, lease, checkpoint)
		}
		if payload.ApprovalPolicy == ApprovalAuto {
			decision, err := service.admitApproval(
				context.WithoutCancel(ctx), claim.Scope, claim.OperationID,
				claim.OperationID+":auto-approve", claim.AuthorizationContext, checkpoint,
			)
			if err != nil {
				return safeFailure{code: "approval_admission_unavailable", retryable: true}
			}
			checkpoint.ApprovalOperationID = decision.OperationID
			if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
				return err
			}
		}
		// Launch is the only way to learn that a parked plan was approved, so
		// the launch keeps polling with backoff. An admitted approval wakes it.
		delay := service.nextObservation(&checkpoint, false)
		return lease.Defer(ctx, mustJSON(checkpoint), delay)
	case "Accepted", "AlreadyApplied":
		if checkpoint.RunID == "" {
			return service.fail(lease, "runtime_receipt_missing_run", checkpoint)
		}
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if claim.CancellationRequested {
			if err := service.cancelRun(ctx, runtime, lease, &checkpoint); err != nil {
				return err
			}
		}
		return service.observe(ctx, runtime, lease, checkpoint)
	case "Terminal":
		if !terminalStatus(result.Receipt.Status) || result.Receipt.RunID == "" {
			return service.fail(lease, "invalid_terminal_receipt", checkpoint)
		}
		checkpoint.Run = &flowruntime.FlowRuntimeRun{
			RunID: result.Receipt.RunID, FlowID: payload.FlowID, Status: result.Receipt.Status, PlanID: result.PlanID,
		}
		return service.settle(ctx, lease, checkpoint)
	case "Conflict":
		return service.fail(lease, "runtime_conflict", checkpoint)
	default:
		return service.fail(lease, "invalid_runtime_receipt", checkpoint)
	}
}

func (service *Service) settleBeforeLaunchCancellation(
	ctx context.Context,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	if err := service.project(context.WithoutCancel(ctx), lease, jobs.StateCancelled, checkpoint); err != nil {
		return err
	}
	return lease.Cancelled(ctx, mustJSON(terminalReceipt{
		Kind:       "cancelled-before-runtime-launch",
		Runtime:    checkpoint.Identity,
		Projection: checkpoint.Projection,
	}))
}

func (service *Service) launch(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	identity flowruntime.FlowRuntimeIdentity,
	operationID string,
	attempt int64,
	payload launchPayload,
) (flowruntime.FlowRuntimeLaunchResult, error) {
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	defer cancel()
	return runtime.Launch(callContext, flowruntime.FlowRuntimeLaunch{
		ApplicationRequestID: operationID, Attempt: attempt, OwnerGeneration: identity.OwnerGeneration,
		RuntimeArtifactDigest: identity.RuntimeArtifactDigest, SourceRevision: identity.SourceRevision,
		FlowID: payload.FlowID, Payload: payload.Payload, Pin: payload.Pin,
	})
}

// refusePin stops a launch whose host planned or ran other code than its pin.
// A parked plan is denied; a run is cancelled and observed until it ends,
// without credit, so the attempt retries only after it settled. The launch
// fails pin_mismatch either way.
//
// Cancelling does not undo or prevent a mismatched run's effects. Until its
// host acknowledges the cancel and the run ends, the run keeps its lane token
// and model credential: it can push to its own branch, spend model tokens
// and run commands in its machine. The cancel needs that host's cooperation;
// nothing here revokes a credential or stops the machine. Opening or merging
// a pull request is gated separately. The bridge reads the pinned flow from
// the pin's source commit and refuses before import when its digest is not
// the pin's, but that measurement is the host's own claim.
func (service *Service) refusePin(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	checkpoint.FailureCode = pinMismatch
	switch {
	case checkpoint.RunID != "":
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if checkpoint.MutationReceipt == nil {
			if err := service.cancelRun(ctx, runtime, lease, &checkpoint); err != nil {
				return err
			}
		}
		return service.observe(ctx, runtime, lease, checkpoint)
	case len(checkpoint.Approval) > 0:
		callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), service.runtimeCallTimeout)
		result, err := runtime.Deny(callContext, flowruntime.FlowRuntimeDecision{
			ApplicationRequestID: lease.Claim().OperationID + ":deny",
			OwnerGeneration:      checkpoint.Identity.OwnerGeneration,
			Approval:             checkpoint.Approval,
		})
		cancel()
		if err != nil {
			return service.runtimeError(lease, err, checkpoint)
		}
		if !validMutationResult(result, "deny", lease.Claim().OperationID+":deny") {
			return service.fail(lease, "invalid_denial_receipt", checkpoint)
		}
		checkpoint.MutationReceipt = &result.Receipt
	}
	return service.fail(lease, pinMismatch, checkpoint)
}

func (service *Service) handleApproval(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var payload approvalPayload
	if err := json.Unmarshal(claim.Payload, &payload); err != nil || len(payload.Approval) == 0 {
		return service.fail(lease, "invalid_approval_request", RuntimeCheckpoint{})
	}
	origin, err := service.store.Get(ctx, claim.Scope, payload.LaunchOperationID)
	if err != nil {
		return safeFailure{code: "launch_projection_unavailable", retryable: true}
	}
	// Once a delivery may have reached Control, replay its durable receipt even
	// if the launch settled meanwhile. Product state only gates a first call.
	if origin.Operation != OperationLaunch || (len(claim.ExternalReceipt) == 0 && (origin.State.Terminal() || origin.CancellationRequested)) {
		return service.fail(lease, "approval_no_longer_available", RuntimeCheckpoint{})
	}
	runtime, identity, err := service.resolve(ctx, payload.Target, payload.Identity)
	if err != nil {
		return service.runtimeError(lease, err, RuntimeCheckpoint{Identity: payload.Identity})
	}
	checkpoint := RuntimeCheckpoint{
		Version: 1, Target: payload.Target, Identity: identity, Approval: payload.Approval,
	}
	if err := lease.StartExternal(ctx, mustJSON(checkpoint)); err != nil {
		return err
	}
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	result, err := runtime.Approve(callContext, flowruntime.FlowRuntimeDecision{
		ApplicationRequestID: claim.OperationID, OwnerGeneration: identity.OwnerGeneration, Approval: payload.Approval,
	})
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validMutationResult(result, "approve", claim.OperationID) {
		return service.fail(lease, "invalid_approval_receipt", checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	receipt := terminalReceipt{
		Kind: "runtime-approval", Runtime: identity, Receipt: &result.Receipt, Projection: json.RawMessage(`{}`),
	}
	if err := lease.Complete(ctx, mustJSON(receipt)); err != nil {
		return err
	}
	// The parked launch learns about the decision on its next poll; make that
	// poll happen now. A missed wake only delays it to its backoff.
	if err := service.store.Wake(context.WithoutCancel(ctx), claim.Scope, payload.LaunchOperationID); err != nil {
		slog.WarnContext(ctx, "flow dispatch could not wake the approved launch",
			"operation_id", payload.LaunchOperationID, "error", err)
	}
	return nil
}

func (service *Service) handleSignal(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var payload signalPayload
	if err := json.Unmarshal(claim.Payload, &payload); err != nil || payload.RunID == "" || payload.Name == "" {
		return service.fail(lease, "invalid_signal_request", RuntimeCheckpoint{})
	}
	return service.handleRunMutation(ctx, lease, runMutationPayload{
		Target: payload.Target, FlowID: payload.FlowID, RunID: payload.RunID, Projection: payload.Projection,
	}, "signal", func(ctx context.Context, runtime flowruntime.Runtime, generation int64) (flowruntime.MutationResult, error) {
		return runtime.Signal(ctx, flowruntime.Signal{
			ApplicationRequestID: claim.OperationID, OwnerGeneration: generation,
			RunID: payload.RunID, Name: payload.Name, Payload: payload.Payload,
		})
	})
}

func (service *Service) handleSteer(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var payload steerPayload
	if err := json.Unmarshal(claim.Payload, &payload); err != nil || payload.RunID == "" || payload.FlowID == "" ||
		!validSteerInput(payload.MessageID, payload.CreatedAt, payload.Body) {
		return service.fail(lease, "invalid_steer_request", RuntimeCheckpoint{})
	}
	request := SteerRequest{
		Scope: claim.Scope, RequestID: claim.RequestID, Target: payload.Target,
		FlowID: payload.FlowID, RunID: payload.RunID, MessageID: payload.MessageID,
		CreatedAt: payload.CreatedAt, Body: payload.Body,
		Attribution:          payload.Attribution,
		AuthorizationContext: claim.AuthorizationContext, Projection: payload.Projection,
	}
	authorize := func(ctx context.Context) error {
		if service.steerAuthorizer != nil {
			return service.steerAuthorizer.AuthorizeFlowSteer(ctx, request)
		}
		if payload.FlowID == TodoFlow || payload.Target.BindingKind == StackBindingKind {
			return safeFailure{code: "steer_authorizer_unavailable", retryable: true}
		}
		return nil
	}
	if err := authorize(ctx); err != nil {
		checkpoint, decodeErr := decodeCheckpoint(claim.ExternalReceipt)
		if decodeErr != nil {
			return service.fail(lease, "invalid_checkpoint", RuntimeCheckpoint{Projection: payload.Projection})
		}
		if checkpoint.Version == 0 {
			checkpoint = RuntimeCheckpoint{Version: 1, Target: payload.Target, FlowID: payload.FlowID, RunID: payload.RunID, Projection: payload.Projection}
		}
		return service.runtimeError(lease, err, checkpoint)
	}
	return service.handleRunMutation(ctx, lease, payload.runMutationPayload, "steer",
		func(ctx context.Context, runtime flowruntime.Runtime, generation int64) (flowruntime.MutationResult, error) {
			// Waking and observing a retained host can take minutes. A removal
			// committed during that wait must stop the Message too.
			if err := authorize(ctx); err != nil {
				return flowruntime.MutationResult{}, err
			}
			return runtime.Steer(ctx, flowruntime.Steer{
				ApplicationRequestID: claim.OperationID, OwnerGeneration: generation,
				RunID: payload.RunID, MessageID: payload.MessageID, CreatedAt: payload.CreatedAt,
				Kind: "Message", Body: payload.Body,
				Attribution: payload.Attribution,
			})
		})
}

// Both input kinds share wake, run identity verification, and receipt recovery.
// The runtime remains the authority for whether an input was already applied.
func (service *Service) handleRunMutation(ctx context.Context, lease *jobs.Lease, payload runMutationPayload, kind string,
	mutate func(context.Context, flowruntime.Runtime, int64) (flowruntime.MutationResult, error),
) error {
	claim := lease.Claim()
	checkpoint, err := decodeCheckpoint(claim.ExternalReceipt)
	if err != nil {
		return service.fail(lease, "invalid_checkpoint", RuntimeCheckpoint{Projection: payload.Projection})
	}
	if checkpoint.Version == 0 {
		checkpoint = RuntimeCheckpoint{
			Version: 1, Target: payload.Target, FlowID: payload.FlowID,
			RunID: payload.RunID, Projection: payload.Projection,
		}
	}
	if checkpoint.Target != payload.Target || checkpoint.FlowID != payload.FlowID || checkpoint.RunID != payload.RunID {
		return service.fail(lease, "checkpoint_request_mismatch", checkpoint)
	}
	if payload.FlowID == "todo" {
		// Checkpoint before the resolver's existing start/verification path.
		// Outages and process restarts cannot restart this wake allowance.
		if checkpoint.WakeStartedAt == 0 {
			checkpoint.WakeStartedAt = time.Now().UnixMilli()
		}
		if err := lease.StartExternal(ctx, mustJSON(checkpoint)); err != nil {
			return err
		}
		if _, err := lease.Checkpoint(ctx, mustJSON(checkpoint)); err != nil {
			return err
		}
		if todoWakeExpired(checkpoint, time.Now()) {
			checkpoint.FailureStep, checkpoint.FailureClass = "wake", "infra"
			return service.fail(lease, "wake_timeout", checkpoint)
		}
	}
	resolveContext := ctx
	if payload.FlowID == "todo" {
		var cancel context.CancelFunc
		resolveContext, cancel = context.WithDeadline(ctx, time.UnixMilli(checkpoint.WakeStartedAt).Add(15*time.Minute))
		defer cancel()
	}
	runtime, identity, err := service.resolve(resolveContext, checkpoint.Target, checkpoint.Identity)
	if err != nil {
		if payload.FlowID == "todo" {
			return service.todoWakeError(ctx, lease, err, checkpoint)
		}
		return service.runtimeError(lease, err, checkpoint)
	}
	if payload.FlowID == "todo" && todoWakeExpired(checkpoint, time.Now()) {
		checkpoint.FailureStep, checkpoint.FailureClass = "wake", "infra"
		return service.fail(lease, "wake_timeout", checkpoint)
	}
	checkpoint.Identity = identity
	if err := lease.StartExternal(ctx, mustJSON(checkpoint)); err != nil {
		return err
	}
	if payload.FlowID == "todo" {
		if _, err := lease.Checkpoint(ctx, mustJSON(checkpoint)); err != nil {
			return err
		}
	}

	// Observation verifies the requested run's Flow identity. Its terminal
	// state cannot distinguish a lost acknowledgment for a delivered input
	// from a run that never took it; only Control's mutation receipt can.
	// A verified host is not yet proof that this run has reattached. Keep the
	// original wake allowance through Observe, including its durable retries.
	callContext, cancel := context.WithTimeout(resolveContext, service.runtimeCallTimeout)
	observation, err := runtime.Observe(callContext, checkpoint.RunID, "", 1)
	cancel()
	if err != nil {
		if payload.FlowID == "todo" {
			return service.todoWakeError(ctx, lease, err, checkpoint)
		}
		return service.runtimeError(lease, err, checkpoint)
	}
	if observation.Run.RunID != checkpoint.RunID || observation.Run.FlowID != checkpoint.FlowID ||
		observation.Terminal != terminalStatus(observation.Run.Status) || !validObservationPage("", observation) {
		return service.fail(lease, "invalid_runtime_observation", checkpoint)
	}
	checkpoint.Run = &observation.Run
	if payload.FlowID == "todo" && todoWakeExpired(checkpoint, time.Now()) {
		checkpoint.FailureStep, checkpoint.FailureClass = "wake", "infra"
		return service.fail(lease, "wake_timeout", checkpoint)
	}
	checkpoint.WakeStartedAt = 0
	checkpoint.FailureStep, checkpoint.FailureCode, checkpoint.FailureClass = "", "", ""
	if payload.FlowID == "todo" {
		if _, err := lease.Checkpoint(ctx, mustJSON(checkpoint)); err != nil {
			return err
		}
	}

	callContext, cancel = context.WithTimeout(ctx, service.runtimeCallTimeout)
	result, err := mutate(callContext, runtime, identity.OwnerGeneration)
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validRunMutationResult(result, kind, claim.OperationID, checkpoint.RunID) {
		return service.fail(lease, "invalid_"+kind+"_receipt", checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	if result.Receipt.Tag == "Terminal" {
		if result.Receipt.RunID != checkpoint.RunID || !terminalStatus(result.Receipt.Status) {
			return service.fail(lease, "invalid_"+kind+"_receipt", checkpoint)
		}
		checkpoint.Run = &flowruntime.FlowRuntimeRun{
			RunID: checkpoint.RunID, FlowID: checkpoint.FlowID, Status: result.Receipt.Status,
		}
		return service.fail(lease, "runtime_run_terminal", checkpoint)
	}
	if err := service.project(context.WithoutCancel(ctx), lease, jobs.StateCompleted, checkpoint); err != nil {
		return err
	}
	return lease.Complete(ctx, mustJSON(terminalReceipt{
		Kind: "runtime-" + kind, Runtime: identity, Receipt: &result.Receipt,
		Run: checkpoint.Run, Projection: checkpoint.Projection,
	}))
}

func (service *Service) todoWakeError(ctx context.Context, lease *jobs.Lease, err error, checkpoint RuntimeCheckpoint) error {
	code, retryable := runtimeFailure(err)
	if retryable || code == "runtime_host_not_running" {
		checkpoint.FailureStep, checkpoint.FailureClass = "wake", "infra"
		checkpoint.FailureCode, checkpoint.FailureObservedAt = code, time.Now().UnixMilli()
		if todoWakeExpired(checkpoint, time.Now()) {
			return service.fail(lease, "wake_timeout", checkpoint)
		}
		if err := service.project(ctx, lease, jobs.StateWaiting, checkpoint); err != nil {
			return err
		}
		return lease.Park(ctx, mustJSON(checkpoint), todoWakeBackoff(lease.Claim().Attempt))
	}
	return service.runtimeError(lease, err, checkpoint)
}

func todoWakeExpired(checkpoint RuntimeCheckpoint, now time.Time) bool {
	return checkpoint.WakeStartedAt > 0 && !now.Before(time.UnixMilli(checkpoint.WakeStartedAt).Add(15*time.Minute))
}

func todoWakeBackoff(attempt int) time.Duration {
	return time.Second << min(max(attempt-1, 0), 5)
}

func (service *Service) resolve(
	ctx context.Context,
	target flowruntime.FlowRuntimeTarget,
	pinned flowruntime.FlowRuntimeIdentity,
) (flowruntime.FlowRuntime, flowruntime.FlowRuntimeIdentity, error) {
	callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
	defer cancel()
	runtime, err := service.resolver.ResolveFlowRuntime(callContext, target)
	if err != nil {
		return nil, flowruntime.FlowRuntimeIdentity{}, err
	}
	if runtime == nil {
		return nil, flowruntime.FlowRuntimeIdentity{}, safeFailure{code: "runtime_unavailable", retryable: true}
	}
	identity, err := runtime.Identity(callContext)
	if err != nil {
		return nil, flowruntime.FlowRuntimeIdentity{}, err
	}
	if !validIdentity(identity) {
		return nil, flowruntime.FlowRuntimeIdentity{}, safeFailure{code: "invalid_runtime_identity"}
	}
	if pinned.Protocol != "" && (pinned.Protocol != identity.Protocol ||
		pinned.RuntimeArtifactDigest != identity.RuntimeArtifactDigest || pinned.SourceRevision != identity.SourceRevision) {
		return nil, flowruntime.FlowRuntimeIdentity{}, safeFailure{code: "runtime_identity_changed"}
	}
	return runtime, identity, nil
}

func (service *Service) observe(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	progressed := false
	for page := 0; page < service.observationPages; page++ {
		callContext, cancel := context.WithTimeout(ctx, service.runtimeCallTimeout)
		observation, err := runtime.Observe(callContext, checkpoint.RunID, checkpoint.Cursor, service.observationLimit)
		cancel()
		if err != nil {
			return service.runtimeError(lease, err, checkpoint)
		}
		if observation.Run.RunID != checkpoint.RunID || observation.Run.FlowID != checkpoint.FlowID ||
			observation.Terminal != terminalStatus(observation.Run.Status) ||
			!validObservationPage(checkpoint.Cursor, observation) {
			return service.fail(lease, "invalid_runtime_observation", checkpoint)
		}
		if observation.NextCursor != checkpoint.Cursor || checkpoint.Run == nil || checkpoint.Run.Status != observation.Run.Status {
			progressed = true
		}
		after := checkpoint.Cursor
		checkpoint.Cursor = observation.NextCursor
		checkpoint.Run = &observation.Run
		// The page reaches the projection before its cursor is saved, so a
		// failure between them re-observes the page rather than losing it.
		if len(observation.Events) > 0 && service.projector != nil {
			if err := service.projector.ProjectFlowRuntime(context.WithoutCancel(ctx), ProjectionUpdate{
				OperationID: lease.Claim().OperationID, Scope: lease.Claim().Scope, State: jobs.StateWaiting,
				Checkpoint: checkpoint, Events: observation.Events, EventsAfter: after,
			}); err != nil {
				return safeFailure{code: "product_projection_unavailable", retryable: true}
			}
		}
		if err := service.checkpoint(ctx, lease, checkpoint, jobs.StateWaiting); err != nil {
			return err
		}
		if observation.Terminal {
			return service.settle(ctx, lease, checkpoint)
		}
		if !observation.HasMore {
			break
		}
	}
	delay := service.nextObservation(&checkpoint, progressed)
	return lease.Defer(ctx, mustJSON(checkpoint), delay)
}

// nextObservation returns the wait before the next poll and records it in the
// checkpoint. Progress resets the backoff; an idle poll doubles it until the
// limit, after which the checkpoint stops changing.
func (service *Service) nextObservation(checkpoint *RuntimeCheckpoint, progressed bool) time.Duration {
	if progressed {
		checkpoint.IdlePolls = 0
	} else if service.observationBackoff(checkpoint.IdlePolls) < service.maxObservationDelay {
		checkpoint.IdlePolls++
	}
	return service.observationBackoff(checkpoint.IdlePolls)
}

func (service *Service) observationBackoff(idlePolls int) time.Duration {
	delay := service.observationDelay
	for range idlePolls {
		// Compare before doubling so even the largest admitted durations saturate safely.
		if delay >= service.maxObservationDelay-delay {
			return service.maxObservationDelay
		}
		delay *= 2
	}
	return min(delay, service.maxObservationDelay)
}

func (service *Service) cancelRun(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint *RuntimeCheckpoint,
) error {
	callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), service.runtimeCallTimeout)
	result, err := runtime.Cancel(callContext, flowruntime.FlowRuntimeLifecycle{
		ApplicationRequestID: lease.Claim().OperationID + ":cancel",
		OwnerGeneration:      checkpoint.Identity.OwnerGeneration,
		RunID:                checkpoint.RunID,
		Reason:               "product cancellation requested",
	})
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, *checkpoint)
	}
	if !validMutationResult(result, "cancel", lease.Claim().OperationID+":cancel") {
		return service.fail(lease, "invalid_cancellation_receipt", *checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	return service.checkpoint(context.WithoutCancel(ctx), lease, *checkpoint, jobs.StateWaiting)
}

func (service *Service) denyPlan(
	ctx context.Context,
	runtime flowruntime.FlowRuntime,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
) error {
	callContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), service.runtimeCallTimeout)
	result, err := runtime.Deny(callContext, flowruntime.FlowRuntimeDecision{
		ApplicationRequestID: lease.Claim().OperationID + ":deny",
		OwnerGeneration:      checkpoint.Identity.OwnerGeneration,
		Approval:             checkpoint.Approval,
	})
	cancel()
	if err != nil {
		return service.runtimeError(lease, err, checkpoint)
	}
	if !validMutationResult(result, "deny", lease.Claim().OperationID+":deny") {
		return service.fail(lease, "invalid_denial_receipt", checkpoint)
	}
	checkpoint.MutationReceipt = &result.Receipt
	return service.settleDenied(ctx, lease, checkpoint, "runtime-plan-denied")
}

func (service *Service) settleDenied(
	ctx context.Context,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
	kind string,
) error {
	if err := service.project(context.WithoutCancel(ctx), lease, jobs.StateCancelled, checkpoint); err != nil {
		return err
	}
	receipt := terminalReceipt{
		Kind: kind, Runtime: checkpoint.Identity, Receipt: checkpoint.MutationReceipt,
		Projection: checkpoint.Projection,
	}
	return lease.Cancelled(ctx, mustJSON(receipt))
}

func (service *Service) settle(ctx context.Context, lease *jobs.Lease, checkpoint RuntimeCheckpoint) error {
	if checkpoint.Run == nil || !terminalStatus(checkpoint.Run.Status) {
		return service.fail(lease, "runtime_not_terminal", checkpoint)
	}
	// A cancelled run of other code than the pin settles as the refusal it
	// is, never as the run's own outcome.
	if checkpoint.FailureCode == pinMismatch {
		return service.fail(lease, pinMismatch, checkpoint)
	}
	state := jobs.StateFailed
	switch checkpoint.Run.Status {
	case "completed":
		state = jobs.StateCompleted
	case "cancelled":
		state = jobs.StateCancelled
	}
	if err := service.project(context.WithoutCancel(ctx), lease, state, checkpoint); err != nil {
		return err
	}
	receipt := mustJSON(terminalReceipt{
		Kind: "runtime-terminal", Runtime: checkpoint.Identity, Receipt: checkpoint.Receipt,
		Run: checkpoint.Run, Cursor: checkpoint.Cursor, Projection: checkpoint.Projection,
	})
	switch state {
	case jobs.StateCompleted:
		return lease.Complete(ctx, receipt)
	case jobs.StateCancelled:
		if lease.Claim().CancellationRequested {
			return lease.Cancelled(ctx, receipt)
		}
		return lease.ExternalCancelled(ctx, receipt)
	default:
		return lease.Fail(ctx, receipt)
	}
}

func (service *Service) checkpoint(
	ctx context.Context,
	lease *jobs.Lease,
	checkpoint RuntimeCheckpoint,
	state jobs.State,
) error {
	if err := lease.Waiting(context.WithoutCancel(ctx), mustJSON(checkpoint)); err != nil {
		return err
	}
	return service.project(context.WithoutCancel(ctx), lease, state, checkpoint)
}

func (service *Service) project(ctx context.Context, lease *jobs.Lease, state jobs.State, checkpoint RuntimeCheckpoint) error {
	if service.projector == nil {
		return nil
	}
	if err := service.projector.ProjectFlowRuntime(ctx, ProjectionUpdate{
		OperationID: lease.Claim().OperationID, Scope: lease.Claim().Scope, State: state, Checkpoint: checkpoint,
	}); err != nil {
		return safeFailure{code: "product_projection_unavailable", retryable: true}
	}
	return nil
}

func (service *Service) fail(lease *jobs.Lease, code string, checkpoint RuntimeCheckpoint) error {
	checkpoint.FailureCode = code
	checkpoint.FailureObservedAt = time.Now().UnixMilli()
	if len(checkpoint.Projection) > 0 {
		projectionContext, cancel := context.WithTimeout(context.Background(), service.runtimeCallTimeout)
		err := service.project(projectionContext, lease, jobs.StateFailed, checkpoint)
		cancel()
		if err != nil {
			return err
		}
	}
	receipt := terminalReceipt{
		Kind: "bridge-refused", Runtime: checkpoint.Identity, Receipt: checkpoint.Receipt,
		Run: checkpoint.Run, Cursor: checkpoint.Cursor, ErrorCode: code, ErrorClass: checkpoint.FailureClass, ErrorStep: checkpoint.FailureStep, Projection: checkpoint.Projection,
	}
	settleContext, cancel := context.WithTimeout(context.Background(), service.runtimeCallTimeout)
	defer cancel()
	return lease.Fail(settleContext, mustJSON(receipt))
}

func (service *Service) runtimeError(lease *jobs.Lease, err error, checkpoint RuntimeCheckpoint) error {
	code, retryable := preRunRuntimeFailure(err, checkpoint.RunID)
	checkpoint.FailureClass = runtimeFailureClass(err)
	if retryable {
		// Persist a product observation even when resolution failed before a
		// run exists. Never submit another operation from reconnect or polling.
		checkpoint.FailureCode = code
		checkpoint.FailureObservedAt = time.Now().UnixMilli()
		if len(checkpoint.Projection) > 0 {
			ctx, cancel := context.WithTimeout(context.Background(), service.runtimeCallTimeout)
			projectionErr := service.project(ctx, lease, jobs.StateWaiting, checkpoint)
			cancel()
			if projectionErr != nil {
				return projectionErr
			}
		}
		return safeFailure{code: code, retryable: true}
	}
	return service.fail(lease, code, checkpoint)
}

// A bare worker 404 or lost lease cannot prove loss of a pinned workspace.
// Other HTTP refusals retain their declared verdict (including auth/input).
func preRunRuntimeFailure(err error, runID string) (string, bool) {
	code, retryable := runtimeFailure(err)
	var httpFailure interface{ FlowRuntimeHTTPStatus() int }
	if runID == "" && (code == "host_lease_lost" ||
		((code == "http_refused" || code == "health_refused") && errors.As(err, &httpFailure) && httpFailure.FlowRuntimeHTTPStatus() == 404)) {
		retryable = true
	}
	return code, retryable
}

func runtimeFailure(err error) (string, bool) {
	var bridgeFailure flowruntime.FlowRuntimeFailure
	if errors.As(err, &bridgeFailure) {
		code := strings.TrimSpace(bridgeFailure.FlowRuntimeCode())
		if code == "" {
			code = "runtime_refused"
		}
		return code, bridgeFailure.FlowRuntimeRetryable()
	}
	var local safeFailure
	if errors.As(err, &local) {
		return local.code, local.retryable
	}
	return "runtime_unavailable", true
}

func runtimeCode(err error) string {
	code, _ := runtimeFailure(err)
	return code
}

func terminalStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func validLaunchResult(result flowruntime.FlowRuntimeLaunchResult, identity flowruntime.FlowRuntimeIdentity, operationID string) bool {
	return result.ApplicationRequestID == operationID && result.OwnerGeneration == identity.OwnerGeneration &&
		result.RuntimeArtifactDigest == identity.RuntimeArtifactDigest && result.SourceRevision == identity.SourceRevision
}

func validMutationResult(result flowruntime.FlowRuntimeMutationResult, operation, requestID string) bool {
	if result.Operation != operation || result.ApplicationRequestID != requestID {
		return false
	}
	switch result.Receipt.Tag {
	case "Accepted", "AlreadyApplied", "Terminal":
		return true
	default:
		return false
	}
}

// Generic Control receipts may omit runId. When a receipt supplies it, a
// mutation of another run cannot count as delivery to the requested run.
func validRunMutationResult(result flowruntime.MutationResult, operation, requestID, runID string) bool {
	return validMutationResult(result, operation, requestID) &&
		(result.Receipt.RunID == "" || result.Receipt.RunID == runID)
}

func validObservationPage(previous string, observation flowruntime.FlowRuntimeObservation) bool {
	before, ok := parseObservationCursor(previous)
	if !ok {
		return false
	}
	next, ok := parseObservationCursor(observation.NextCursor)
	if !ok || compareObservationCursor(next, before) < 0 || (observation.HasMore && compareObservationCursor(next, before) == 0) {
		return false
	}
	last := before
	for _, event := range observation.Events {
		cursor := flowruntime.EventCursor{Sequence: event.Sequence}
		if event.Cursor != nil {
			cursor = *event.Cursor
		}
		if !validJournalInteger(cursor.Sequence) || (cursor.Offset != nil && !validJournalInteger(*cursor.Offset)) ||
			compareObservationCursor(cursor, last) <= 0 {
			return false
		}
		last = cursor
	}
	// Never commit progress beyond the events actually returned, particularly
	// a complete sequence marker when its last observed member was partial.
	return compareObservationCursor(last, next) == 0
}

func parseObservationCursor(value string) (flowruntime.EventCursor, bool) {
	// The empty seed precedes sequence zero; legacy decimals consume the whole
	// source entry. v1 preserves Control's offset within an expanded entry.
	if value == "" {
		return flowruntime.EventCursor{Sequence: -1}, true
	}
	parts := strings.Split(value, ":")
	if len(parts) == 3 && parts[0] == "v1" {
		sequence, sequenceOK := parseJournalInteger(parts[1])
		offset, offsetOK := parseJournalInteger(parts[2])
		return flowruntime.EventCursor{Sequence: sequence, Offset: &offset}, sequenceOK && offsetOK
	}
	sequence, ok := parseJournalInteger(value)
	return flowruntime.EventCursor{Sequence: sequence}, ok
}

func parseJournalInteger(value string) (int64, bool) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return 0, false
		}
	}
	number, err := strconv.ParseInt(value, 10, 64)
	return number, err == nil && validJournalInteger(number)
}

func validJournalInteger(value int64) bool {
	// Match the canonical Control WatchCursor's exclusive safe-integer bound.
	return value >= 0 && value < 9007199254740991
}

func compareObservationCursor(left, right flowruntime.EventCursor) int {
	switch {
	case left.Sequence < right.Sequence:
		return -1
	case left.Sequence > right.Sequence:
		return 1
	case left.Offset == nil && right.Offset == nil:
		return 0
	case left.Offset == nil:
		return 1
	case right.Offset == nil:
		return -1
	case *left.Offset < *right.Offset:
		return -1
	case *left.Offset > *right.Offset:
		return 1
	default:
		return 0
	}
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("flow dispatch: encode internal receipt: %v", err))
	}
	return encoded
}

// Classes are optional on older runtime failures. Only product-envelope classes
// are persisted; an unrecognized adapter value never becomes product UI copy.
func runtimeFailureClass(err error) string {
	var classified interface{ FlowRuntimeClass() string }
	if !errors.As(err, &classified) {
		return ""
	}
	switch class := classified.FlowRuntimeClass(); class {
	case "user", "permission", "capacity", "github", "infra", "conflict":
		return class
	default:
		return ""
	}
}
