package compose

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Exercise the composed install's HTTP TODO doors, GitHub polling, retained
// branches, stack worker, engine verification and publication. GitHub's fake
// performs the person's merge; the install only follows its new main.
func TestStackFollowsMainRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_FOLLOW_MAIN_REHEARSAL", "C-STK-follow-main", "follow-main-")
	if !r.install("Install through Machine ready") {
		return
	}
	first, err := r.file("First change", "[PR] [FILE FIRST.md] Add the first change.")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(first, 8*time.Minute, "in_review")
	require.NoError(t, err)
	second, err := r.file("Next change", "[PR] [FILE NEXT.md] Add the next change.")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(second, 8*time.Minute, "in_review")
	require.NoError(t, err)
	before, err := r.candidate(second)
	require.NoError(t, err)
	card, err := r.j10Card(second)
	require.NoError(t, err)
	pr, oldHead := card.PR.Number, card.PR.Head
	// A reviewed item has released its execution binding. Its retained coding
	// branch is still the subject of presence and captured-head rebases.
	var workspace string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1`, second).Scan(&workspace))
	require.Empty(t, workspace)
	firstCard, err := r.todo(first)
	require.NoError(t, err)
	_, err = r.fakeControl("/_fake/merge", map[string]any{"repo": "rehearsal-owner/app", "number": firstCard.PR.Number})
	require.NoError(t, err)
	_, err = r.waitTodoWithin(first, time.Minute, "merged")
	require.NoError(t, err)
	main, err := r.githubMain()
	require.NoError(t, err)
	// 60 s bounds following main, independently of the checks and PR write.
	deadline := time.Now().Add(time.Minute)
	for {
		after, err := r.candidate(second)
		require.NoError(t, err)
		if after.Base == main {
			break
		}
		require.True(t, time.Now().Before(deadline), "T%d stayed %s %q on %s after main moved to %s", second, after.State, after.Reason, after.Base, main)
		time.Sleep(time.Second)
	}
	deadline = time.Now().Add(8 * time.Minute)
	for {
		card, err = r.j10Card(second)
		require.NoError(t, err)
		pull, err := r.readFakePull(pr)
		require.NoError(t, err)
		parent, err := r.githubGit("rev-parse", pull.Head.SHA+"^")
		require.NoError(t, err)
		if card.State == "in_review" && card.Merge.State == "ready" && !pull.Draft && parent == main && card.PR.Head == pull.Head.SHA && pull.Head.SHA != oldHead {
			after, err := r.candidate(second)
			require.NoError(t, err)
			require.Equal(t, before.Verifies+1, after.Verifies)
			require.True(t, after.Verified)
			require.Equal(t, pr, card.PR.Number)
			require.NotContains(t, pull.Body, fmt.Sprintf("[T%d]", first))
			paths, err := r.githubGit("diff", "--name-only", main, pull.Head.SHA)
			require.NoError(t, err)
			require.Equal(t, "NEXT.md", paths, "the updated PR contains only the next item's change")
			break
		}
		require.True(t, time.Now().Before(deadline), "T%d did not publish its rebased PR: %+v", second, card)
		time.Sleep(time.Second)
	}
	require.Zero(t, r.appMergeWrites(firstCard.PR.Number))
}
