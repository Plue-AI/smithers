package services

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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

			// An outside main commit arrives in the mirror. refreshMerged calls
			// follow with this observed tip before folding it into the stack.
			h.git(h.work, "checkout", "-q", "main")
			h.commit("Outside main change", "OUTSIDE.md", "outside\n")
			main := h.publish()
			h.git(h.work, "push", "-q", h.github, "main:refs/heads/main")
			stack, err := h.q.GetMythicalStack(t.Context(), h.repoID)
			require.NoError(t, err)
			require.Equal(t, main, h.hostRef("refs/heads/main"))
			require.NotEqual(t, main, before.CandidateBase)
			// Inspect the follow boundary itself: a full worker poll may both
			// schedule the rebuild and advance it to another execution state.
			step := &mythicalItemStep{s: h.service, q: h.q, now: h.service.now(),
				r: &mythicalRun{row: stack, mainTip: main}, items: []db.MythicalItem{before}}
			after, err := step.follow(t.Context(), before)
			require.NoError(t, err)
			require.NotNil(t, after)
			require.Equal(t, "integrating", after.State, "reviewed TODO must rebuild on the observed new main")
			require.Equal(t, "rebase_pending", after.Reason)
			require.False(t, after.CandidateVerified, "old-base verification cannot authorize the new candidate")
			require.Equal(t, head, after.PRHead, "scheduling alone must not publish an unverified head")
			require.Equal(t, before.CandidateHead, after.CandidateHead, "retain the captured edit until rebuild")
			require.NotNil(t, mythicalChecksOf(*after).Rebase)
			require.Equal(t, main, mythicalChecksOf(*after).Rebase.Onto)
		})
	}
}
