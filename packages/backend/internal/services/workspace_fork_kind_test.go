package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// forkKindProbe records whether a provisioning attempt forked or cold-created,
// and what the create request asked for.
type forkKindProbe struct {
	forkedFrom []string
	created    []sandbox.CreateRequest
}

func (p *forkKindProbe) client() *mockWorkspaceSandboxVMClient {
	return &mockWorkspaceSandboxVMClient{
		forkVMFn: func(_ context.Context, sourceVMID string, _ sandbox.ForkRequest) (sandbox.CreateResult, error) {
			p.forkedFrom = append(p.forkedFrom, sourceVMID)
			return sandbox.CreateResult{ID: "vm-fork-child"}, nil
		},
		createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			p.created = append(p.created, req)
			return sandbox.CreateResult{ID: "vm-cold"}, nil
		},
	}
}

func forkKindQuerier() *mockWorkspaceQuerier {
	return &mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			workspace := sampleDBWorkspace(arg.ID)
			workspace.VmID = arg.VmID
			workspace.Status = arg.Status
			return workspace, nil
		},
	}
}

// The controller's fork child carries no kind and no size: it reserves and
// boots the CONTAINER defaults (512 MiB, 1 vCPU) under the container sleep-loop
// entrypoint. A NixOS guest booted that way is dead on arrival whatever its
// size, Services must decline the fork and take the cold sized create path.
func TestTryForkDerivedFromPrimary_DeclinesNonContainerSource(t *testing.T) {
	t.Parallel()

	for _, kind := range []string{"vm"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()

			source := sampleDBWorkspace("ws-primary-" + kind)
			source.Kind = kind
			source.VmID = "vm-primary"

			derived := sampleDBWorkspace("ws-derived-" + kind)
			derived.Kind = kind
			derived.IsFork = true
			derived.VmID = ""

			q := forkKindQuerier()
			q.getActiveWorkspaceForUserRepoKindFn = func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
				return source, nil
			}
			probe := &forkKindProbe{}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(probe.client()))

			_, ok := svc.tryForkDerivedFromPrimary(context.Background(), derived, CreateWorkspaceSessionInput{
				UserID: 1, SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo",
			})
			assert.False(t, ok, "a %s box must fall through to the cold sized create path", kind)
			assert.Empty(t, probe.forkedFrom, "a %s source must never be forked", kind)
		})
	}
}

// Control: container boxes keep the fast fork exactly as before.
func TestTryForkDerivedFromPrimary_ContainerSourceStillForks(t *testing.T) {
	t.Parallel()

	source := sampleDBWorkspace("ws-primary-container")
	source.VmID = "vm-primary"

	derived := sampleDBWorkspace("ws-derived-container")
	derived.IsFork = true
	derived.VmID = ""

	q := forkKindQuerier()
	q.getActiveWorkspaceForUserRepoKindFn = func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
		return source, nil
	}
	probe := &forkKindProbe{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(probe.client()))

	got, ok := svc.tryForkDerivedFromPrimary(context.Background(), derived, CreateWorkspaceSessionInput{
		UserID: 1, SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo",
	})
	require.True(t, ok)
	assert.Equal(t, "vm-fork-child", got.VmID)
	assert.Equal(t, []string{"vm-primary"}, probe.forkedFrom)
	assert.Empty(t, probe.created, "the fork fast path must not cold-create")
}

// The pair/explicit fork path has the same defect and the same remedy: cold
// create, which is the only path that applies the desktop size and the NixOS
// boot.

// Control: a container pair fork is untouched.
func TestForkWorkspaceVM_ContainerSourceStillForks(t *testing.T) {
	t.Parallel()

	source := sampleDBWorkspace("ws-container-source")
	source.VmID = "vm-container-primary"
	fork := sampleDBWorkspace("ws-container-fork")
	fork.VmID = ""

	probe := &forkKindProbe{}
	svc := newWorkspaceServiceForTests(forkKindQuerier(), WithWorkspaceSandboxClient(probe.client()))

	got, err := svc.forkWorkspaceVM(context.Background(), fork, source)
	require.NoError(t, err)
	assert.Equal(t, []string{"vm-container-primary"}, probe.forkedFrom)
	assert.Empty(t, probe.created)
	assert.Equal(t, "vm-fork-child", got.VmID)
}

// agentForkKindQuerier adds the optional agent surface so agentForkSource takes
// its bookmark-candidate branch.
type agentForkKindQuerier struct {
	*mockWorkspaceQuerier
	candidates []db.Workspace
	primary    db.Workspace
}

func (a *agentForkKindQuerier) ListRunningWorkspacesForUserRepoBookmark(context.Context, db.ListRunningWorkspacesForUserRepoBookmarkParams) ([]db.Workspace, error) {
	return a.candidates, nil
}

func (a *agentForkKindQuerier) SetAgentSessionWorkspace(context.Context, db.SetAgentSessionWorkspaceParams) error {
	return nil
}

func (a *agentForkKindQuerier) GetActiveWorkspaceForUserRepo(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
	return a.primary, nil
}

// An agent run's computer is a container guest. Forking a vm box into
// it produces the same dead 512 MiB container, so both the bookmark candidate
// and the primary fallback must be rejected on kind.
func TestAgentForkSource_DeclinesNonContainerSources(t *testing.T) {
	t.Parallel()

	agent := sampleDBWorkspace("ws-agent")
	agent.Kind = "agent"
	agent.VmID = ""

	deskCandidate := sampleDBWorkspace("ws-desktop-candidate")
	deskCandidate.Kind = "desktop"
	deskCandidate.VmID = "vm-desktop-candidate"
	vmPrimary := sampleDBWorkspace("ws-vm-primary")
	vmPrimary.Kind = "vm"
	vmPrimary.VmID = "vm-vm-primary"

	q := &agentForkKindQuerier{
		mockWorkspaceQuerier: forkKindQuerier(),
		candidates:           []db.Workspace{deskCandidate},
		primary:              vmPrimary,
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	_, _, ok := svc.agentForkSource(context.Background(), agent, "main")
	assert.False(t, ok, "no non-container box may be an agent fork source")
}

// Control: a container candidate on the same bookmark is still chosen.
func TestAgentForkSource_ContainerCandidateStillWins(t *testing.T) {
	t.Parallel()

	agent := sampleDBWorkspace("ws-agent-container")
	agent.Kind = "agent"
	agent.VmID = ""

	candidate := sampleDBWorkspace("ws-container-candidate")
	candidate.VmID = "vm-container-candidate"

	q := &agentForkKindQuerier{
		mockWorkspaceQuerier: forkKindQuerier(),
		candidates:           []db.Workspace{candidate},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))

	source, sameBookmark, ok := svc.agentForkSource(context.Background(), agent, "main")
	require.True(t, ok)
	assert.True(t, sameBookmark)
	assert.Equal(t, "vm-container-candidate", source.VmID)
}
