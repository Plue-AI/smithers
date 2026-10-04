package compose

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// processRuntime stands in for a workspace runtime without an image builder
// (the trusted-process runtime); imageRuntime for one that builds images (the
// bundled microVM runtime). Neither method set is called here.
type processRuntime struct{ workspaceapi.WorkspaceRuntime }
type imageRuntime struct{ workspaceapi.WorkspaceRuntime }

func (imageRuntime) ResolveWorkspaceLayer(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	return microsandbox.Layer{}, errors.New("the bundled layer builder is never bound to setup")
}

type injectedImages struct{}

func (injectedImages) ResolveWorkspaceLayer(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
	return microsandbox.Layer{}, nil
}

// T-INS-06 R4: setup step 6 binds only an injected adapter. A runtime that
// builds images never reaches setup on its own (the install bundle answers
// 503), and an adapter beside it is refused.
func TestInstallMachineImagesBindOnlyAnInjectedAdapter(t *testing.T) {
	for name, test := range map[string]struct {
		options Options
		want    services.InstallMachineLayerBuilder
		wantErr string
	}{
		"bundle runtime alone stays dark": {options: Options{Workspace: imageRuntime{}}},
		"no runtime":                      {options: Options{}},
		"process runtime alone":           {options: Options{Workspace: processRuntime{}}},
		"adapter for a process runtime":   {options: Options{Workspace: processRuntime{}, MachineImages: injectedImages{}}, want: injectedImages{}},
		"adapter beside an image runtime": {options: Options{Workspace: imageRuntime{}, MachineImages: injectedImages{}}, wantErr: "machine images belong to the workspace runtime"},
	} {
		t.Run(name, func(t *testing.T) {
			images, err := installMachineImages(test.options)
			if test.wantErr != "" {
				require.EqualError(t, err, test.wantErr)
				require.Nil(t, images)
				return
			}
			require.NoError(t, err)
			require.Equal(t, test.want, images)
		})
	}
}

// The refusal precedes configuration, storage and the listener.
func TestStartRefusesMachineImagesBesideAnImageRuntime(t *testing.T) {
	served := false
	err := StartWithOptions(t.Context(), []string{"-unknown-flag"}, io.Discard, io.Discard, Options{Workspace: imageRuntime{}, MachineImages: injectedImages{}}, func(http.Handler) { served = true })
	require.EqualError(t, err, "machine images belong to the workspace runtime")
	require.False(t, served)
	// Control: the same start with an acceptable pairing passes the guard and
	// stops at the next startup check, the flag parser.
	err = StartWithOptions(t.Context(), []string{"-unknown-flag"}, io.Discard, io.Discard, Options{Workspace: processRuntime{}, MachineImages: injectedImages{}}, func(http.Handler) { served = true })
	var parse *flagParseError
	require.ErrorAs(t, err, &parse)
	require.False(t, served)
}
