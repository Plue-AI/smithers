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
	_, err = service.CallRPC(context.Background(), flowruntime.Target{}, "Plan", json.RawMessage(`{}`))
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

// observedRuntime answers Observe with the flow each run belongs to.
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

// Fable round 2, N1: the browser workflow relay never plans, runs, resumes
// or forks the todo composition; only the stack's pinned launch does. A Plan
// naming it is refused before any host is resolved, and a run, resume or
// fork of one of its runs before the host is asked to mutate it. Other flows
// and runs relay as before.
func TestCallRPCRefusesTheTodoComposition(t *testing.T) {
	runtime := &observedRuntime{flows: map[string]string{"todo-run": "todo", "other-run": "coding/dispatch"}}
	resolver := &readRPCResolver{}
	service := &Service{resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		resolver.starts++
		return runtime, nil
	}), runtimeCallTimeout: time.Second}
	for _, flowID := range []string{"todo", "flows/todo/flow.ts"} {
		_, err := service.CallRPC(context.Background(), flowruntime.Target{}, "Plan", json.RawMessage(`{"flowId":"`+flowID+`","input":{}}`))
		require.ErrorIs(t, err, ErrTodoOutsideStack, flowID)
	}
	require.Zero(t, resolver.starts, "no host is resolved for a refused plan")
	for _, call := range []struct{ procedure, payload string }{
		{"Run", `{"_tag":"Resume","runId":"todo-run","idempotencyKey":"k"}`},
		{"Resume", `{"runId":"todo-run","reason":"again"}`},
		{"Run.Fork", `{"runId":"todo-run","at":3}`},
	} {
		_, err := service.CallRPC(context.Background(), flowruntime.Target{}, call.procedure, json.RawMessage(call.payload))
		require.ErrorIs(t, err, ErrTodoOutsideStack, call.procedure)
	}
	_, err := service.CallRPC(context.Background(), flowruntime.Target{}, "Resume", json.RawMessage(`{"runId":"missing-run"}`))
	require.ErrorContains(t, err, "run not found", "a run the host cannot answer for is refused")
	require.Empty(t, runtime.calls, "nothing reached the host's RPC")
	for _, call := range []struct{ procedure, payload string }{
		{"Plan", `{"flowId":"todos","input":{}}`},
		{"Run", `{"_tag":"Resume","runId":"other-run","idempotencyKey":"k"}`},
		{"Resume", `{"runId":"other-run"}`},
		{"Run.Fork", `{"runId":"other-run","at":1}`},
		{"Run", `{"_tag":"Plan","planId":"p","digest":"d","envelope":{},"idempotencyKey":"k"}`},
	} {
		_, err := service.CallRPC(context.Background(), flowruntime.Target{}, call.procedure, json.RawMessage(call.payload))
		require.NoError(t, err, call.procedure)
	}
	require.Equal(t, []string{"Plan", "Run", "Resume", "Run.Fork", "Run"}, runtime.calls)
}
