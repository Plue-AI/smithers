// Package flowdispatch durably maps product requests onto the canonical
// TypeScript Flow runtime. It owns admission and receipt projection only; the
// runtime host remains the sole graph, journal, approval, and execution owner.
package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const (
	OperationLaunch  = "flow.runtime.launch"
	OperationApprove = "flow.runtime.approve"
	OperationSignal  = "flow.runtime.signal"
	OperationSteer   = "flow.runtime.steer"
)

var (
	ErrApprovalUnavailable = errors.New("flow dispatch: approval is not available")
	ErrNotLaunchOperation  = errors.New("flow dispatch: operation is not a Flow launch")
	// ErrTodoOutsideStack refuses the todo composition on any route other
	// than the stack's pinned launch of an owner's TODO attempt.
	ErrTodoOutsideStack = errors.New("flow dispatch: the todo flow runs only from stack admission of a filed TODO")
	// ErrRelayPayload refuses a relayed call whose payload the relay cannot
	// classify exactly: not one object, a duplicate key, or a missing or
	// mistyped field the call needs.
	ErrRelayPayload = errors.New("flow dispatch: the relayed payload is not one exact object")
	// ErrRelayPlanUnknown refuses a relayed run of a plan this relay did not
	// save for the same caller and box.
	ErrRelayPlanUnknown = errors.New("flow dispatch: the relay saved no such plan for this box; plan again")
)

// TodoFlow is the todo composition (flows/todo/flow.ts). StackBindingKind is
// the binding kind of the stack's item launches: the only launches that may
// run it, and only with the attempt's pin.
const (
	TodoFlow         = "todo"
	StackBindingKind = "mythical-item"
)

// pinMismatch is the failure of a launch whose host planned, or ran, other
// code than its pin.
const pinMismatch = "pin_mismatch"

// IsTodoFlow reports whether flowID names the todo composition, by name or by
// its flows/todo/flow.ts path.
func IsTodoFlow(flowID string) bool {
	name := path.Clean(strings.TrimSpace(flowID))
	if inner, ok := strings.CutPrefix(name, "flows/"); ok {
		name = strings.TrimSuffix(inner, "/flow.ts")
	}
	return name == TodoFlow
}

// todoLaunchAllowed is the one route to the todo composition: a stack item
// launch carrying a complete pin of the todo flow.
func todoLaunchAllowed(flowID string, target flowruntime.FlowRuntimeTarget, pin *flowruntime.Pin) bool {
	if !IsTodoFlow(flowID) {
		return true
	}
	return target.BindingKind == StackBindingKind && pin != nil && pin.Valid() && pin.Flow == TodoFlow && flowID == TodoFlow
}

type ApprovalPolicy string

const (
	ApprovalManual ApprovalPolicy = "manual"
	ApprovalAuto   ApprovalPolicy = "approve"
)

// LaunchRequest is product admission data. Payload is the canonical Flow
// input; Projection is opaque product correlation metadata and never runtime
// graph state.
type LaunchRequest struct {
	Scope                jobs.Scope
	RequestID            string
	Target               flowruntime.FlowRuntimeTarget
	FlowID               string
	Payload              json.RawMessage
	AuthorizationContext json.RawMessage
	Projection           json.RawMessage
	ApprovalPolicy       ApprovalPolicy
	// Pin, when set, is the attempt's pinned version: the host must run
	// exactly it, and a run of anything else is cancelled and never counts.
	Pin *flowruntime.Pin
}

// SignalRequest durably delivers one named signal to a run owned by the same
// authorized target as its launch. The request id is the product idempotency
// key; callers never address a runtime endpoint or supply an owner generation.
type SignalRequest struct {
	Scope                jobs.Scope
	RequestID            string
	Target               flowruntime.FlowRuntimeTarget
	FlowID               string
	RunID                string
	Name                 string
	Payload              json.RawMessage
	AuthorizationContext json.RawMessage
	Projection           json.RawMessage
}

// SteerRequest delivers model feedback through Control's notification queue.
// MessageID and CreatedAt are fixed at product admission and survive retries.
// The caller authorizes the input; dispatch resolves the fenced runtime owner.
type SteerRequest struct {
	Scope                jobs.Scope
	RequestID            string
	Target               flowruntime.FlowRuntimeTarget
	FlowID               string
	RunID                string
	MessageID            string
	CreatedAt            float64
	Body                 string
	Attribution          map[string]string
	AuthorizationContext json.RawMessage
	Projection           json.RawMessage
}

// SteerAuthorizer rechecks the committed input's current authority before a
// worker wakes its host and again immediately before runtime delivery.
// Admission authorization alone cannot authorize an input held across removal
// of its author from the repository. TODO delivery requires this provider.
// A product implementation may also commit a held input's one-time release;
// it must keep that transition atomic and must not claim runtime consumption.
type SteerAuthorizer interface {
	AuthorizeFlowSteer(context.Context, SteerRequest) error
}

