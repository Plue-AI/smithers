package services

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

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

// Changeset members are pinned to an exact commit, which can sit behind the
// shallow boundary. The checkout must recover rather than fail the workspace.
func TestBuildAgentMemberCloneCommandDeepensForAPinnedRevision(t *testing.T) {
	command := buildAgentMemberCloneCommand([]sandbox.GitRepositorySpec{{
		Repo: "https://api.smithers.sh/acme/lib.git",
		Path: "/home/developer/workspace/acme/lib",
		Rev:  "0123456789abcdef0123456789abcdef01234567",
	}})
	assert.Contains(t, command, "git clone --quiet --depth 200 ")
	assert.Contains(t, command, "fetch --quiet --unshallow origin")
	require.Equal(t, 2, strings.Count(command, "checkout --quiet --detach"),
		"the pinned checkout is attempted once, then retried after deepening")
}

func TestBuildAgentMemberCloneCommandHonoursAFullHistoryMember(t *testing.T) {
	command := buildAgentMemberCloneCommand([]sandbox.GitRepositorySpec{{
		Repo:  "https://api.smithers.sh/acme/lib.git",
		Path:  "/home/developer/workspace/acme/lib",
		Depth: sandbox.FullCloneDepth,
	}})
	assert.Contains(t, command, "git clone --quiet '")
	assert.NotContains(t, command, "--depth")
}
