package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A panic in the detached resolve must fail that resolve and release its
// singleflight entry; otherwise it kills the process, or every later caller
// joins a resolve that never completes.
func TestRepoGatewayService_PanickingResolveFailsAndReleasesTheGateway(t *testing.T) {
	svc, q, vm, w := boundGatewayFixture(t)
	q.active = boundGatewayRow(q, w, "starting")
	vm.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
		panic("sandbox client bug")
	}

	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: w.RepositoryID, UserID: w.UserID, WorkspaceID: w.ID})
	require.Equal(t, 500, apiStatus(t, err))

	svc.resolveMu.Lock()
	inflight := len(svc.resolveInflight)
	svc.resolveMu.Unlock()
	require.Zero(t, inflight, "a panicked resolve must release its singleflight entry")
}
