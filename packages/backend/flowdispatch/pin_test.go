package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

var (
	// The recording runtime serves source "b"*40, here the pin's own source.
	todoPin       = flowruntime.Pin{Flow: TodoFlow, SourceCommit: strings.Repeat("b", 40), ExecutionDigest: strings.Repeat("d", 64)}
	otherDigest   = strings.Repeat("e", 64)
	stackScope    = jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}
	stackTarget   = flowruntime.Target{WorkspaceID: "lane-1", BindingKind: StackBindingKind, BindingID: "item-1"}
	invalidCommit = flowruntime.Pin{Flow: TodoFlow, SourceCommit: strings.Repeat("C", 40), ExecutionDigest: strings.Repeat("d", 64)}
)

type delayedPinCancellation struct {
	*recordingRuntime
	observations      atomic.Int32
	failedObservation bool
}

func (r *delayedPinCancellation) Observe(ctx context.Context, runID, cursor string, limit int) (flowruntime.Observation, error) {
	observation := r.observations.Add(1)
	if observation == 1 {
		return flowruntime.Observation{Run: flowruntime.Run{RunID: runID, FlowID: "todo", Status: "running"}}, nil
	}
	if observation == 2 && r.failedObservation {
		return flowruntime.Observation{}, errors.New("temporary observation outage")
	}
	return r.recordingRuntime.Observe(ctx, runID, cursor, limit)
}

func stackLaunch(requestID, flowID string, pin *flowruntime.Pin) LaunchRequest {
	return LaunchRequest{Scope: stackScope, RequestID: requestID, Target: stackTarget, FlowID: flowID,
		Payload: json.RawMessage(`{"prompt":"x"}`), Projection: json.RawMessage(`{"kind":"mythical-item"}`), ApprovalPolicy: ApprovalAuto, Pin: pin}
}

// Fable round 1, F2: the todo composition is admitted only as a stack item
// launch carrying a complete todo pin. Every other route, by any spelling,
// is refused at admission, before a job exists.
func TestTodoFlowIsAdmittedOnlyAsAPinnedStackLaunch(t *testing.T) {
	pin := todoPin
	reviewPin := todoPin
	reviewPin.Flow = "review/change"
	for _, flowID := range []string{"todo", "flows/todo/flow.ts", " todo ", "todo/"} {
		for name, request := range map[string]LaunchRequest{
			"repository job":         {Scope: stackScope, RequestID: "job", FlowID: flowID, Target: flowruntime.Target{WorkspaceID: "w", BindingKind: "repository-job-dispatch", BindingID: "d"}, Pin: &pin},
			"invoked run":            {Scope: stackScope, RequestID: "invoke", FlowID: flowID, Target: flowruntime.Target{WorkspaceID: "w", BindingKind: "workflow-run", BindingID: "r"}},
			"agent session":          {Scope: stackScope, RequestID: "agent", FlowID: flowID, Target: flowruntime.Target{BindingKind: "agent-session", BindingID: "s"}},
			"stack without a pin":    stackLaunch("unpinned", flowID, nil),
			"stack with another pin": stackLaunch("other", flowID, &reviewPin),
		} {
			t.Run(flowID+"/"+name, func(t *testing.T) {
				_, err := launchAdmission(request)
				require.ErrorIs(t, err, ErrTodoOutsideStack)
			})
		}
	}
	_, err := launchAdmission(stackLaunch("invalid", "todo", &invalidCommit))
	require.ErrorContains(t, err, "pin is incomplete")
	_, err = launchAdmission(stackLaunch("invalid-engine", "review/change", &invalidCommit))
	require.ErrorContains(t, err, "pin is incomplete", "every pinned launch needs a complete pin")
	admitted, err := launchAdmission(stackLaunch("pinned", "todo", &pin))
	require.NoError(t, err)
	var payload launchPayload
	require.NoError(t, json.Unmarshal(admitted.Payload, &payload))
	require.Equal(t, &pin, payload.Pin, "the pin is persisted with the durable launch")
	engine, err := launchAdmission(stackLaunch("engine", "review/change", &pin))
	require.NoError(t, err, "an engine launch of the attempt carries the attempt's pin")
	require.Contains(t, string(engine.Payload), `"pin":{"flow":"todo"`)
	for _, name := range []string{"todos", "todo-list", "coding/todo"} {
		_, err := launchAdmission(LaunchRequest{Scope: stackScope, RequestID: name, FlowID: name, Target: flowruntime.Target{BindingKind: "workflow-run", BindingID: "r"}})
		require.NoError(t, err, name)
	}
}

