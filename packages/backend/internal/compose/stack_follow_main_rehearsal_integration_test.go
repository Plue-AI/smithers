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
	// The Linux file provider is the existing journey fixture; this covers
	// stack/capture/sync/publication, not authenticated guest agent writes.
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
	// Review releases the coding lane after its durable native capture. The
	// retained branch remains the item's authority while its machine sleeps.
	var workspace string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT l.workspace_id FROM mythical_lanes l JOIN mythical_items i ON i.id=l.item_id WHERE i.number=$1 AND l.name NOT LIKE '% review g%' ORDER BY l.created_at DESC LIMIT 1`, second).Scan(&workspace))
	require.NotEmpty(t, workspace)
	firstCard, err := r.todo(first)
	require.NoError(t, err)
	movedAt := time.Now()
	_, err = r.fakeControl("/_fake/merge", map[string]any{"repo": "rehearsal-owner/app", "number": firstCard.PR.Number})
	require.NoError(t, err)
	_, err = r.waitTodoWithin(first, time.Minute, "merged")
	require.NoError(t, err)
	main, err := r.githubMain()
	require.NoError(t, err)
	// 60 s bounds following main, independently of the checks and PR write.
	deadline := movedAt.Add(time.Minute)
	observedAt := time.Time{}
	for {
		after, err := r.candidate(second)
		require.NoError(t, err)
		if after.Base == main {
			elapsed := time.Since(movedAt)
			require.LessOrEqual(t, elapsed, time.Minute, "follow main exceeded its bound")
			t.Logf("T%d followed the person's merge in %s", second, elapsed)
			break
		}
		if time.Since(observedAt) >= 15*time.Second {
			observedAt = time.Now()
			var state, head string
			var capture []byte
			readErr := r.pool.QueryRow(r.ctx, `SELECT status,head_commit_id,capture_pending FROM workspaces WHERE id=$1`, workspace).Scan(&state, &head, &capture)
			t.Logf("retained coding branch %s status=%s head=%s capture=%s read=%v", workspace, state, head, capture, readErr)
			if runtime, ok := r.workspaceRuntime.(bindingProcessRuntime); ok {
				link, linkErr := runtime.daemons.Current(workspace)
				var readyErr error
				if linkErr == nil {
					readyErr = link.RequireReady(workspace)
				}
				t.Logf("retained coding branch %s status=%s head=%s capture=%s read=%v native=%v ready=%v consumer=%t", workspace, state, head, capture, readErr, linkErr, readyErr, runtime.daemons.EventConsumerReady())
			}
		}
		if !time.Now().Before(deadline) {
			rows, queryErr := r.pool.Query(r.ctx, `SELECT number,state,reason,workspace_id,candidate_base,candidate_head,request_outcome,COALESCE(checks->'rebase'->>'name','') FROM mythical_items ORDER BY number`)
			if queryErr == nil {
				for rows.Next() {
					var n int64
					var state, reason, workspace, base, head, outcome, onto string
					if rows.Scan(&n, &state, &reason, &workspace, &base, &head, &outcome, &onto) == nil {
						t.Logf("T%d state=%s reason=%q workspace=%s base=%s head=%s outcome=%q onto=%s", n, state, reason, workspace, base, head, outcome, onto)
					}
				}
				rows.Close()
			}
		}
		require.True(t, time.Now().Before(deadline), "T%d stayed %s %q on %s after main moved to %s", second, after.State, after.Reason, after.Base, main)
		time.Sleep(time.Second)
	}
	deadline = time.Now().Add(8 * time.Minute)
	for {
		card, err = r.j10Card(second)
		require.NoError(t, err)
		require.NotEqual(t, "failed", card.State, "T%d's rebased checks failed", second)
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
