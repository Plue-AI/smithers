package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A boot contract that waits for readiness must declare which service emits
// the readiness signal.
func TestBuildWorkspaceVMRequest_DeclaresReadySignalEmitter(t *testing.T) {
	t.Parallel()

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", "container")
	require.NoError(t, err)

	require.NotNil(t, req.WaitForReady)
	require.True(t, *req.WaitForReady, "workspace VMs gate on the ready signal")
	require.NotNil(t, req.Init, "workspace sandboxes boot with an init config")

	emitsReadySignal := false
	for _, unit := range req.Init.Services {
		if unit.ReadySignal != nil && *unit.ReadySignal {
			emitsReadySignal = true
		}
	}
	assert.True(t, emitsReadySignal,
		"WaitForReady requires one init service with ReadySignal:true")
}

// TestWorkspaceService_CreateSession_ReturnsPromptlyWhileProvisioningContinues
// The session flow returns promptly while provisioning continues in the
// background; clients observe progress through the session ticket.
func TestWorkspaceService_CreateSession_ReturnsPromptlyWhileProvisioningContinues(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	const simulatedBootDelay = 3 * time.Second

	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			// A slow-but-successful boot, like a real Microsandbox VM waiting on
			// its ready signal.
			select {
			case <-time.After(simulatedBootDelay):
			case <-ctx.Done():
			}
			return sandbox.CreateResult{ID: "vm-slow-boot"}, nil
		},
	}), withProductionProvisionGrace)

	start := time.Now()
	session, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: f.repo,
		UserID:       f.user,
	})
	elapsed := time.Since(start)

	require.NoError(t, err)
	assert.Less(t, elapsed, 1500*time.Millisecond,
		"CreateSession must return promptly and provision in the background; it blocked %s waiting for the VM boot, which is what drives the prod ~2m05s hang and 504", elapsed)
	assert.NotEqual(t, "running", session.Status, "the prompt answer is the pending ticket")
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
	assert.Equal(t, []string{"running"}, f.sessionStatuses(t, "main"), "background provisioning settles the ticket")
}

// TestWorkspaceService_CreateSession_PersistsVMIDWhenCloneFails pins failure
// attributability: once Microsandbox returns a VM id, that id must be persisted
// on the workspace row as early as possible. Today the id is only stored after
// the repo clone succeeds, so every clone-time failure leaves vm_id="" — the
// exact unattributable rows observed in prod since 2026-06-29.
func TestWorkspaceService_CreateSession_PersistsVMIDWhenCloneFails(t *testing.T) {
	t.Parallel()
	f := newBranchMachineFixture(t)

	cloneFailed := int32(1)
	metrics := &workspaceProvisioningCovMetrics{}
	svc := f.service(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-clone-fail"}, nil
		},
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			// The VM booted fine but the in-VM repo clone failed. Artifact
			// staging, which runs first when the host has a jj export helper
			// (as CI does), succeeds: a failure there deletes the VM instead.
			if !strings.Contains(req.Command, workspaceCloneMarker) {
				ok := int32(0)
				return sandbox.ExecResult{StatusCode: &ok}, nil
			}
			return sandbox.ExecResult{StatusCode: &cloneFailed, Stderr: "fatal: could not read from remote repository"}, nil
		},
	}), WithWorkspaceSandboxMetrics(metrics))

	_, err := svc.CreateSession(context.Background(), CreateWorkspaceSessionInput{
		RepositoryID: f.repo,
		UserID:       f.user,
		RepoOwner:    "alice",
		RepoName:     "demo",
	})
	require.Error(t, err, "clone failure must still fail the session")

	rows := f.branch(t, "main")
	require.Len(t, rows, 1)
	assert.Equal(t, "vm-clone-fail", rows[0].VmID,
		"the Microsandbox VM id must be persisted on the workspace row as soon as it is known; losing it on clone failure leaves the unattributable vm_id=\"\" rows seen in prod")
	assert.Contains(t, metrics.sessionProvisionStatuses, "failed",
		"workspace session provisioning failures must emit the alertable failed metric")
}
