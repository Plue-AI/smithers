package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A fork child is a fresh sandbox. Before this test the ForkRequest carried no
// size, so every forked derived workspace and agent box was admitted and
// booted at the provider defaults (512 MiB, 1 vCPU) while an identical cold
// create got the configured workspace size. The fork must ask for the same
// size the cold path asks for.
func TestForkWorkspaceSandbox_CarriesConfiguredSizeForKind(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		kind     string
		memoryMB int32
		vcpus    int32
	}{
		{kind: "container", memoryMB: 4096, vcpus: 2},
		{kind: "", memoryMB: 4096, vcpus: 2}, // the default kind is a container
		{kind: "agent", memoryMB: 3072, vcpus: 3},
	} {
		t.Run("kind="+tc.kind, func(t *testing.T) {
			t.Parallel()
			var got sandbox.ForkRequest
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{},
				WithWorkspaceResources(4096, 2),
				WithWorkspaceAgentResources(3072, 3),
				WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
					forkVMFn: func(_ context.Context, _ string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
						got = req
						return sandbox.CreateResult{ID: "vm-fork-child"}, nil
					},
				}))

			_, err := svc.forkWorkspaceSandbox(context.Background(), "vm-primary", "child", tc.kind, nil)
			require.NoError(t, err)
			assert.Equal(t, "container", got.Kind)
			require.NotNil(t, got.MemSizeMB, "fork child must not fall back to the 512 MiB provider default")
			assert.Equal(t, tc.memoryMB, *got.MemSizeMB)
			require.NotNil(t, got.VCPUCount, "fork child must not fall back to the 1 vCPU provider default")
			assert.Equal(t, tc.vcpus, *got.VCPUCount)
		})
	}
}
