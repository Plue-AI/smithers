package services

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exercise the public SSH service boundary: a cold guest must settle within
// the HTTP request budget before any access grant or token is minted.
func TestWorkspaceService_SSHActivationRequestBudget(t *testing.T) {
	const workspaceID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	tests := []struct {
		name          string
		timeout       time.Duration
		exec          func(*testing.T, context.Context, context.Context, sandbox.ExecRequest) (sandbox.ExecResult, error)
		wantCode      pkgerrors.Code
		wantExec      bool
		cancelBefore  bool
		cancelSuccess bool
	}{
		{
			name:     "guest timeout fits the request",
			timeout:  10 * time.Second,
			wantExec: true,
			wantCode: pkgerrors.CodeGuestNotReady,
			exec: func(t *testing.T, parent, probe context.Context, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				requestDeadline, _ := parent.Deadline()
				probeDeadline, ok := probe.Deadline()
				require.True(t, ok)
				assert.GreaterOrEqual(t, requestDeadline.Sub(probeDeadline), time.Second)
				require.NotNil(t, req.TimeoutMS)
				assert.Positive(t, *req.TimeoutMS)
				assert.LessOrEqual(t, time.Duration(*req.TimeoutMS)*time.Millisecond, 4*time.Second)
				code := int32(75)
				return sandbox.ExecResult{StatusCode: &code}, nil
			},
		},
		{
			name:     "no probe budget is retryable",
			timeout:  5 * time.Second,
			wantCode: pkgerrors.CodeGuestNotReady,
		},
		{
			name:         "cancelled request has no probe",
			timeout:      time.Second,
			cancelBefore: true,
			wantCode:     pkgerrors.CodeInternal,
		},
		{
			name:     "provider failure remains internal",
			timeout:  10 * time.Second,
			wantExec: true,
			wantCode: pkgerrors.CodeInternal,
			exec: func(_ *testing.T, _, _ context.Context, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{}, errors.New("provider unavailable")
			},
		},
		{
			name:     "provider enforces short request timeout",
			timeout:  7 * time.Second,
			wantExec: true,
			wantCode: pkgerrors.CodeGuestNotReady,
			exec: func(t *testing.T, _, probe context.Context, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				require.NotNil(t, req.TimeoutMS)
				timer := time.NewTimer(time.Duration(*req.TimeoutMS) * time.Millisecond)
				defer timer.Stop()
				select {
				case <-timer.C:
					return sandbox.ExecResult{}, context.DeadlineExceeded
				case <-probe.Done():
					t.Error("probe context expired before the guest execution timeout")
					return sandbox.ExecResult{}, probe.Err()
				}
			},
		},
		{
			name:     "provider exec timeout is retryable",
			timeout:  10 * time.Second,
			wantExec: true,
			wantCode: pkgerrors.CodeGuestNotReady,
			exec: func(_ *testing.T, _, _ context.Context, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
				return sandbox.ExecResult{}, fmt.Errorf("guest exec: %w", context.DeadlineExceeded)
			},
		},
		{
			name:     "request cancellation remains internal",
			timeout:  10 * time.Second,
			wantExec: true,
			wantCode: pkgerrors.CodeInternal,
		},
		{
			name:          "request cancellation wins over provider success",
			timeout:       10 * time.Second,
			wantExec:      true,
			cancelSuccess: true,
			wantCode:      pkgerrors.CodeInternal,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), tc.timeout)
			defer cancel()
			if tc.cancelBefore {
				cancel()
			}
			q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
				workspace := sampleDBWorkspace(arg.ID)
				workspace.Kind = "vm"
				return workspace, nil
			}}
			calls, grants, tokens := 0, 0, 0
			client := &mockWorkspaceSandboxVMClient{
				getVMFn: func(_ context.Context, vmID string) (sandbox.Sandbox, error) {
					return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
				},
				execAwaitFn: func(probe context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
					calls++
					if tc.cancelSuccess {
						cancel()
						zero := int32(0)
						return sandbox.ExecResult{StatusCode: &zero}, nil
					}
					if tc.exec != nil {
						return tc.exec(t, ctx, probe, req)
					}
					cancel()
					<-probe.Done()
					return sandbox.ExecResult{}, probe.Err()
				},
				grantVMPermissionFn: func(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
					grants++
					return sandbox.AccessGrant{}, nil
				},
				createIdentityTokenFn: func(context.Context, string) (sandbox.CreatedToken, error) {
					tokens++
					return sandbox.CreatedToken{}, nil
				},
			}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(client))
			_, err := svc.GetWorkspaceSSHConnectionInfo(ctx, workspaceID, 101, 1)
			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, tc.wantCode, apiErr.Code)
			if tc.wantCode == pkgerrors.CodeGuestNotReady {
				assert.Equal(t, 3, apiErr.RetryAfter)
				assert.NoError(t, ctx.Err(), "API must settle before its request expires")
			}
			if tc.wantExec {
				assert.Equal(t, 1, calls)
			} else {
				assert.Zero(t, calls)
			}
			assert.Zero(t, grants)
			assert.Zero(t, tokens)
		})
	}
}
