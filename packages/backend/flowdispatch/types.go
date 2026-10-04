// Package flowdispatch durably maps product requests onto the canonical
// TypeScript Flow runtime. It owns admission and receipt projection only; the
// runtime host remains the sole graph, journal, approval, and execution owner.
package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const (
	OperationLaunch  = "flow.runtime.launch"
	OperationApprove = "flow.runtime.approve"
	OperationSignal  = "flow.runtime.signal"
)

var (
	ErrApprovalUnavailable = errors.New("flow dispatch: approval is not available")
	ErrNotLaunchOperation  = errors.New("flow dispatch: operation is not a Flow launch")
)

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
	Store     *jobs.Store
	Resolver  flowruntime.FlowRuntimeResolver
	Projector Projector
	// ObservationDelay is the first wait before re-polling a parked or running
	// launch. Each poll that finds no progress doubles it, up to
	// MaxObservationDelay.
	ObservationDelay    time.Duration
	MaxObservationDelay time.Duration
	ObservationLimit    int
	ObservationPages    int
	RuntimeCallTimeout  time.Duration
}

type launchPayload struct {
	Target         flowruntime.FlowRuntimeTarget `json:"target"`
	FlowID         string                        `json:"flowId"`
	Payload        json.RawMessage               `json:"payload"`
	Projection     json.RawMessage               `json:"projection"`
	ApprovalPolicy ApprovalPolicy                `json:"approvalPolicy"`
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
