package flowdispatch

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type Service struct {
	store               *jobs.Store
	resolver            flowruntime.FlowRuntimeResolver
	projector           Projector
	steerAuthorizer     SteerAuthorizer
	observationDelay    time.Duration
	maxObservationDelay time.Duration
	observationLimit    int
	observationPages    int
	runtimeCallTimeout  time.Duration

	// hostStarts are background starts of box hosts (StartHost).
	hostStarts background.Jobs[flowruntime.Target]
	// relayPlans are the plans the browser relay saved, by caller and box.
	relayPlans RelayPlans
}

func New(config Config) (*Service, error) {
	if config.Store == nil {
		return nil, errors.New("flow dispatch: jobs store is required")
	}
	if config.Resolver == nil {
		return nil, errors.New("flow dispatch: runtime resolver is required")
	}
	if config.ObservationDelay <= 0 {
		config.ObservationDelay = time.Second
	}
	if config.MaxObservationDelay <= 0 {
		config.MaxObservationDelay = 30 * time.Second
	}
	if config.MaxObservationDelay < config.ObservationDelay {
		config.MaxObservationDelay = config.ObservationDelay
	}
	if config.ObservationLimit <= 0 || config.ObservationLimit > 1000 {
		config.ObservationLimit = 250
	}
	if config.ObservationPages <= 0 {
		config.ObservationPages = 4
	}
	if config.RuntimeCallTimeout <= 0 {
		config.RuntimeCallTimeout = 30 * time.Second
	}
	return &Service{
		store: config.Store, resolver: config.Resolver, projector: config.Projector,
		steerAuthorizer:  config.SteerAuthorizer,
		observationDelay: config.ObservationDelay, maxObservationDelay: config.MaxObservationDelay,
		observationLimit: config.ObservationLimit,
		observationPages: config.ObservationPages, runtimeCallTimeout: config.RuntimeCallTimeout,
		hostStarts: background.Jobs[flowruntime.Target]{Timeout: 5 * time.Minute, FailureTTL: time.Minute},
		relayPlans: config.RelayPlans,
	}, nil
}

// Admit commits a product launch and returns without resolving or contacting a
// runtime host.
func (service *Service) Admit(ctx context.Context, request LaunchRequest) (jobs.RequestReceipt, error) {
	admission, err := launchAdmission(request)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return service.store.Admit(ctx, admission)
}

// AdmitInTx commits the Flow request in the same product transaction as the
// domain row that points at it. No runtime resolution or network I/O occurs in
// that transaction.
func (service *Service) AdmitInTx(ctx context.Context, tx pgx.Tx, request LaunchRequest) (jobs.RequestReceipt, error) {
	if tx == nil {
		return jobs.RequestReceipt{}, errors.New("flow dispatch: transaction is required")
	}
	admission, err := launchAdmission(request)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return service.store.AdmitInTx(ctx, tx, admission)
}

// Signal commits a runtime mutation and returns before resolving or contacting
// the host. Runtime delivery, retry, and lost-ack reconciliation are owned by
// the same jobs worker as launches and approvals.
func (service *Service) Signal(ctx context.Context, request SignalRequest) (jobs.RequestReceipt, error) {
	admission, err := signalAdmission(request)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return service.store.Admit(ctx, admission)
}

// SignalInTx joins a signal intent to its domain transaction. The existing
// durable worker dispatches only committed intents and reconciles lost acks.
func (service *Service) SignalInTx(ctx context.Context, tx pgx.Tx, request SignalRequest) (jobs.RequestReceipt, error) {
	if tx == nil {
		return jobs.RequestReceipt{}, errors.New("flow dispatch: transaction is required")
	}
	admission, err := signalAdmission(request)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return service.store.AdmitInTx(ctx, tx, admission)
}

