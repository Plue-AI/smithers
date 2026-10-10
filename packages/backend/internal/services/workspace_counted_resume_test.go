package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type countedResumePolicy struct {
	sandboxPolicyStub
	countedCalls int
	startErr     error
}

type countedResumeStore struct {
	*mockWorkspaceQuerier
	workspace db.Workspace
}

func (s *countedResumeStore) SetWorkspaceIdleTimeout(_ context.Context, arg db.SetWorkspaceIdleTimeoutParams) (db.Workspace, error) {
	s.workspace.IdleTimeoutSecs = arg.IdleTimeoutSecs
	return s.workspace, nil
}

// GetBranchMachineOwner answers that the install has no machine service owner
// yet, so a composed wake decides authority by the row's owner.
func (*countedResumeStore) GetBranchMachineOwner(ctx context.Context) (int64, error) {
	return noBranchMachineOwner{}.GetBranchMachineOwner(ctx)
}

func (p *countedResumePolicy) AuthorizeSandboxStart(context.Context, int64) error { return p.startErr }

func (p *countedResumePolicy) AuthorizeCountedSandboxResume(context.Context, int64, string, string) error {
	p.countedCalls++
	return nil
}

// c240bd3cf7 (#3568) replaced the billing-only wake, in which an idle-slept
// running row reused its counted slot and a suspended row needed a new one,
// with machine admission: billing quota alone is not branch admission. Without
// admission neither row reaches the provider; once admitted, both do.
func TestWorkspaceIdleSleptWakeNeedsAdmission(t *testing.T) {
	startFailed := errors.New("provider start reached")
	for _, status := range []string{"running", "suspended"} {
		t.Run(status, func(t *testing.T) {
			policy := &countedResumePolicy{sandboxPolicyStub: sandboxPolicyStub{entitlement: SandboxEntitlement{IdleTimeoutSecs: 60, HoursPerDay: -1}}}
			starts := 0
			workspace := sampleDBWorkspace("ws-counted")
			workspace.Status = status
			workspace.VmID = "vm-counted"
			service := func() *WorkspaceService {
				return newWorkspaceServiceForTests(&countedResumeStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, workspace: workspace},
					WithWorkspaceBillingPolicy(policy),
					WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
						getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
							return sandbox.Sandbox{ID: workspace.VmID, State: sandbox.StateStopped}, nil
						},
						startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
							starts++
							return sandbox.StartResult{}, startFailed
						},
					}))
			}
			_, err := service().ensureExistingWorkspaceRunning(context.Background(), workspace)
			require.ErrorContains(t, err, "branch wake requires admission and validated privileged entry")
			assert.Zero(t, starts)

			_, err = composeHostedSandboxWake(service(), unopenedBranchTransactions{t}).ensureExistingWorkspaceRunning(context.Background(), workspace)
			require.ErrorContains(t, err, startFailed.Error())
			assert.Equal(t, 1, starts)
		})
	}
}
