package services

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// pinRuntime records every create and boots nothing further.
type pinRuntime struct {
	workspaceapi.WorkspaceRuntime
	images bool
	specs  []workspaceapi.WorkspaceSpec
}

func (r *pinRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{EnvironmentImages: r.images}
}

func (r *pinRuntime) CreateWorkspace(_ context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	r.specs = append(r.specs, spec)
	return workspaceapi.Workspace{}, workspaceapi.ErrWorkspaceStopped
}

// A workspace created with a closure (a factory lane placed on the
// repository's NixOS image) boots exactly that image, or is not created:
// neither a newer image nor the platform base stands in, and a runtime that
// cannot boot environment images is never handed one.
func TestRuntimeWorkspaceBootsItsPinnedImage(t *testing.T) {
	ctx := context.Background()
	closure := strings.Repeat("c", 32)
	placed := nixTestImage("vm")
	placed.ClosureHash, placed.Image = closure, "registry/env:"+closure
	desktop := nixTestImage("desktop")
	desktop.ClosureHash = closure
	for _, tc := range []struct {
		name     string
		kind     string
		closure  string
		images   bool
		resolver *stubEnvironmentImageResolver
		want     *workspaceapi.WorkspaceEnvironmentImage
		refused  bool
	}{
		{name: "the placed image", kind: "vm", closure: closure, images: true, resolver: &stubEnvironmentImageResolver{image: placed},
			want: &workspaceapi.WorkspaceEnvironmentImage{Kind: "vm", Image: placed.Image, ClosureHash: closure}},
		{name: "a placed desktop", kind: "desktop", closure: closure, images: true, resolver: &stubEnvironmentImageResolver{image: desktop},
			want: &workspaceapi.WorkspaceEnvironmentImage{Kind: "desktop", Image: desktop.Image, ClosureHash: closure}},
		{name: "a retired image", kind: "vm", closure: strings.Repeat("d", 32), images: true, resolver: &stubEnvironmentImageResolver{image: placed}, refused: true},
		{name: "a runtime without images", kind: "vm", closure: closure, resolver: &stubEnvironmentImageResolver{image: placed}, refused: true},
		{name: "no image registry", kind: "vm", closure: closure, images: true, refused: true},
		{name: "an unpinned vm", kind: "vm", images: true, resolver: &stubEnvironmentImageResolver{image: placed}},
		{name: "a container", kind: "container", closure: closure, images: true, resolver: &stubEnvironmentImageResolver{image: placed}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &pinRuntime{images: tc.images}
			options := []WorkspaceServiceOption{WithWorkspaceRuntime(runtime)}
			if tc.resolver != nil {
				options = append(options, WithWorkspaceEnvironmentImages(tc.resolver))
			}
			service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, options...)
			row := sampleDBWorkspace("ws-lane")
			row.Status, row.VmID, row.Kind, row.EnvironmentClosureHash = "starting", "", tc.kind, tc.closure
			_, err := service.ensureRuntimeWorkspaceRunningLocked(ctx, row, row.UserID)
			require.Error(t, err)
			if tc.refused {
				var api *pkgerrors.APIError
				require.ErrorAs(t, err, &api)
				assert.Equal(t, pkgerrors.CodeEnvironmentImageUnavailable, api.Code)
				assert.Empty(t, runtime.specs, "nothing boots in its place")
				if tc.resolver != nil && !tc.images {
					assert.Empty(t, tc.resolver.calls, "the registry is not consulted for a runtime that cannot boot it")
				}
				return
			}
			require.Len(t, runtime.specs, 1)
			assert.Equal(t, row.ID, runtime.specs[0].ID)
			assert.Equal(t, tc.want, runtime.specs[0].Environment)
			if tc.want == nil && tc.resolver != nil {
				assert.Empty(t, tc.resolver.calls, "an unpinned workspace resolves no image")
			}
		})
	}
}