// A todo launch queued by any other route (a row written before this check)
// is refused by the worker before the runtime is resolved: no machine
// wakes, no host starts, no token is minted.
func TestTodoLaunchOutsideTheStackFailsBeforeResolution(t *testing.T) {
	for name, payload := range map[string]launchPayload{
		"repository job": {Target: flowruntime.Target{TenantID: stackScope.TenantID, PrincipalID: stackScope.PrincipalID, WorkspaceID: "w", BindingKind: "repository-job-dispatch", BindingID: "d"}, FlowID: "todo", Payload: json.RawMessage(`{}`), Projection: json.RawMessage(`{}`), ApprovalPolicy: ApprovalAuto},
		"stack unpinned": {Target: flowruntime.Target{TenantID: stackScope.TenantID, PrincipalID: stackScope.PrincipalID, WorkspaceID: "w", BindingKind: StackBindingKind, BindingID: "i"}, FlowID: "todo", Payload: json.RawMessage(`{}`), Projection: json.RawMessage(`{}`), ApprovalPolicy: ApprovalAuto},
		"stack invalid":  {Target: flowruntime.Target{TenantID: stackScope.TenantID, PrincipalID: stackScope.PrincipalID, WorkspaceID: "w", BindingKind: StackBindingKind, BindingID: "i"}, FlowID: "todo", Payload: json.RawMessage(`{}`), Projection: json.RawMessage(`{}`), ApprovalPolicy: ApprovalAuto, Pin: &invalidCommit},
	} {
		t.Run(name, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			var resolved atomic.Int32
			service, err := New(Config{Store: store, ObservationDelay: 2 * time.Millisecond,
				Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					resolved.Add(1)
					return newRecordingRuntime(), nil
				})})
			require.NoError(t, err)
			body, err := json.Marshal(payload)
			require.NoError(t, err)
			receipt, err := store.Admit(context.Background(), jobs.Admission{Scope: stackScope, Operation: OperationLaunch, RequestID: "legacy-" + name,
				Payload: body, EffectPolicy: jobs.EffectReconcile, EffectKey: "flow-runtime:legacy-" + name})
			require.NoError(t, err)
			startTestWorker(t, service, "todo-route")
			operation := waitOperation(t, store, stackScope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State.Terminal() })
			require.Equal(t, jobs.StateFailed, operation.State)
			require.Contains(t, string(operation.TerminalReceipt), "todo_requires_stack_admission")
			require.Zero(t, resolved.Load(), "refused before the runtime was resolved")
		})
	}
}

// Spec §11.4.1: a lane's host serves the lane's working copy, whose source
// is never the main commit a TODO pinned its flow at. Every launch of a
// pinned attempt still reaches that host with the pin, which names where the
// host reads the pinned flow from; the pinned flow runs only at its digest.
func TestPinnedLaunchRunsOnTheLanesHostWithItsPin(t *testing.T) {
	for _, flowID := range []string{"todo", "review/change"} {
		t.Run(flowID, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := newRecordingRuntime()
			runtime.executionDigest = todoPin.ExecutionDigest
			projector := &recordingProjector{}
			service, err := New(Config{Store: store, Projector: projector, ObservationDelay: 2 * time.Millisecond,
				Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
			require.NoError(t, err)
			pin := todoPin
			pin.SourceCommit = strings.Repeat("c", 40)
			receipt, err := service.Admit(context.Background(), stackLaunch("lane-source", flowID, &pin))
			require.NoError(t, err)
			startTestWorker(t, service, "source-worker")
			operation := waitOperation(t, store, stackScope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State.Terminal() })
			require.Equal(t, jobs.StateCompleted, operation.State, string(operation.TerminalReceipt))
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			require.Len(t, runtime.launches, 1)
			require.Equal(t, &pin, runtime.launches[0].Pin, "the host receives the pin and its source commit")
			require.NotEqual(t, pin.SourceCommit, runtime.launches[0].SourceRevision, "the host serves its own source")
		})
	}
}