func signalAdmission(request SignalRequest) (jobs.Admission, error) {
	if strings.TrimSpace(request.RequestID) == "" || strings.TrimSpace(request.FlowID) == "" ||
		strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.Name) == "" {
		return jobs.Admission{}, errors.New("flow dispatch: signal request, flow, run, and name are required")
	}
	request.Target = scopedTarget(request.Scope, request.Target)
	if err := validateTarget(request.Scope, request.Target); err != nil {
		return jobs.Admission{}, err
	}
	if len(request.Projection) == 0 {
		request.Projection = json.RawMessage(`{}`)
	}
	payload, err := json.Marshal(signalPayload{
		Target: request.Target, FlowID: request.FlowID, RunID: request.RunID,
		Name: request.Name, Payload: request.Payload, Projection: request.Projection,
	})
	if err != nil {
		return jobs.Admission{}, fmt.Errorf("flow dispatch: encode signal: %w", err)
	}
	return jobs.Admission{
		Scope: request.Scope, Operation: OperationSignal, RequestID: request.RequestID,
		Payload: payload, AuthorizationContext: request.AuthorizationContext,
		EffectPolicy: jobs.EffectReconcile,
		EffectKey:    "flow-runtime-signal:" + request.RequestID,
	}, nil
}

// Steer admits feedback without contacting the runtime. A named Signal settles
// a wait; Steer instead queues a Message and leaves open questions untouched.
func (service *Service) Steer(ctx context.Context, request SteerRequest) (jobs.RequestReceipt, error) {
	admission, err := steerAdmission(request)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return service.store.Admit(ctx, admission)
}

// SteerInTx commits feedback intent atomically with its product revision/event.
func (service *Service) SteerInTx(ctx context.Context, tx pgx.Tx, request SteerRequest) (jobs.RequestReceipt, error) {
	if tx == nil {
		return jobs.RequestReceipt{}, errors.New("flow dispatch: transaction is required")
	}
	admission, err := steerAdmission(request)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	return service.store.AdmitInTx(ctx, tx, admission)
}

func validSteerInput(messageID string, createdAt float64, body string) bool {
	return strings.TrimSpace(messageID) != "" && strings.TrimSpace(body) != "" &&
		createdAt >= 0 && !math.IsNaN(createdAt) && !math.IsInf(createdAt, 0)
}

func steerAdmission(request SteerRequest) (jobs.Admission, error) {
	if strings.TrimSpace(request.RequestID) == "" || strings.TrimSpace(request.FlowID) == "" ||
		strings.TrimSpace(request.RunID) == "" || !validSteerInput(request.MessageID, request.CreatedAt, request.Body) {
		return jobs.Admission{}, errors.New("flow dispatch: steer requires request, flow, run, message, body, and a finite nonnegative timestamp")
	}
	request.Target = scopedTarget(request.Scope, request.Target)
	if err := validateTarget(request.Scope, request.Target); err != nil {
		return jobs.Admission{}, err
	}
	if len(request.Projection) == 0 {
		request.Projection = json.RawMessage(`{}`)
	}
	payload, err := json.Marshal(steerPayload{
		runMutationPayload: runMutationPayload{Target: request.Target, FlowID: request.FlowID, RunID: request.RunID, Projection: request.Projection},
		MessageID:          request.MessageID, CreatedAt: request.CreatedAt, Body: request.Body,
		Attribution: request.Attribution,
	})
	if err != nil {
		return jobs.Admission{}, fmt.Errorf("flow dispatch: encode steer: %w", err)
	}
	return jobs.Admission{
		Scope: request.Scope, Operation: OperationSteer, RequestID: request.RequestID,
		Payload: payload, AuthorizationContext: request.AuthorizationContext,
		EffectPolicy: jobs.EffectReconcile, EffectKey: "flow-runtime-steer:" + request.RequestID,
	}, nil
}

