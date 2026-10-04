package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// A workspace clone is shallow unless the repository opted out. The window has
// to cover the coding flows' 100-commit history read without a deepen.
func TestBuildWorkspaceCloneCommandIsShallowByDefault(t *testing.T) {
	command := buildWorkspaceCloneCommand("https://api.smithers.sh/alice/demo.git", "smithers_token", "main", 0, workspaceCloneSource{})
	assert.Contains(t, command, "git clone --depth 200 --branch 'main' -- ")
	assert.NotContains(t, command, "--filter=", "a blobless clone breaks jj: gix ignores git's promisor remote")
}

func TestBuildWorkspaceCloneCommandHonoursTheRepositoryDepth(t *testing.T) {
	for _, tc := range []struct {
		name  string
		depth int
		want  string
	}{
		{name: "explicit window", depth: 25, want: "git clone --depth 25 --branch 'main' -- "},
		{name: "opted out of shallow clones", depth: sandbox.FullCloneDepth, want: "git clone --branch 'main' -- "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			command := buildWorkspaceCloneCommand("https://api.smithers.sh/alice/demo.git", "tok", "main", tc.depth, workspaceCloneSource{})
			assert.Contains(t, command, tc.want)
			if tc.depth == sandbox.FullCloneDepth {
				assert.NotContains(t, command, "--depth")
			}
		})
	}
}

// Shared branch attachment refuses cross-repository member setup until its
// run-scoped contract exists, rather than cloning into a second machine.
func TestAgentMembersRequireSharedRunBinding(t *testing.T) {
	svc := NewWorkspaceService(&mockWorkspaceQuerier{})
	_, err := svc.CreateAgentWorkspace(context.Background(), CreateAgentWorkspaceInput{
		Members: []sandbox.GitRepositorySpec{{Repo: "https://example.com/acme/lib.git", Rev: "0123456789abcdef0123456789abcdef01234567"}},
	})
	requireBranchMachineUnavailable(t, err)
}