// A persisted reconnect is untrusted until its digest matches admission.
// Refuse before waking a machine, including before cancelling a named run.
func TestPinnedReconnectValidatesDigestBeforeResolution(t *testing.T) {
	for _, test := range []struct {
		name, runID, digest string
		valid               bool
		failure             string
	}{
		{"wrong projection", "run-1", todoPin.ExecutionDigest, false, ""},
		{"wrong launch digest", "", otherDigest, false, ""},
		{"wrong reconnect digest", "run-1", otherDigest, false, ""},
		{"missing reconnect digest", "run-1", "", false, ""},
		{"admitted reconnect", "run-1", todoPin.ExecutionDigest, true, ""},
		{"rejected host reconnect", "run-1", todoPin.ExecutionDigest, true, "pin_mismatch"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, pool := newFlowDispatchStore(t)
			var resolved atomic.Int32
			runtime := newRecordingRuntime()
			runtime.flowID = "todo"
			runtime.executionDigest = todoPin.ExecutionDigest
			runtime.status = "running"
			service, err := New(Config{Store: store, ObservationDelay: 2 * time.Millisecond,
				Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					resolved.Add(1)
					return runtime, nil
				})})
			require.NoError(t, err)
			receipt, err := service.Admit(t.Context(), stackLaunch("reconnect-pin", "todo", &todoPin))
			require.NoError(t, err)
			target := stackTarget
			target.TenantID, target.PrincipalID = stackScope.TenantID, stackScope.PrincipalID
			checkpoint := RuntimeCheckpoint{Version: 1, Target: target, FlowID: "todo", RunID: test.runID, ExecutionDigest: test.digest, FailureCode: test.failure}
			wantFailure := "checkpoint_pin_mismatch"
			if test.name == "wrong projection" {
				checkpoint.Projection = json.RawMessage(`{"kind":"mythical-item","attempt":99}`)
				wantFailure = "checkpoint_projection_mismatch"
			}
			_, err = pool.Exec(t.Context(), `UPDATE product_job_dispatches SET external_receipt=$2::jsonb WHERE operation_id=$1`, receipt.OperationID, mustJSON(checkpoint))
			require.NoError(t, err)
			startTestWorker(t, service, "reconnect-pin-worker")
			operation := waitOperation(t, store, stackScope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State.Terminal() })
			if test.failure == "pin_mismatch" {
				require.Equal(t, jobs.StateFailed, operation.State)
				require.Contains(t, string(operation.TerminalReceipt), "pin_mismatch")
				require.Positive(t, resolved.Load())
			} else if test.valid {
				require.Equal(t, jobs.StateCompleted, operation.State, string(operation.TerminalReceipt))
				require.Positive(t, resolved.Load())
			} else {
				require.Equal(t, jobs.StateFailed, operation.State)
				require.Contains(t, string(operation.TerminalReceipt), wantFailure)
				require.Zero(t, resolved.Load())
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			require.Empty(t, runtime.launches, "reconnect never launches another run")
			if test.failure == "pin_mismatch" {
				require.Equal(t, 1, runtime.cancels, "a rejected host remains cancelled after reconnect")
			} else {
				require.Zero(t, runtime.cancels, "an invalid checkpoint cannot cancel its named run")
			}
		})
	}
}