func launchAdmission(request LaunchRequest) (jobs.Admission, error) {
	if strings.TrimSpace(request.RequestID) == "" || strings.TrimSpace(request.FlowID) == "" {
		return jobs.Admission{}, errors.New("flow dispatch: request ID and flow ID are required")
	}
	request.Target = scopedTarget(request.Scope, request.Target)
	if err := validateTarget(request.Scope, request.Target); err != nil {
		return jobs.Admission{}, err
	}
	if request.ApprovalPolicy == "" {
		request.ApprovalPolicy = ApprovalManual
	}
	if request.ApprovalPolicy != ApprovalManual && request.ApprovalPolicy != ApprovalAuto {
		return jobs.Admission{}, errors.New("flow dispatch: invalid approval policy")
	}
	if request.Pin != nil && !request.Pin.Valid() {
		return jobs.Admission{}, errors.New("flow dispatch: the launch pin is incomplete")
	}
	if !todoLaunchAllowed(request.FlowID, request.Target, request.Pin) {
		return jobs.Admission{}, ErrTodoOutsideStack
	}
	if len(request.Projection) == 0 {
		request.Projection = json.RawMessage(`{}`)
	}
	payload, err := json.Marshal(launchPayload{
		Target: request.Target, FlowID: request.FlowID, Payload: request.Payload,
		Projection: request.Projection, ApprovalPolicy: request.ApprovalPolicy, Pin: request.Pin,
	})
	if err != nil {
		return jobs.Admission{}, fmt.Errorf("flow dispatch: encode launch: %w", err)
	}
	return jobs.Admission{
		Scope: request.Scope, Operation: OperationLaunch, RequestID: request.RequestID,
		Payload: payload, AuthorizationContext: request.AuthorizationContext,
		EffectPolicy: jobs.EffectReconcile,
		EffectKey:    "flow-runtime:" + request.RequestID,
	}, nil
}

// Approve durably admits an operator decision against the opaque approval
// payload issued by Control. It never invents or translates an approval.
func (service *Service) Approve(
	ctx context.Context,
	scope jobs.Scope,
	launchOperationID string,
	requestID string,
	authorization json.RawMessage,
) (jobs.RequestReceipt, error) {
	operation, err := service.store.Get(ctx, scope, launchOperationID)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	if operation.Operation != OperationLaunch {
		return jobs.RequestReceipt{}, ErrNotLaunchOperation
	}
	if operation.State.Terminal() || operation.CancellationRequested {
		return jobs.RequestReceipt{}, ErrApprovalUnavailable
	}
	checkpoint, err := decodeCheckpoint(operation.ExternalReceipt)
	if err != nil || len(checkpoint.Approval) == 0 || checkpoint.PlanID == "" {
		return jobs.RequestReceipt{}, ErrApprovalUnavailable
	}
	return service.admitApproval(ctx, scope, launchOperationID, requestID, authorization, checkpoint)
}

func (service *Service) admitApproval(
	ctx context.Context,
	scope jobs.Scope,
	launchOperationID string,
	requestID string,
	authorization json.RawMessage,
	checkpoint RuntimeCheckpoint,
) (jobs.RequestReceipt, error) {
	payload, err := json.Marshal(approvalPayload{
		LaunchOperationID: launchOperationID, Target: checkpoint.Target,
		Identity: checkpoint.Identity, Approval: checkpoint.Approval,
	})
	if err != nil {
		return jobs.RequestReceipt{}, fmt.Errorf("flow dispatch: encode approval: %w", err)
	}
	return service.store.Admit(ctx, jobs.Admission{
		Scope: scope, Operation: OperationApprove, RequestID: requestID,
		Payload: payload, AuthorizationContext: authorization,
		EffectPolicy: jobs.EffectReconcile,
		EffectKey:    "flow-runtime-approval:" + launchOperationID + ":" + requestID,
	})
}

