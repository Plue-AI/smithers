package compose

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

type ownerOnly struct{ owner int64 }

func (o ownerOnly) AuthorizeMember(_ context.Context, userID int64) *pkgerrors.APIError {
	if userID != o.owner {
		return pkgerrors.Forbidden("not the owner")
	}
	return nil
}

// guestMicroVM is a microVM runtime whose guests run repository code as agent.
type guestMicroVM struct{ isolatedRuntime }

func (guestMicroVM) GuestIdentity() (string, int) { return "agent", 19999 }

// The install composes its own branch machine providers only on a
// single-owner microVM runtime; injected providers stay a trusted-process
// test seam, and no composition takes both.
func TestComposeBranchMachines(t *testing.T) {
	trusted := isolatedRuntime{isolation: workspace.IsolationTrustedProcess}
	microVM := guestMicroVM{isolatedRuntime{isolation: workspace.IsolationSandboxed}}
	injected := &services.BranchMachineProviders{}
	for _, tc := range []struct {
		name    string
		options Options
		hosted  bool
		want    string
		install bool
	}{
		{name: "neither keeps machines dark", options: Options{Workspace: microVM}},
		{name: "both", options: Options{Workspace: trusted, BranchMachines: injected, InstallBranchMachines: true},
			want: "branch machine providers are injected or the install's, not both"},
		{name: "injected on trusted process", options: Options{Workspace: trusted, BranchMachines: injected}},
		{name: "injected on a microVM", options: Options{Workspace: microVM, BranchMachines: injected},
			want: "injected branch machine providers are for the trusted-process runtime only"},
		{name: "injected without a runtime", options: Options{BranchMachines: injected},
			want: "injected branch machine providers are for the trusted-process runtime only"},
		{name: "install on a microVM", options: Options{Workspace: microVM, InstallBranchMachines: true}, install: true},
		{name: "install on trusted process", options: Options{Workspace: trusted, InstallBranchMachines: true},
			want: "install branch machines require the microVM workspace runtime"},
		{name: "install without a runtime", options: Options{InstallBranchMachines: true},
			want: "install branch machines require the microVM workspace runtime"},
		{name: "install on a hosted deployment", options: Options{Workspace: microVM, InstallBranchMachines: true}, hosted: true,
			want: "install branch machines require a single-owner install"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			providers, err := composeBranchMachines(tc.options, tc.hosted, ownerOnly{owner: 7})
			if tc.want != "" {
				require.EqualError(t, err, tc.want)
				require.Nil(t, providers)
				return
			}
			require.NoError(t, err)
			switch {
			case tc.options.BranchMachines != nil:
				require.Same(t, injected, providers)
			case !tc.install:
				require.Nil(t, providers)
			default:
				require.NotNil(t, providers)
				ctx := context.Background()
				require.NoError(t, providers.MicroVM(ctx))
				require.NoError(t, providers.SessionIdentity(ctx))
				require.NoError(t, providers.Authorize(ctx, nil, "branch.join", 1, "scratch/owner/a", 7))
				require.Error(t, providers.Authorize(ctx, nil, "branch.join", 1, "scratch/owner/a", 8))
				require.NotNil(t, providers.Membership)
				require.NotNil(t, providers.LaneBinding)
			}
		})
	}
}
