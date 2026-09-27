package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
)

// startingResolver has no live host until a start finishes. Its starts block
// until the test releases them, like a box host that takes a while to boot.
type startingResolver struct {
	mu      sync.Mutex
	live    bool
	starts  atomic.Int32
	release chan struct{}
	fail    error
}

func (resolver *startingResolver) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if !resolver.live {
		return nil, &testRuntimeFailure{code: "runtime_host_not_running"}
	}
	return listingRuntime{}, nil
}

func (resolver *startingResolver) ResolveFlowRuntime(ctx context.Context, _ flowruntime.Target) (flowruntime.Runtime, error) {
	resolver.starts.Add(1)
	select {
	case <-resolver.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if resolver.fail != nil {
		return nil, resolver.fail
	}
	resolver.mu.Lock()
	resolver.live = true
	resolver.mu.Unlock()
	return listingRuntime{}, nil
}

// listingRuntime answers the one RPC these tests read.
type listingRuntime struct{ flowruntime.Runtime }

func (listingRuntime) CallRPC(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`{"ok":true}`), nil
}

func waitHost(t *testing.T, service *Service, target flowruntime.Target, want bool) error {
	t.Helper()
	var last error
	require.Eventually(t, func() bool {
		ready, err := service.StartHost(context.Background(), target)
		last = err
		return err != nil || ready == want
	}, 5*time.Second, 5*time.Millisecond)
	return last
}

// A box whose host has not started lists its flows after one provision: the
// provision answers at once and starts the host once in the background (#2198).
func TestStartHostAnswersAtOnceAndStartsTheBoxHostOnce(t *testing.T) {
	resolver := &startingResolver{release: make(chan struct{})}
	service := &Service{resolver: resolver, hostStarts: background.Jobs[flowruntime.Target]{Timeout: time.Minute, FailureTTL: time.Minute}}
	target := flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "box", BindingKind: "browser-flow", BindingID: "o/r"}

	_, err := service.CallRPC(context.Background(), target, "List", nil)
	require.Error(t, err, "a read never starts a host")
	require.Zero(t, resolver.starts.Load())

	for range 3 {
		ready, err := service.StartHost(context.Background(), target)
		require.NoError(t, err)
		require.False(t, ready)
	}
	require.Eventually(t, func() bool { return resolver.starts.Load() == 1 }, time.Second, time.Millisecond)
	close(resolver.release)
	require.NoError(t, waitHost(t, service, target, true))
	require.Equal(t, int32(1), resolver.starts.Load(), "repeated provisions share one start")
	_, err = service.CallRPC(context.Background(), target, "List", nil)
	require.NoError(t, err)
	require.False(t, service.hostStarts.Running(target), "a finished start is forgotten")
}

// A start that fails is answered to the next provision, which may retry.
func TestStartHostReportsAFailedStartOnce(t *testing.T) {
	release := make(chan struct{})
	close(release)
	resolver := &startingResolver{release: release, fail: &testRuntimeFailure{code: "runtime_start_failed", retryable: true}}
	service := &Service{resolver: resolver, hostStarts: background.Jobs[flowruntime.Target]{Timeout: time.Minute, FailureTTL: time.Minute}}
	target := flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "box", BindingKind: "browser-flow", BindingID: "o/r"}

	ready, err := service.StartHost(context.Background(), target)
	require.NoError(t, err)
	require.False(t, ready)
	err = waitHost(t, service, target, true)
	var failure flowruntime.Failure
	require.True(t, errors.As(err, &failure))
	require.Equal(t, "runtime_start_failed", failure.FlowRuntimeCode())

	resolver.fail = nil
	ready, err = service.StartHost(context.Background(), target)
	require.NoError(t, err)
	require.False(t, ready)
	require.NoError(t, waitHost(t, service, target, true))
	require.Equal(t, int32(2), resolver.starts.Load())
}

// Any refusal other than "not running" is the caller's answer; nothing starts.
func TestStartHostDoesNotStartForARefusedTarget(t *testing.T) {
	service := &Service{resolver: refusingExisting{}, hostStarts: background.Jobs[flowruntime.Target]{Timeout: time.Minute, FailureTTL: time.Minute}}
	_, err := service.StartHost(context.Background(), flowruntime.Target{WorkspaceID: "box"})
	var failure flowruntime.Failure
	require.True(t, errors.As(err, &failure))
	require.Equal(t, "runtime_binding_unavailable", failure.FlowRuntimeCode())
}

type refusingExisting struct{}

func (refusingExisting) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	return nil, &testRuntimeFailure{code: "runtime_binding_unavailable"}
}

func (refusingExisting) ResolveFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	panic("a refused target must not start a host")
}

// A host another caller is starting (it holds the owner lock) is waited for,
// never started a second time.
func TestStartHostWaitsForAStartElsewhere(t *testing.T) {
	service := &Service{resolver: startingElsewhere{}, hostStarts: background.Jobs[flowruntime.Target]{Timeout: time.Minute, FailureTTL: time.Minute}}
	ready, err := service.StartHost(context.Background(), flowruntime.Target{WorkspaceID: "box"})
	require.NoError(t, err)
	require.False(t, ready)
}

type startingElsewhere struct{}

func (startingElsewhere) ResolveExistingFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	return nil, &testRuntimeFailure{code: "runtime_host_starting", retryable: true}
}

func (startingElsewhere) ResolveFlowRuntime(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
	panic("a host starting elsewhere must not be started again")
}
