package services

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// blockGatewayPreflight parks every box preflight until the test ends, then
// waits for the detached resolve to finish so it never outlives the test.
func blockGatewayPreflight(t *testing.T, vm *fakeRepoGatewayVMClient) *atomic.Int64 {
	t.Helper()
	var calls atomic.Int64
	release, finished := make(chan struct{}), make(chan struct{})
	vm.execAwaitFn = func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
		defer close(finished)
		calls.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
		}
		one := int32(1)
		return sandbox.ExecResult{StatusCode: &one}, nil
	}
	t.Cleanup(func() {
		close(release)
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("detached resolve did not finish")
		}
	})
	return &calls
}

// Repro apps/ui/canary-repros/honesty/22.6 and flow-sweep/A.18: resolving an
// existing gateway ran its whole resume on the caller's connection. It must
// answer the poll-me 409 once the response budget elapses instead.
func TestResolveExistingGateway_AnswersConflictInsteadOfHangingOnResume(t *testing.T) {
	svc, q, vm, w := boundGatewayFixture(t)
	q.active = boundGatewayRow(q, w, "starting")
	svc.provisionResponseBudget = 20 * time.Millisecond
	blockGatewayPreflight(t, vm)

	start := time.Now()
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	elapsed := time.Since(start)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status, "the client taxonomy's poll-me answer, not a hung connection")
	assert.Equal(t, pkgerrors.CodeRepositoryWorkspacePending, apiErr.Code)
	assert.Contains(t, apiErr.Message, "resuming")
	assert.Less(t, elapsed, 2*time.Second, "the caller must be answered inside the response budget")
	assert.Empty(t, q.getSoftDeleted(), "a slow resume is not evidence the gateway is dead")
}

// A client that polls the 409 must not start a fresh resume on every poll —
// that is how a gateway never converges. The resolve is singleflighted per row.
func TestResolveExistingGateway_SingleflightsConcurrentResumes(t *testing.T) {
	svc, q, vm, w := boundGatewayFixture(t)
	q.active = boundGatewayRow(q, w, "starting")
	svc.provisionResponseBudget = 20 * time.Millisecond
	preflights := blockGatewayPreflight(t, vm)

	for i := 0; i < 5; i++ {
		_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
		assert.Equal(t, 409, apiStatus(t, err))
	}
	assert.Equal(t, int64(1), preflights.Load(), "five polls, one resume")
}

// A healthy running host is answered inside the budget without touching it.
func TestResolveExistingGateway_HealthyHostIsServedDirectly(t *testing.T) {
	svc, q, vm, w := boundGatewayFixture(t)
	q.active = boundGatewayRow(q, w, "running")
	svc.provisionResponseBudget = 2 * time.Second

	info, err := svc.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.NoError(t, err)
	assert.Equal(t, q.active.ID, info.GatewayID)
	assert.Equal(t, w.VmID, info.VMID)
	assert.Equal(t, "running", info.Status)
	assert.Equal(t, "smithers_gateway_bound", info.Token)
	assert.Empty(t, vm.execAwaitReqs, "a healthy host keeps its process")
	assert.Empty(t, vm.systemdSpecs)
	assert.Empty(t, q.getSoftDeleted())
}
