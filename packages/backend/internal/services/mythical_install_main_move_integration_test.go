package services

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The fetched PR cache owns GitHub observations, but changing polling paths
// must not lose the stack's obligation to rebuild an already-reviewed TODO
// when its base moves. The legacy case is a control for the same fixture.
func TestReviewedTodoMainMoveSchedulesRebuild(t *testing.T) {
	for _, install := range []bool{false, true} {
		name := "legacy"
		if install {
			name = "install"
		}
		t.Run(name, func(t *testing.T) {
			h := newMergeHarness(t)
			n, head, _ := h.first("Reviewed change")
			for range 4 {
				if len(h.item(n).PendingOp) == 0 {
					break
				}
				h.pass()
			}
			before := h.item(n)
			require.Empty(t, before.PendingOp)
			require.Equal(t, "proposed", before.State)
			require.True(t, before.CandidateVerified)
			if install {
				synced, _ := configureInboundPullPolling(t, h.publicationFixture)
				defer runFetchedFixture(t, synced)()
			}

			// An outside main commit arrives in the mirror. The stack must fold
			// that commit before scheduling the reviewed candidate's rebuild.
			h.git(h.work, "checkout", "-q", "main")
			h.commit("Outside main change", "OUTSIDE.md", "outside\n")
			main := h.publish()
			h.git(h.work, "push", "-q", h.github, "main:refs/heads/main")
			h.pass()
			stack, err := h.q.GetMythicalStack(t.Context(), h.repoID)
			require.NoError(t, err)
			require.Equal(t, main, stack.LandedMain)
			h.pass()

			after := h.item(n)
			require.Equal(t, "integrating", after.State, "reviewed TODO must rebuild on the newly folded main")
			require.Equal(t, "rebase_pending", after.Reason)
			require.False(t, after.CandidateVerified, "old-base verification cannot authorize the new candidate")
			require.Equal(t, head, after.PRHead, "scheduling alone must not publish an unverified head")
			require.Equal(t, before.CandidateHead, after.CandidateHead, "retain the captured edit until rebuild")
			require.NotNil(t, mythicalChecksOf(after).Rebase)
			require.Equal(t, main, mythicalChecksOf(after).Rebase.Onto)
		})
	}
}
