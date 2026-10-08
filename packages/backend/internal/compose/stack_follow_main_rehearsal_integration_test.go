package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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
	source, err := os.ReadFile(filepath.Join(r.root, "flows/todo/flow.ts"))
	require.NoError(t, err)
	activateMonitorOverride(t, r, string(source))
	first, err := r.file("First change", "[PR] [FILE FIRST.md] Add the first change.")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(first, 8*time.Minute, "in_review")
	require.NoError(t, err)
	firstCard, err := r.todo(first)
	require.NoError(t, err)
	require.NotNil(t, firstCard.Branch)
	require.NotNil(t, firstCard.Run)
	require.NoError(t, r.sleepRebaseBranch(firstCard.Branch.ID))
	require.NoError(t, r.waitSQL(j10RunWait, `SELECT count(*) FROM workspaces WHERE id=$1 AND status IN ('stopped','suspended')`, firstCard.Branch.ID))
	second, err := r.file("Next change", "[PR] [FILE NEXT.md] Add the next change.")
	require.NoError(t, err)
	secondCard, err := r.waitTodoWithin(second, 8*time.Minute, "in_review")
	require.NoError(t, err)
	require.NotNil(t, secondCard.Run)
	before, err := r.candidate(second)
	require.NoError(t, err)
	card, err := r.j10Card(second)
	require.NoError(t, err)
	pr, oldHead := card.PR.Number, card.PR.Head
	var reviewedRun, verdict string
	var launches int64
	for deadline := time.Now().Add(3 * time.Minute); ; time.Sleep(time.Second) {
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT COALESCE(checks->'review'->>'runId',''),COALESCE(checks->'review'->>'verdict',''),COALESCE((checks->>'launches')::bigint,0) FROM mythical_items WHERE number=$1`, second).Scan(&reviewedRun, &verdict, &launches))
		if verdict == "approve" && reviewedRun != "" {
			break
		}
		require.True(t, time.Now().Before(deadline), "second TODO has no settled review")
	}
	// The public TODO names the retained branch, even when verification uses
	// a separate engine workspace.
	require.NotNil(t, secondCard.Branch)
	workspace := secondCard.Branch.ID
	require.NotEmpty(t, workspace)
	// Sleep is a person action; completing a review need not stop the coding
	// machine. Enter its existing background control before moving main.
	require.NoError(t, r.sleepRebaseBranch(workspace))
	require.NoError(t, r.waitSQL(j10RunWait, `SELECT count(*) FROM workspaces w JOIN mythical_items i ON i.number=$2 WHERE w.id=$1 AND w.status IN ('stopped','suspended') AND i.checks->'review'->>'verdict' IN ('approve','request-changes') AND COALESCE(i.checks->'review'->>'runId','')<>''`, workspace, second))
	var asleepIdentity, reviewRun string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT jsonb_build_array(vm_id,resumed_at)::text FROM workspaces WHERE id=$1`, workspace).Scan(&asleepIdentity))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'review'->>'runId' FROM mythical_items WHERE number=$1`, second).Scan(&reviewRun))
	firstCard, err = r.todo(first)
	require.NoError(t, err)
	movedAt := time.Now()
	_, err = r.fakeControl("/_fake/merge", map[string]any{"repo": "rehearsal-owner/app", "number": firstCard.PR.Number})
	require.NoError(t, err)
	main, err := r.githubMain()
	require.NoError(t, err)
	// 60 s bounds following main, independently of the checks and PR write.
	deadline := movedAt.Add(time.Minute)
	// Restart after the host's data-only rewrite commits, before verification
	// admission. Its receipt must recover without another rewrite or wake.
	for {
		var retained int
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items i JOIN workspaces w ON w.id=$2 WHERE i.number=$1 AND i.integration->>'kind'='asleep-rebased' AND i.integration->>'onto'=$3 AND i.integration->>'head'=w.head_commit_id AND i.candidate_base<>$3`, second, workspace, main).Scan(&retained))
		if retained == 1 {
			r.restartBackend()
			break
		}
		require.True(t, time.Now().Before(deadline), "the asleep rebase did not retain its pre-verification receipt")
		time.Sleep(25 * time.Millisecond)
	}
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
	_, err = r.waitTodoWithin(first, time.Minute, "merged")
	require.NoError(t, err)
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
			var reusedRun, reviewedHead, reviewedCandidate, patchID string
			var afterLaunches int64
			require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT COALESCE(checks->'review'->>'runId',''),COALESCE(checks->'review'->'rebase'->>'head',checks->'review'->>'head',''),COALESCE(checks->'review'->'rebase'->>'candidate',checks->'review'->>'candidate',''),COALESCE(checks->'review'->'rebase'->>'patchId',''),COALESCE((checks->>'launches')::bigint,0) FROM mythical_items WHERE number=$1`, second).Scan(&reusedRun, &reviewedHead, &reviewedCandidate, &patchID, &afterLaunches))
			if reusedRun == "" {
				require.True(t, time.Now().Before(deadline), "rebased PR has no settled review evidence")
				time.Sleep(time.Second)
				continue
			}
			require.Equal(t, reviewedRun, reusedRun, "clean rebase reuses the same reviewed own diff")
			require.Equal(t, launches+1, afterLaunches, "only verification launches after a clean rebase")
			require.Equal(t, pull.Head.SHA, reviewedHead)
			require.Equal(t, after.Head, reviewedCandidate)
			require.Regexp(t, "^[0-9a-f]{40}$", patchID)
			require.NotContains(t, pull.Body, fmt.Sprintf("[T%d]", first))
			paths, err := r.githubGit("diff", "--name-only", main, pull.Head.SHA)
			require.NoError(t, err)
			require.Equal(t, "NEXT.md", paths, "the updated PR contains only the next item's change")
			break
		}
		require.True(t, time.Now().Before(deadline), "T%d did not publish its rebased PR: %+v", second, card)
		time.Sleep(time.Second)
	}
	updated, err := r.todo(second)
	require.NoError(t, err)
	require.NotNil(t, updated.Branch)
	require.Equal(t, workspace, updated.Branch.ID, "engine verification must preserve the person's retained branch")
	branchJSON, err := r.expect("GET", "/api/branches/"+url.PathEscape(workspace), "", 200)
	require.NoError(t, err)
	var branch struct {
		Head string `json:"head"`
	}
	require.NoError(t, json.Unmarshal(branchJSON, &branch))
	afterCandidate, err := r.candidate(second)
	require.NoError(t, err)
	require.Equal(t, afterCandidate.Head, branch.Head, "the sleeping Branch card serves the rebased head")
	require.Zero(t, r.appMergeWrites(firstCard.PR.Number))
	var status, afterIdentity, afterReview string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT status,jsonb_build_array(vm_id,resumed_at)::text FROM workspaces WHERE id=$1`, workspace).Scan(&status, &afterIdentity))
	require.Contains(t, []string{"stopped", "suspended"}, status, "following main must not wake the retained coding branch")
	require.Equal(t, asleepIdentity, afterIdentity, "the coding machine's wake identity and timestamp must remain unchanged")
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT checks->'review'->>'runId' FROM mythical_items WHERE number=$1`, second).Scan(&afterReview))
	require.Equal(t, reviewRun, afterReview, "a clean asleep rebase reruns checks and retains the original review")
	require.NoError(t, r.controlRebaseBranch(workspace, "wake"))
	for _, path := range []string{"FIRST.md", "NEXT.md"} {
		fileJSON, err := r.expect("GET", "/api/branches/"+url.PathEscape(workspace)+"/files/"+path, "", 200)
		require.NoError(t, err)
		var file struct{ Content struct{ Kind, Text string } }
		require.NoError(t, json.Unmarshal(fileJSON, &file))
		want, err := r.githubGit("show", card.PR.Head+":"+path)
		require.NoError(t, err)
		require.Equal(t, "text", file.Content.Kind)
		require.Equal(t, want, strings.TrimSpace(file.Content.Text), "Wake restores the rebased working copy")
	}
}

func (r *rehearsal) sleepRebaseBranch(branch string) error {
	return r.controlRebaseBranch(branch, "sleep")
}

func (r *rehearsal) controlRebaseBranch(branch, op string) error {
	code, data, err := r.keyed("POST", "/api/branches/"+url.PathEscape(branch), fmt.Sprintf(`{"op":%q}`, op), r.keyPrefix+op+"-"+branch)
	if err != nil || code != 202 {
		return fmt.Errorf("%s admission: %d %s %v", op, code, data, err)
	}
	var accepted struct {
		OperationID string `json:"operationId"`
	}
	if err := json.Unmarshal(data, &accepted); err != nil {
		return err
	}
	if accepted.OperationID == "" {
		return fmt.Errorf("%s has no operation receipt", op)
	}
	path := "/api/repos/rehearsal-owner/app/workspaces/" + branch + "/command-runs/" + accepted.OperationID
	for deadline := time.Now().Add(time.Minute); ; time.Sleep(100 * time.Millisecond) {
		data, err := r.expect("GET", path, "", 200)
		if err != nil {
			return err
		}
		var receipt struct {
			State string `json:"state"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(data, &receipt); err != nil {
			return err
		}
		if receipt.State == "completed" {
			return nil
		}
		if receipt.State == "failed" || receipt.State == "uncertain" || receipt.State == "cancelled" || time.Now().After(deadline) {
			return fmt.Errorf("%s %s: %s", op, receipt.State, receipt.Error)
		}
	}
}
