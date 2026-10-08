package flowdispatch

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
)

type completedModuleRuntime struct {
	flowruntime.Runtime
	identity flowruntime.Identity
	result   flowruntime.MutationResult
	calls    []flowruntime.Lifecycle
}

func (r *completedModuleRuntime) Identity(context.Context) (flowruntime.Identity, error) {
	return r.identity, nil
}
func (r *completedModuleRuntime) Complete(_ context.Context, input flowruntime.Lifecycle) (flowruntime.MutationResult, error) {
	r.calls = append(r.calls, input)
	return r.result, nil
}

type completedModuleResolver struct {
	runtime flowruntime.Runtime
	starts  int
	err     error
}

func (r *completedModuleResolver) ResolveFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	r.starts++
	return r.runtime, r.err
}
func (r *completedModuleResolver) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	return r.runtime, r.err
}

func TestCompleteRunUsesTheExistingOwnerAndCorrelatesItsReceipt(t *testing.T) {
	runtime := &completedModuleRuntime{identity: flowruntime.Identity{Protocol: flowruntime.FlowRuntimeProtocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 7}, result: flowruntime.MutationResult{Operation: "complete", ApplicationRequestID: "merged", Receipt: flowruntime.Receipt{Tag: "Accepted", RunID: "root"}}}
	resolver := &completedModuleResolver{runtime: runtime}
	service := &Service{resolver: resolver}
	require.NoError(t, service.CompleteRun(t.Context(), flowruntime.Target{}, "root", "merged"))
	require.Equal(t, []flowruntime.Lifecycle{{ApplicationRequestID: "merged", OwnerGeneration: 7, RunID: "root"}}, runtime.calls)
	runtime.result.Receipt.RunID = "other"
	require.ErrorContains(t, service.CompleteRun(t.Context(), flowruntime.Target{}, "root", "merged"), "invalid completion receipt")
	runtime.identity.OwnerGeneration = 0
	require.ErrorContains(t, service.CompleteRun(t.Context(), flowruntime.Target{}, "root", "merged"), "invalid completion owner identity")
	require.Len(t, runtime.calls, 2)
	resolver.err = errors.New("host stopped")
	require.EqualError(t, service.CompleteRun(t.Context(), flowruntime.Target{}, "root", "merged"), "host stopped")
	require.Zero(t, resolver.starts)
}
