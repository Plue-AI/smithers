package compose

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// A TODO sealed while its predecessor publishes must retain the predecessor's
// bytes in both its candidate and native branch before following a squash merge.
// The person's TODO/answer HTTP doors, native daemon, checks and GitHub sync are
// composed; GitHub fake supplies the upstream person's merge.
func TestNextTodoRetainsMergedPrefixRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J4_REHEARSAL", "C-STK-next-prefix", "next-prefix-")
	require.True(t, r.install("Install through Machine ready"))
	first, err := r.file("First change", "[PR] [FILE FIRST.md] Add the first change.")
	require.NoError(t, err)
	next, err := r.file("Next change", "[ASK] [FILE NEXT.md] Add the next change.")
	require.NoError(t, err)
	firstCard, err := r.waitTodoWithin(first, 8*time.Minute, "in_review")
	require.NoError(t, err)
	nextCard, err := r.waitTodoWithin(next, 4*time.Minute, "needs_you")
	require.NoError(t, err)
	require.NotEmpty(t, nextCard.Waits)
	code, data, err := r.answer(next, nextCard.Waits[0].ID, "Say hello in French")
	require.NoError(t, err)
	require.Equal(t, 202, code, "%s", data)
	nextCard, err = r.waitTodoWithin(next, 8*time.Minute, "in_review")
	require.NoError(t, err)
	pullBefore, err := r.readFakePull(nextCard.PR.Number)
	require.NoError(t, err)
	_, err = r.fakeControl("/_fake/merge", map[string]any{"repo": "rehearsal-owner/app", "number": firstCard.PR.Number})
	require.NoError(t, err)
	deadline := time.Now().Add(4 * time.Minute)
	for {
		card, err := r.todo(next)
		require.NoError(t, err)
		if card.State == "in_review" && card.Merge.State == "ready" && !card.PR.Draft {
			require.Equal(t, pullBefore.Number, card.PR.Number)
			pull, err := r.readFakePull(card.PR.Number)
			require.NoError(t, err)
			paths, err := r.prFiles(pull)
			require.NoError(t, err)
			require.Equal(t, []string{"NEXT.md"}, paths, "the next PR must preserve the merged predecessor")
			return
		}
		require.True(t, time.Now().Before(deadline), "next TODO did not follow the merged prefix: %+v", card)
		time.Sleep(500 * time.Millisecond)
	}
}
