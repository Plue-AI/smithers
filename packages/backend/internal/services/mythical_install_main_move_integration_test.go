package services

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
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
			checks := mythicalChecksOf(before)
			checks.Land = &mythicalLand{Head: head, Generation: before.Generation}
			before.Checks = checks.encode()
			before.PRHead = head
			before, err = h.q.SaveMythicalItem(t.Context(), before)
			require.NoError(t, err)
			writes := len(h.writes())
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
			require.Nil(t, mythicalChecksOf(*after).Land, "a previous head's approval cannot survive rebuilding")
			require.Equal(t, head, mythicalChecksOf(*after).ApprovalCleared)
			require.Len(t, h.writes(), writes, "scheduling cannot write to GitHub")
			if !install {
				return
			}
			for _, held := range []string{"foreign push", "pending merge", "pending push", "paused", "same base"} {
				t.Run(held, func(t *testing.T) {
					input := before
					switch held {
					case "foreign push":
						checks := mythicalChecksOf(input)
						checks.ForeignHead = main
						input.Checks = checks.encode()
					case "pending merge":
						input.PendingOp = []byte(`{"kind":"merge","state":"unknown"}`)
					case "pending push":
						input.PendingOp = []byte(`{"kind":"push","state":"unknown"}`)
					case "paused":
						input.PausedAt = pgtype.Timestamptz{Time: step.now, Valid: true}
					case "same base":
						input.CandidateBase = main
					}
					current, err := h.q.GetMythicalItem(t.Context(), input.ID)
					require.NoError(t, err)
					input.Version = current.Version
					input, err = h.q.SaveMythicalItem(t.Context(), input)
					require.NoError(t, err)
					next, err := step.follow(t.Context(), input)
					require.NoError(t, err)
					require.NotNil(t, next)
					require.Equal(t, "proposed", next.State)
					require.Equal(t, input.CandidateVerified, next.CandidateVerified)
					require.Equal(t, input.CandidateHead, next.CandidateHead)
					require.Equal(t, input.PendingOp, next.PendingOp)
					require.Nil(t, mythicalChecksOf(*next).Rebase)
					require.Equal(t, mythicalChecksOf(input).Land, mythicalChecksOf(*next).Land)
					require.Len(t, h.writes(), writes)
				})
			}
		})
	}
}