// Cancel persists product intent first. A deferred runtime launch remains
// claimable until its worker has delivered cancellation and observed Control's
// terminal truth.
func (service *Service) Cancel(ctx context.Context, scope jobs.Scope, operationID string) (jobs.Operation, error) {
	operation, err := service.store.Get(ctx, scope, operationID)
	if err != nil {
		return jobs.Operation{}, err
	}
	if operation.Operation != OperationLaunch {
		return jobs.Operation{}, ErrNotLaunchOperation
	}
	return service.store.RequestCancellationForWorker(ctx, scope, operationID)
}

// CancelRequest reconnects to a launch through its public durable request id.
func (service *Service) CancelRequest(ctx context.Context, scope jobs.Scope, requestID string) (jobs.Operation, error) {
	operation, err := service.store.GetByRequest(ctx, scope, OperationLaunch, requestID)
	if err != nil {
		return jobs.Operation{}, err
	}
	return service.Cancel(ctx, scope, operation.ID)
}

// CancelRequestInTx records a launch's cancellation in the caller's product
// transaction, so a product cancel and the Flow cancel commit together. The
// caller commits; the worker then delivers it to the runtime.
func (service *Service) CancelRequestInTx(ctx context.Context, tx pgx.Tx, scope jobs.Scope, requestID string) (jobs.Operation, error) {
	if tx == nil {
		return jobs.Operation{}, errors.New("flow dispatch: transaction is required")
	}
	operation, err := service.store.GetByRequestInTx(ctx, tx, scope, OperationLaunch, requestID)
	if err != nil {
		return jobs.Operation{}, err
	}
	return service.store.RequestCancellationForWorkerInTx(ctx, tx, scope, operation.ID)
}

func (service *Service) Get(ctx context.Context, scope jobs.Scope, operationID string) (jobs.Operation, error) {
	return service.store.Get(ctx, scope, operationID)
}

// CallRPC resolves the same fenced Flow host as durable dispatch, then relays
// a browser catalog, plan, run, or projection call to its canonical RPC.
func (service *Service) CallRPC(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	call, err := service.classifyRelay(ctx, target, procedure, payload)
	if err != nil {
		return nil, err
	}
	var runtime flowruntime.Runtime
	if procedure == "List" || procedure == "Projection.Snapshot" {
		reader, ok := service.resolver.(flowruntime.ExistingResolver)
		if !ok {
			return nil, errors.New("flow dispatch: runtime has no read-only resolver")
		}
		runtime, err = reader.ResolveExistingFlowRuntime(ctx, target)
	} else {
		runtime, err = service.resolver.ResolveFlowRuntime(ctx, target)
	}
	if err != nil {
		return nil, err
	}
	caller, ok := runtime.(interface {
		CallRPC(context.Context, string, json.RawMessage) (json.RawMessage, error)
	})
	if !ok {
		return nil, errors.New("flow dispatch: runtime has no gateway RPC")
	}
	if err := service.refuseTodoRun(ctx, runtime, call); err != nil {
		return nil, err
	}
	answer, err := caller.CallRPC(ctx, procedure, payload)
	if err == nil && procedure == "Plan" {
		err = service.savePlan(ctx, target, answer)
	}
	return answer, err
}

// StartHost answers whether the target's host is live. When it is not, it
// starts the host in the background, once per target at a time, and answers
// false at once: starting a box's host takes longer than a request should
// wait (#2198). A start that failed is answered once to the next caller,
// which may ask again. Reads (List, Projection.Snapshot) never start a host;
// this is the one call that does without planning or running anything.
//
// A host whose catalog identity changed (runtime_upgrade_required) is
// started too, which rebinds it. The resolver answers that only once no run
// depends on the old host; until then a read reaches the old host.
func (service *Service) StartHost(ctx context.Context, target flowruntime.Target) (bool, error) {
	if err := service.hostStarts.Failed(target); err != nil {
		return false, err
	}
	if service.hostStarts.Running(target) {
		return false, nil
	}
	reader, ok := service.resolver.(flowruntime.ExistingResolver)
	if !ok {
		return false, errors.New("flow dispatch: runtime has no read-only resolver")
	}
	_, err := reader.ResolveExistingFlowRuntime(ctx, target)
	if err == nil {
		return true, nil
	}
	var failure flowruntime.Failure
	if !errors.As(err, &failure) {
		return false, err
	}
	switch failure.FlowRuntimeCode() {
	case "runtime_host_starting", "runtime_upgrade_pending":
		// Another caller (a worker, another API replica) is starting it, or
		// its upgrade waits for the runs on the old host.
		return false, nil
	case "runtime_host_not_running", "runtime_upgrade_required":
	default:
		return false, err
	}
	service.hostStarts.Start(ctx, target, func(ctx context.Context) error {
		_, err := service.resolver.ResolveFlowRuntime(ctx, target)
		return err
	})
	return false, nil
}

