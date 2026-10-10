package compose

import (
	"context"
	"errors"
	"fmt"
	"io/fs"

	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// The trusted-process machines are the branch machines and machine images
// of the trusted-process runtime, which only tests compose: the Go journey
// rehearsal injects them (Options.BranchMachines, Options.MachineImages) and
// the backend's test binary selects them (Options.TrustedProcessMachines). An
// install bundle composes its microVM runtime's own instead
// (Options.InstallBranchMachines, installMachineImages).

// trustedProcessBranchMachines are the install's branch machine providers
// (services.InstallBranchMachineProviders): its roster, the one member
// authorizer and the stack's lane binding, read in the creating transaction.
// The trusted-process runtime isolates nothing, so its microVM (R1-R5) and
// guest identity providers admit.
func trustedProcessBranchMachines(members identity.MemberAuthorizer) *services.BranchMachineProviders {
	providers := services.InstallBranchMachineProviders(members, nil)
	providers.MicroVM = func(context.Context) error { return nil }
	providers.SessionIdentity = func(context.Context) error { return nil }
	return &providers
}

// errTrustedProcessMachines is every refusal of Options.TrustedProcessMachines
// outside the one composition that may select them.
var errTrustedProcessMachines = errors.New("trusted-process machines are for a single-owner test composition on the trusted-process runtime only")

// validateTrustedProcessMachines admits Options.TrustedProcessMachines only
// beside the trusted-process runtime and the Flow host test exception, and
// with no other machine provider or image adapter. hosted is unknown before
// the configuration loads; composeBranchMachines checks it then.
func validateTrustedProcessMachines(options Options) error {
	if !options.TrustedProcessMachines {
		return nil
	}
	if options.BranchMachines != nil || options.MachineImages != nil || options.InstallBranchMachines || options.HostedBranchMachines {
		return fmt.Errorf("%w: it takes no other branch machine provider or image adapter", errTrustedProcessMachines)
	}
	if !options.FlowHostConfig.AllowTrustedProcessForTests {
		return fmt.Errorf("%w: the Flow host test exception is unset", errTrustedProcessMachines)
	}
	if options.Workspace == nil || options.Workspace.Isolation() != workspace.IsolationTrustedProcess {
		return fmt.Errorf("%w: the workspace runtime isolates", errTrustedProcessMachines)
	}
	if _, builds := options.Workspace.(services.InstallMachineLayerBuilder); builds {
		return fmt.Errorf("%w: the workspace runtime builds its own images", errTrustedProcessMachines)
	}
	if options.Repository == nil {
		return fmt.Errorf("%w: no repository engine reads main's recipe", errTrustedProcessMachines)
	}
	return nil
}

// trustedProcessImages is the machine image adapter for the trusted-process
// runtime. Its machines run on the host toolchain, so it can provide only the
// base image: it reads main's recipe through the mirror and refuses one that
// needs a layer (a target index, image additions or a detected toolchain).
// "6 machine ready" therefore proves setup admission, persistence and
// fencing, not an image build.
type trustedProcessImages struct {
	sources workspace.SourceFiles
}

func (images trustedProcessImages) ResolveWorkspaceLayer(ctx context.Context, spec workspace.WorkspaceSpec) (microsandbox.Layer, error) {
	if spec.Source == nil || spec.Source.Repository == "" || len(spec.Source.Revision) != 40 {
		return microsandbox.Layer{}, fmt.Errorf("a machine image needs main's resolved revision")
	}
	read := func(path string) ([]byte, bool, error) {
		data, err := images.sources.ReadSourceFile(ctx, *spec.Source, path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return data, err == nil, err
	}
	_, indexed, err := read(".smithers/target-index.json")
	if err != nil {
		return microsandbox.Layer{}, err
	}
	machine, err := microsandbox.ReadMachineJSON(read)
	if err != nil {
		return microsandbox.Layer{}, err
	}
	recipe, err := microsandbox.DetectRecipe(read)
	if err != nil {
		return microsandbox.Layer{}, err
	}
	if indexed || len(machine.Packages) > 0 || len(recipe.Tools) > 0 {
		return microsandbox.Layer{}, fmt.Errorf("main's recipe needs an image layer; the trusted-process runtime provides only the base image")
	}
	return microsandbox.Layer{}, nil
}
