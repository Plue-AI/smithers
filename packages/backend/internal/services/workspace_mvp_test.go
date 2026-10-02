package services

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestWorkspaceCreateRetiresDesktopPreservesComputeKinds(t *testing.T) {
	for _, kind := range []string{"", "container", "vm"} {
		require.NoError(t, validateWorkspaceCreateMetadata(CreateWorkspaceInput{Kind: kind}))
	}
	for _, kind := range []string{"desktop", " desktop ", "unknown"} {
		require.Error(t, validateWorkspaceCreateMetadata(CreateWorkspaceInput{Kind: kind}))
	}
	// A historical row cannot silently provision a VM with the former desktop image.
	service := &WorkspaceService{}
	_, err := service.buildWorkspaceVMRequestWithImage(context.Background(), "", nil, 0, "", "desktop", nil)
	require.Error(t, err)
}