// RunWorker consumes only Flow bridge operations from the shared jobs table.
func (service *Service) RunWorker(ctx context.Context, config jobs.WorkerConfig) error {
	config.Operations = []string{OperationLaunch, OperationApprove, OperationSignal, OperationSteer}
	return service.store.RunWorker(ctx, config, service.Handle)
}

func scopedTarget(scope jobs.Scope, target flowruntime.FlowRuntimeTarget) flowruntime.FlowRuntimeTarget {
	if target.TenantID == "" {
		target.TenantID = scope.TenantID
	}
	if target.PrincipalID == "" {
		target.PrincipalID = scope.PrincipalID
	}
	return target
}

func validateTarget(scope jobs.Scope, target flowruntime.FlowRuntimeTarget) error {
	if target.TenantID != scope.TenantID || target.PrincipalID != scope.PrincipalID {
		return errors.New("flow dispatch: runtime target is outside the admitted scope")
	}
	if strings.TrimSpace(target.BindingKind) == "" || strings.TrimSpace(target.BindingID) == "" {
		return errors.New("flow dispatch: runtime target binding is required")
	}
	return nil
}

func validIdentity(identity flowruntime.FlowRuntimeIdentity) bool {
	return identity.Protocol == flowruntime.FlowRuntimeProtocol && identity.OwnerGeneration > 0 &&
		lowerHex(identity.RuntimeArtifactDigest, 64) && lowerHex(identity.SourceRevision, 40)
}

func lowerHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func decodeCheckpoint(value json.RawMessage) (RuntimeCheckpoint, error) {
	if len(value) == 0 {
		return RuntimeCheckpoint{}, nil
	}
	var checkpoint RuntimeCheckpoint
	if err := json.Unmarshal(value, &checkpoint); err != nil {
		return RuntimeCheckpoint{}, errors.New("flow dispatch: invalid durable runtime checkpoint")
	}
	if checkpoint.Version != 1 {
		return RuntimeCheckpoint{}, errors.New("flow dispatch: unsupported durable runtime checkpoint")
	}
	return checkpoint, nil
}

// HasPinnedLaunches reports whether an unsettled launch in scope pinned a
// host with this artifact and source: an accepted run or an approval-parked
// plan. A host upgrade waits for it (plue#538). The check spans the scope's
// workspaces, so a sibling workspace pinned to the same host identity can
// delay an upgrade; it never lets one stop a run.
func HasPinnedLaunches(ctx context.Context, store *jobs.Store, scope jobs.Scope, host flowruntime.Identity) (bool, error) {
	if store == nil {
		return false, errors.New("flow dispatch: jobs store is required")
	}
	if !lowerHex(host.RuntimeArtifactDigest, 64) || !lowerHex(host.SourceRevision, 40) {
		return false, errors.New("flow dispatch: host identity is invalid")
	}
	fragment := mustJSON(map[string]any{"identity": map[string]string{
		"runtimeArtifactDigest": host.RuntimeArtifactDigest, "sourceRevision": host.SourceRevision,
	}})
	return store.HasActiveWithReceipt(ctx, scope, OperationLaunch, fragment)
}
