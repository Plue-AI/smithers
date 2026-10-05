package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
)

type readRPCResolver struct {
	reads, starts int
	runtime       *readRPCRuntime
	err           error
}

func (r *readRPCResolver) ResolveFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	r.starts++
	return r.runtime, r.err
}
func (r *readRPCResolver) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	r.reads++
	return r.runtime, r.err
}

type readRPCRuntime struct {
	flowruntime.Runtime
	calls []string
}

func (r *readRPCRuntime) CallRPC(_ context.Context, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	r.calls = append(r.calls, procedure)
	return payload, nil
}

func TestCallRPCUsesExistingHostForReadsAndNeverFallsBack(t *testing.T) {
	runtime := &readRPCRuntime{}
	resolver := &readRPCResolver{runtime: runtime}
	service := &Service{resolver: resolver}
	for _, procedure := range []string{"List", "Projection.Snapshot"} {
		body := json.RawMessage(`{"_tag":"triggers"}`)
		answer, err := service.CallRPC(context.Background(), flowruntime.Target{}, procedure, body)
		require.NoError(t, err)
		require.Equal(t, body, answer)
	}
	require.Equal(t, 2, resolver.reads)
	require.Zero(t, resolver.starts)
	resolver.err = errors.New("host is stopped")
	_, err := service.CallRPC(context.Background(), flowruntime.Target{}, "List", nil)
	require.EqualError(t, err, "host is stopped")
	require.Zero(t, resolver.starts)
	require.Equal(t, []string{"List", "Projection.Snapshot"}, runtime.calls)
	resolver.err = nil
	_, err = service.CallRPC(context.Background(), flowruntime.Target{}, "Plan", json.RawMessage(`{"flowId":"coding/dispatch","input":{}}`))
	require.NoError(t, err)
	require.Equal(t, 1, resolver.starts)
}

func TestReadRPCRefusesResolverWithoutReadContract(t *testing.T) {
	called := false
	service := &Service{resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		called = true
		return &readRPCRuntime{}, nil
	})}
	_, err := service.CallRPC(context.Background(), flowruntime.Target{}, "List", nil)
	require.ErrorContains(t, err, "read-only resolver")
	require.False(t, called)
}

// observedRuntime answers Observe with the flow each run belongs to, and
// Plan with a saved plan of the flow it names.
type observedRuntime struct {
	readRPCRuntime
	flows map[string]string
}

func (r *observedRuntime) Observe(_ context.Context, runID, _ string, _ int) (flowruntime.Observation, error) {
	flow, ok := r.flows[runID]
	if !ok {
		return flowruntime.Observation{}, errors.New("run not found")
	}
	return flowruntime.Observation{Run: flowruntime.Run{RunID: runID, FlowID: flow, Status: "paused"}}, nil
}

func (r *observedRuntime) CallRPC(ctx context.Context, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	if _, err := r.readRPCRuntime.CallRPC(ctx, procedure, payload); err != nil || procedure != "Plan" {
		return payload, err
	}
	var plan struct {
		FlowID string `json:"flowId"`
	}
	if err := json.Unmarshal(payload, &plan); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"planId": "plan-of-" + plan.FlowID, "flowId": plan.FlowID, "digest": "d"})
}

