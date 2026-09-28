package compose

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

func TestFlowTargetResolverSeparatesProductBindings(t *testing.T) {
	var agentCalls, repositoryJobCalls int
	agents := flowhost.TargetResolverFunc(func(_ context.Context, _ flowruntime.Target) (flowhost.Authority, error) {
		agentCalls++
		return flowhost.Authority{WorkspaceID: "agent-workspace"}, nil
	})
	repositoryJobs := flowhost.TargetResolverFunc(func(_ context.Context, _ flowruntime.Target) (flowhost.Authority, error) {
		repositoryJobCalls++
		return flowhost.Authority{WorkspaceID: "repository-job-workspace"}, nil
	})
	resolver := flowTargetResolver(agents, repositoryJobs)

	agent, err := resolver.ResolveFlowHostTarget(context.Background(), flowruntime.Target{BindingKind: "agent-session"})
	require.NoError(t, err)
	require.Equal(t, "agent-workspace", agent.WorkspaceID)
	job, err := resolver.ResolveFlowHostTarget(context.Background(), flowruntime.Target{BindingKind: "repository-job-dispatch"})
	require.NoError(t, err)
	require.Equal(t, "repository-job-workspace", job.WorkspaceID)
	_, err = resolver.ResolveFlowHostTarget(context.Background(), flowruntime.Target{BindingKind: "unknown"})
	require.ErrorContains(t, err, "unsupported Flow host binding kind")
	require.Equal(t, 1, agentCalls)
	require.Equal(t, 1, repositoryJobCalls)
}

func TestFlowProjectorFansOutDespiteFailure(t *testing.T) {
	var agentCalls, repositoryJobCalls int
	agentErr := errors.New("agent projection failed")
	repositoryJobErr := errors.New("repository job projection failed")
	projector := flowProjector(
		flowdispatch.ProjectorFunc(func(context.Context, flowdispatch.ProjectionUpdate) error {
			agentCalls++
			return agentErr
		}),
		flowdispatch.ProjectorFunc(func(context.Context, flowdispatch.ProjectionUpdate) error {
			repositoryJobCalls++
			return repositoryJobErr
		}),
	)
	err := projector.ProjectFlowRuntime(context.Background(), flowdispatch.ProjectionUpdate{})
	require.ErrorIs(t, err, agentErr)
	require.ErrorIs(t, err, repositoryJobErr)
	require.Equal(t, 1, agentCalls)
	require.Equal(t, 1, repositoryJobCalls)
}

func TestInvokedFlowTargetsRouteOnlyWorkflowInvokeBindings(t *testing.T) {
	var baseKinds, invokedKinds []string
	base := flowhost.TargetResolverFunc(func(_ context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		baseKinds = append(baseKinds, target.BindingKind)
		return flowhost.Authority{}, nil
	})
	invoked := flowhost.TargetResolverFunc(func(_ context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		invokedKinds = append(invokedKinds, target.BindingKind)
		return flowhost.Authority{}, nil
	})
	resolver := withInvokedFlowTargets(base, invoked)
	for _, kind := range []string{"workflow-invoke", "agent-session", "repository-setup"} {
		_, err := resolver.ResolveFlowHostTarget(context.Background(), flowruntime.Target{BindingKind: kind})
		require.NoError(t, err)
	}
	require.Equal(t, []string{"workflow-invoke"}, invokedKinds)
	require.Equal(t, []string{"agent-session", "repository-setup"}, baseKinds)
}
