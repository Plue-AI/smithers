package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
	"testing"
)

// These are dark-consumer unit tests, not the PostgreSQL/reset qualification
// journey. No stack attention or durable reset provider exists in this checkout.
func TestInstallMainPullAlwaysFollowsWithoutDeclaration(t *testing.T) {
	for _, policy := range []string{"undeclared", "none", "push", "pull"} {
		t.Run(policy, func(t *testing.T) {
			h := newPullHarness(t)
			h.policy = policy
			qualifyMainPullFixture(h.service)
			out := h.service.pull(t.Context(), db.GithubMainPull{RepositoryID: 19})
			require.Equal(t, "synced", out.state)
			require.Equal(t, "pull", out.policy)
			require.Equal(t, 0, h.policyReads)
			require.Equal(t, pullNew, h.host.bookmarkSnapshot("main"))
			// On an install the pull is the GitHub sync and presents its
			// authority, the only one the install engine admits for main.
			require.Len(t, h.host.meta, 1)
			require.Equal(t, middleware.CredentialSync, h.host.meta[0].PusherCredential)
		})
	}
}

func TestInstallMainPullForcePushBindsTipsWithoutWriting(t *testing.T) {
	h := newPullHarness(t)
	qualifyMainPullFixture(h.service)
	h.git.ancestor = false
	out := h.service.pull(t.Context(), db.GithubMainPull{RepositoryID: 19})
	require.Equal(t, &GitHubMainForcePush{Old: pullOld, New: pullNew}, out.forcePush)
	require.Equal(t, "force_push", out.err)
	require.Equal(t, pullOld, h.host.bookmarkSnapshot("main"))
	require.Error(t, h.service.ResetToGitHub(t.Context(), 19, pullOld, pullNew))
	require.Equal(t, pullOld, h.host.bookmarkSnapshot("main"))
	require.Contains(t, out.forcePush.Error(), pullNew)
}