// Fable round 2 N1, round 3 N2, Astra round 3 N1: the browser workflow relay
// never plans, runs, resumes or forks the todo composition; only the
// stack's pinned launch does. Payloads are read by their exact keys, a
// duplicate key or an unreadable payload is refused, a Plan naming todo in
// any spelling is refused, and a Run of a saved plan relays only a plan this
// relay itself saved for the same caller and box: all before any host is
// resolved. A run, resume or fork of a todo run is refused before the host
// is asked to mutate it. Other flows and runs relay as before.
func TestCallRPCRefusesTheTodoComposition(t *testing.T) {
	runtime := &observedRuntime{flows: map[string]string{"todo-run": "todo", "other-run": "coding/dispatch"}}
	resolver := &readRPCResolver{}
	service := &Service{resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		resolver.starts++
		return runtime, nil
	}), runtimeCallTimeout: time.Second, relayPlans: memoryRelayPlans{}}
	box := flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "box"}
	for _, call := range []struct {
		procedure, payload string
		refusal            error
	}{
		{"Plan", `{"flowId":"todo","input":{}}`, ErrTodoOutsideStack},
		{"Plan", `{"flowId":"flows/todo/flow.ts","input":{}}`, ErrTodoOutsideStack},
		{"Plan", `{"flowId":"./flows/todo/flow.ts","input":{}}`, ErrTodoOutsideStack},
		{"Plan", `{"flowId":"flows/todo/","input":{}}`, ErrTodoOutsideStack},
		{"Plan", `{"flowId":"todo","flowid":"coding/dispatch","input":{}}`, ErrTodoOutsideStack},
		{"Plan", `{"flowId":"coding/dispatch","flowId":"todo","input":{}}`, ErrRelayPayload},
		{"Plan", `{"flowid":"todo","input":{}}`, ErrRelayPayload},
		{"Plan", `{"flowId":7}`, ErrRelayPayload},
		{"Plan", `not json`, ErrRelayPayload},
		{"Run", `{"_tag":"Plan","planId":"stack-parked-todo","digest":"d","envelope":{},"idempotencyKey":"k"}`, ErrRelayPlanUnknown},
		{"Run", `{"_tag":"plan","planId":"plan-of-coding/dispatch"}`, ErrRelayPayload},
		{"Run", `{"_tag":"Resume"}`, ErrRelayPayload},
		{"Resume", `{"reason":"again"}`, ErrRelayPayload},
		{"Run.Fork", `[]`, ErrRelayPayload},
		{"Approval.Submit", `{"target":{"_tag":"Plan","planId":"stack-parked-todo","digest":"d"},"scope":"run","decision":"approve"}`, ErrRelayPlanUnknown},
		{"Approval.Submit", `{"target":{"_tag":"Plan","planId":"a","planId":"b"},"decision":"approve"}`, ErrRelayPayload},
	} {
		_, err := service.CallRPC(context.Background(), box, call.procedure, json.RawMessage(call.payload))
		require.ErrorIs(t, err, call.refusal, "%s %s", call.procedure, call.payload)
	}
	require.Zero(t, resolver.starts, "no host is resolved for a refused call")
	for _, call := range []struct{ procedure, payload string }{
		{"Run", `{"_tag":"Resume","runId":"todo-run","idempotencyKey":"k"}`},
		{"Resume", `{"runId":"todo-run","reason":"again"}`},
		{"Run.Fork", `{"runId":"todo-run","at":3}`},
	} {
		_, err := service.CallRPC(context.Background(), box, call.procedure, json.RawMessage(call.payload))
		require.ErrorIs(t, err, ErrTodoOutsideStack, call.procedure)
	}
	_, err := service.CallRPC(context.Background(), box, "Resume", json.RawMessage(`{"runId":"missing-run"}`))
	require.ErrorContains(t, err, "run not found", "a run the host cannot answer for is refused")
	require.Empty(t, runtime.calls, "nothing reached the host's RPC")
	for _, call := range []struct{ procedure, payload string }{
		{"Plan", `{"flowId":"todos","input":{}}`},
		{"Plan", `{"flowId":"coding/dispatch","input":{}}`},
		{"Approval.Submit", `{"target":{"_tag":"Plan","planId":"plan-of-coding/dispatch","digest":"d"},"scope":"run","decision":"approve"}`},
		{"Run", `{"_tag":"Plan","planId":"plan-of-coding/dispatch","digest":"d","envelope":{},"idempotencyKey":"k"}`},
		{"Run", `{"_tag":"Resume","runId":"other-run","idempotencyKey":"k"}`},
		{"Resume", `{"runId":"other-run"}`},
		{"Run.Fork", `{"runId":"other-run","at":1}`},
	} {
		_, err := service.CallRPC(context.Background(), box, call.procedure, json.RawMessage(call.payload))
		require.NoError(t, err, call.procedure)
	}
	require.Equal(t, []string{"Plan", "Plan", "Approval.Submit", "Run", "Run", "Resume", "Run.Fork"}, runtime.calls)
	// A saved plan is the caller's and the box's own.
	other := box
	other.PrincipalID = "user:2"
	_, err = service.CallRPC(context.Background(), other, "Run", json.RawMessage(`{"_tag":"Plan","planId":"plan-of-coding/dispatch","digest":"d","envelope":{},"idempotencyKey":"k"}`))
	require.ErrorIs(t, err, ErrRelayPlanUnknown)
	// Without a plan store the relay runs and approves no plan.
	service.relayPlans = nil
	_, err = service.CallRPC(context.Background(), box, "Run", json.RawMessage(`{"_tag":"Plan","planId":"plan-of-coding/dispatch","digest":"d","envelope":{},"idempotencyKey":"k"}`))
	require.ErrorIs(t, err, ErrRelayPlanUnknown)
}

// memoryRelayPlans stands in for the PostgreSQL plan store (compose tests
// cover that one).
type memoryRelayPlans map[string]string

func (plans memoryRelayPlans) key(target flowruntime.Target, planID string) string {
	return target.TenantID + "\x00" + target.PrincipalID + "\x00" + target.WorkspaceID + "\x00" + planID
}

func (plans memoryRelayPlans) SaveRelayPlan(_ context.Context, target flowruntime.Target, planID, flowID string) error {
	plans[plans.key(target, planID)] = flowID
	return nil
}

func (plans memoryRelayPlans) RelayPlanFlow(_ context.Context, target flowruntime.Target, planID string) (string, bool, error) {
	flowID, ok := plans[plans.key(target, planID)]
	return flowID, ok, nil
}
