package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// RFD-004 regression: an agent workspace is a container guest. Prod refused
// the first agent run with "no NixOS environment image is registered for
// kind agent" because the NixOS gates compared normalizeWorkspaceKind
// against "container" and the new agent kind fell through to the resolver.
type failingEnvironmentImageResolver struct{ t *testing.T }

func (r *failingEnvironmentImageResolver) Resolve(_ context.Context, _ int64, kind string) (runtimeports.SandboxEnvironmentImage, error) {
	r.t.Fatalf("environment image resolver must not be consulted for kind %q", kind)
	return runtimeports.SandboxEnvironmentImage{}, nil
}

func (r *failingEnvironmentImageResolver) Pinned(_ context.Context, _ int64, kind, _ string) (runtimeports.SandboxEnvironmentImage, error) {
	r.t.Fatalf("environment image resolver must not be consulted for kind %q", kind)
	return runtimeports.SandboxEnvironmentImage{}, nil
}

func TestAgentWorkspaceKindNeverResolvesANixImage(t *testing.T) {
	t.Parallel()
	svc := NewWorkspaceService(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(&failingEnvironmentImageResolver{t: t}))
	req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 1, "", "agent")
	require.NoError(t, err)
	assert.Equal(t, "container", req.Kind, "the sandbox request boots the ordinary container guest")
	assert.Empty(t, req.Image)
	assert.NotEmpty(t, req.Packages, "container boots keep the apt toolchain")

	// No registry at all: an agent workspace must still provision.
	bare := NewWorkspaceService(&mockWorkspaceQuerier{})
	_, err = bare.buildWorkspaceVMRequest(context.Background(), "", nil, 1, "", "agent")
	require.NoError(t, err)
}

func TestSandboxEnvironmentImageService_ResolveTreatsAgentAsContainer(t *testing.T) {
	t.Parallel()
	svc := NewSandboxEnvironmentImageService(nil)
	svc.q = &mockSandboxEnvironmentImageQuerierNoop{}
	_, err := svc.Resolve(context.Background(), 0, "agent")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err), "agent resolves like container: a bad request, not a missing-image conflict")
}

type mockSandboxEnvironmentImageQuerierNoop struct{ SandboxEnvironmentImageQuerier }
