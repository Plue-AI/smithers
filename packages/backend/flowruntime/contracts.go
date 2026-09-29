// Package flowruntime defines the deployment-neutral contract to the one
// canonical TypeScript Flow/Control host. It intentionally has no dependency
// on backend services or composition.
package flowruntime

import (
	"context"
	"encoding/json"
)

const Protocol = "smithers.flow-runtime/v1"

type Identity struct {
	Protocol              string `json:"protocol"`
	RuntimeArtifactDigest string `json:"runtimeArtifactDigest"`
	SourceRevision        string `json:"sourceRevision"`
	OwnerGeneration       int64  `json:"ownerGeneration"`
}

type Target struct {
	TenantID    string
	PrincipalID string
	WorkspaceID string
	BindingKind string
	BindingID   string
}

type Resolver interface {
	ResolveFlowRuntime(context.Context, Target) (Runtime, error)
}

// ExistingResolver inspects an already bound host. Reads must not create a
// workspace, capture source, create/rebind an owner, or launch a process.
type ExistingResolver interface {
	ResolveExistingFlowRuntime(context.Context, Target) (Runtime, error)
}

type ResolverFunc func(context.Context, Target) (Runtime, error)

func (resolve ResolverFunc) ResolveFlowRuntime(ctx context.Context, target Target) (Runtime, error) {
	return resolve(ctx, target)
}

type Failure interface {
	error
	FlowRuntimeCode() string
	FlowRuntimeRetryable() bool
}

type Launch struct {
	ApplicationRequestID  string
	Attempt               int64
	OwnerGeneration       int64
	RuntimeArtifactDigest string
	SourceRevision        string
	FlowID                string
	Payload               json.RawMessage
}

type Receipt struct {
	Tag       string `json:"_tag"`
	ReceiptID string `json:"receiptId,omitempty"`
	RunID     string `json:"runId,omitempty"`
	PlanID    string `json:"planId,omitempty"`
	Status    string `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
}

type LaunchResult struct {
	ApplicationRequestID  string
	OwnerGeneration       int64
	RuntimeArtifactDigest string
	SourceRevision        string
	PlanID                string
	PlanDigest            string
	ExecutionDigest       string
	Envelope              json.RawMessage
	Approval              json.RawMessage
	Receipt               Receipt
}

type Decision struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	Approval             json.RawMessage
}

type Signal struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	RunID                string
	Name                 string
	Payload              json.RawMessage
}

type Steer struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	RunID                string
	MessageID            string
	CreatedAt            float64
	Kind                 string
	Body                 string
	Seat                 string
	Thinking             string
	ToolNames            []string
}

type Lifecycle struct {
	ApplicationRequestID string
	OwnerGeneration      int64
	RunID                string
	Reason               string
}

type MutationResult struct {
	Operation            string
	ApplicationRequestID string
	Receipt              Receipt
}

type EventCursor struct {
	Sequence int64  `json:"sequence"`
	Offset   *int64 `json:"offset,omitempty"`
}

type Event struct {
	Cursor     *EventCursor    `json:"cursor,omitempty"`
	Sequence   int64           `json:"sequence"`
	Kind       string          `json:"kind"`
	RunID      string          `json:"runId,omitempty"`
	OccurredAt float64         `json:"occurredAt"`
	Payload    json.RawMessage `json:"payload"`
}

type Run struct {
	RunID                string `json:"runId"`
	FlowID               string `json:"flowId"`
	Status               string `json:"status"`
	PlanID               string `json:"planId,omitempty"`
	PlanDigest           string `json:"planDigest,omitempty"`
	OwnerID              string `json:"ownerId,omitempty"`
	WaitingReason        string `json:"waitingReason,omitempty"`
	ExecutionObservation string `json:"executionObservation,omitempty"`
	// FinalOutput is the canonical committed root projection, when observed.
	// Absence on a terminal run must never be interpreted as a successful result.
	FinalOutput *string `json:"finalOutput,omitempty"`
	// FailureFault is whose fault a failed run was, in the failure
	// registry's classes (user, wait, infra, dependency, bug, factory,
	// policy), and FailureTag its typed error as <_tag>/<code>. Both are
	// empty unless the run failed with a registered error.
	FailureFault string `json:"failureFault,omitempty"`
	FailureTag   string `json:"failureTag,omitempty"`
}

type Observation struct {
	Run        Run
	Events     []Event
	NextCursor string
	HasMore    bool
	Terminal   bool
}

type Runtime interface {
	Identity(context.Context) (Identity, error)
	Launch(context.Context, Launch) (LaunchResult, error)
	Approve(context.Context, Decision) (MutationResult, error)
	Deny(context.Context, Decision) (MutationResult, error)
	Signal(context.Context, Signal) (MutationResult, error)
	Steer(context.Context, Steer) (MutationResult, error)
	Cancel(context.Context, Lifecycle) (MutationResult, error)
	Resume(context.Context, Lifecycle) (MutationResult, error)
	Observe(context.Context, string, string, int) (Observation, error)
}

// Explicit aliases keep the protocol vocabulary recognizable at call sites
// while allowing concise names inside this dependency-free package.
const FlowRuntimeProtocol = Protocol

type FlowRuntimeIdentity = Identity
type FlowRuntimeTarget = Target
type FlowRuntimeResolver = Resolver
type FlowRuntimeResolverFunc = ResolverFunc
type FlowRuntimeFailure = Failure
type FlowRuntimeLaunch = Launch
type FlowRuntimeReceipt = Receipt
type FlowRuntimeLaunchResult = LaunchResult
type FlowRuntimeDecision = Decision
type FlowRuntimeSignal = Signal
type FlowRuntimeSteer = Steer
type FlowRuntimeLifecycle = Lifecycle
type FlowRuntimeMutationResult = MutationResult
type FlowRuntimeEventCursor = EventCursor
type FlowRuntimeEvent = Event
type FlowRuntimeRun = Run
type FlowRuntimeObservation = Observation
type FlowRuntime = Runtime