type RuntimeCheckpoint struct {
	Version             int                             `json:"version"`
	Target              flowruntime.FlowRuntimeTarget   `json:"target"`
	FlowID              string                          `json:"flowId"`
	Projection          json.RawMessage                 `json:"projection"`
	Identity            flowruntime.FlowRuntimeIdentity `json:"identity"`
	PlanID              string                          `json:"planId,omitempty"`
	PlanDigest          string                          `json:"planDigest,omitempty"`
	ExecutionDigest     string                          `json:"executionDigest,omitempty"`
	Envelope            json.RawMessage                 `json:"envelope,omitempty"`
	Approval            json.RawMessage                 `json:"approval,omitempty"`
	ApprovalOperationID string                          `json:"approvalOperationId,omitempty"`
	Receipt             *flowruntime.FlowRuntimeReceipt `json:"receipt,omitempty"`
	MutationReceipt     *flowruntime.FlowRuntimeReceipt `json:"mutationReceipt,omitempty"`
	RunID               string                          `json:"runId,omitempty"`
	Cursor              string                          `json:"cursor,omitempty"`
	Run                 *flowruntime.FlowRuntimeRun     `json:"run,omitempty"`
	FailureClass        string                          `json:"failureClass,omitempty"`
	FailureCode         string                          `json:"failureCode,omitempty"`
	FailureObservedAt   int64                           `json:"failureObservedAt,omitempty"`
	FailureStep         string                          `json:"failureStep,omitempty"`
	WakeStartedAt       int64                           `json:"wakeStartedAt,omitempty"`
	// IdlePolls counts consecutive polls without progress. It stops growing
	// once the backoff reaches its limit, so idle polls stop changing the
	// checkpoint.
	IdlePolls int `json:"idlePolls,omitempty"`
}

// ProjectionUpdate is an idempotent projection callback. RuntimeCheckpoint is
// evidence from Control, not an alternate run-state authority.
//
// Events is one observed journal page, read after EventsAfter; Checkpoint's
// Cursor is the cursor after it. A page is projected before its cursor is
// saved, so a projector that records the cursor it logged through can refuse
// a page it already logged when a retry observes it again.
type ProjectionUpdate struct {
	OperationID string
	Scope       jobs.Scope
	State       jobs.State
	Checkpoint  RuntimeCheckpoint
	Events      []flowruntime.FlowRuntimeEvent
	EventsAfter string
}

type Projector interface {
	ProjectFlowRuntime(context.Context, ProjectionUpdate) error
}

type ProjectorFunc func(context.Context, ProjectionUpdate) error

func (project ProjectorFunc) ProjectFlowRuntime(ctx context.Context, update ProjectionUpdate) error {
	return project(ctx, update)
}

type Config struct {
	Store           *jobs.Store
	Resolver        flowruntime.FlowRuntimeResolver
	Projector       Projector
	SteerAuthorizer SteerAuthorizer
	// ObservationDelay is the first wait before re-polling a parked or running
	// launch. Each poll that finds no progress doubles it, up to
	// MaxObservationDelay.
	ObservationDelay    time.Duration
	MaxObservationDelay time.Duration
	ObservationLimit    int
	ObservationPages    int
	RuntimeCallTimeout  time.Duration
	// RelayPlans keeps the browser relay's plans; without it the relay runs
	// and approves no plan.
	RelayPlans RelayPlans
}

type launchPayload struct {
	Target         flowruntime.FlowRuntimeTarget `json:"target"`
	FlowID         string                        `json:"flowId"`
	Payload        json.RawMessage               `json:"payload"`
	Projection     json.RawMessage               `json:"projection"`
	ApprovalPolicy ApprovalPolicy                `json:"approvalPolicy"`
	Pin            *flowruntime.Pin              `json:"pin,omitempty"`
}

type approvalPayload struct {
	LaunchOperationID string                          `json:"launchOperationId"`
	Target            flowruntime.FlowRuntimeTarget   `json:"target"`
	Identity          flowruntime.FlowRuntimeIdentity `json:"identity"`
	Approval          json.RawMessage                 `json:"approval"`
}

type signalPayload struct {
	Target     flowruntime.FlowRuntimeTarget `json:"target"`
	FlowID     string                        `json:"flowId"`
	RunID      string                        `json:"runId"`
	Name       string                        `json:"name"`
	Payload    json.RawMessage               `json:"payload"`
	Projection json.RawMessage               `json:"projection"`
}

type runMutationPayload struct {
	Target     flowruntime.FlowRuntimeTarget `json:"target"`
	FlowID     string                        `json:"flowId"`
	RunID      string                        `json:"runId"`
	Projection json.RawMessage               `json:"projection"`
}

type steerPayload struct {
	runMutationPayload
	MessageID   string            `json:"messageId"`
	CreatedAt   float64           `json:"createdAt"`
	Body        string            `json:"body"`
	Attribution map[string]string `json:"attribution,omitempty"`
}

type terminalReceipt struct {
	Kind       string                          `json:"kind"`
	Runtime    flowruntime.FlowRuntimeIdentity `json:"runtime"`
	Receipt    *flowruntime.FlowRuntimeReceipt `json:"receipt,omitempty"`
	Run        *flowruntime.FlowRuntimeRun     `json:"run,omitempty"`
	Cursor     string                          `json:"cursor,omitempty"`
	ErrorClass string                          `json:"errorClass,omitempty"`
	ErrorCode  string                          `json:"errorCode,omitempty"`
	ErrorStep  string                          `json:"errorStep,omitempty"`
	Projection json.RawMessage                 `json:"projection"`
}