// Astra and Fable round 1: a pinned launch runs only the pinned code. The
// host receives the pin; a host that planned another digest, or none, never
// runs for the attempt: a parked plan is denied, a started run is cancelled
// and observed to its end, and the launch fails pin_mismatch. An engine
// launch of the attempt carries the pin and must name an execution identity.
func TestPinnedLaunchRunsOnlyThePinnedCode(t *testing.T) {
	pin := todoPin
	for _, test := range []struct {
		name, flowID, digest                     string
		parked, runs, delayed, failedObservation bool
	}{
		{name: "pinned digest runs", flowID: "todo", digest: pin.ExecutionDigest, runs: true},
		{name: "another digest is cancelled", flowID: "todo", digest: otherDigest},
		{name: "another digest cancellation completes after reconnect", flowID: "todo", digest: otherDigest, delayed: true},
		{name: "another digest stays refused through observation outage", flowID: "todo", digest: otherDigest, delayed: true, failedObservation: true},
		{name: "no digest is cancelled", flowID: "todo", digest: ""},
		{name: "parked plan of another digest is denied", flowID: "todo", digest: otherDigest, parked: true},
		{name: "engine launch with its own identity runs", flowID: "review/change", digest: otherDigest, runs: true},
		{name: "engine launch without an identity is cancelled", flowID: "review/change", digest: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := newRecordingRuntime()
			runtime.executionDigest = test.digest
			runtime.requireApproval = test.parked
			var host flowruntime.Runtime = runtime
			if test.delayed {
				host = &delayedPinCancellation{recordingRuntime: runtime, failedObservation: test.failedObservation}
			}
			projector := &recordingProjector{}
			service, err := New(Config{Store: store, Projector: projector, ObservationDelay: 2 * time.Millisecond, MaxObservationDelay: 5 * time.Millisecond,
				Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return host, nil })})
			require.NoError(t, err)
			receipt, err := service.Admit(context.Background(), stackLaunch("pinned", test.flowID, &pin))
			require.NoError(t, err)
			startTestWorker(t, service, "pin-worker")
			operation := waitOperation(t, store, stackScope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State.Terminal() })
			runtime.mu.Lock()
			launches, cancels, approvals, denials := append([]flowruntime.Launch(nil), runtime.launches...), runtime.cancels, runtime.approvals, runtime.denials
			runtime.mu.Unlock()
			require.NotEmpty(t, launches)
			for _, launch := range launches {
				require.Equal(t, &pin, launch.Pin, "the host receives the attempt's pin")
			}
			if test.runs {
				require.Equal(t, jobs.StateCompleted, operation.State, string(operation.TerminalReceipt))
				require.Zero(t, cancels)
				return
			}
			require.Equal(t, jobs.StateFailed, operation.State)
			var settled terminalReceipt
			require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &settled))
			require.Equal(t, "pin_mismatch", settled.ErrorCode)
			require.Zero(t, approvals, "nothing under the wrong pin was approved")
			if test.parked {
				require.Equal(t, 1, denials, "the parked plan was denied")
				require.Zero(t, cancels)
			} else {
				require.Equal(t, 1, cancels, "the run was cancelled, once")
				require.NotNil(t, settled.Run)
				require.Equal(t, "cancelled", settled.Run.Status, "settled only after the run ended")
			}
			projector.mu.Lock()
			updates := append([]ProjectionUpdate(nil), projector.updates...)
			projector.mu.Unlock()
			last := updates[len(updates)-1]
			for _, update := range updates {
				require.True(t, update.Checkpoint.PinRefused, "neither reconnect nor a transport failure may credit this run")
			}
			require.Equal(t, jobs.StateFailed, last.State)
			require.Equal(t, "pin_mismatch", last.Checkpoint.FailureCode)
			if test.flowID == pin.Flow {
				require.Equal(t, pin.ExecutionDigest, last.Checkpoint.ExecutionDigest, "the admitted pin is never overwritten by host output")
			} else {
				require.Equal(t, test.digest, last.Checkpoint.ExecutionDigest)
			}
		})
	}
}

func TestPinAdmits(t *testing.T) {
	pin := todoPin
	var none *flowruntime.Pin
	require.True(t, none.Admits("todo", ""), "an unpinned launch is unconstrained")
	require.True(t, pin.Admits("todo", pin.ExecutionDigest))
	require.False(t, pin.Admits("todo", otherDigest))
	require.False(t, pin.Admits("todo", ""))
	require.False(t, pin.Admits("todo", strings.ToUpper(pin.ExecutionDigest)))
	require.True(t, pin.Admits("review/change", otherDigest))
	require.False(t, pin.Admits("review/change", "short"))
	require.True(t, pin.Valid())
	for _, broken := range []flowruntime.Pin{{}, {Flow: "todo"}, invalidCommit, {Flow: "", SourceCommit: pin.SourceCommit, ExecutionDigest: pin.ExecutionDigest},
		{Flow: "todo", SourceCommit: pin.SourceCommit, ExecutionDigest: pin.ExecutionDigest[:63]}} {
		require.False(t, broken.Valid(), "%+v", broken)
	}
	require.True(t, errors.Is(ErrTodoOutsideStack, ErrTodoOutsideStack))
}
