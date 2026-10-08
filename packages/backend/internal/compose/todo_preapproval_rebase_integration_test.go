package compose

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// C-STK-13 steps 1, 4 and 5, and C-J4-03 step 8. The person uses the
// composed HTTP router; production workers create, rebase, verify and publish
// both candidates, with fake GitHub and the scripted coding model. In particular,
// this test never writes candidate, generation, rebase or verification rows.
// Linux process execution is supplemental evidence, not a Mac mini receipt.
func TestTodoPreapprovalProductionRebaseComposed(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_PREAPPROVAL_REBASE_REHEARSAL", "C-STK-13", "preapproval-rebase-")
	// Protection is part of the repository the owner binds, before setup's
	// first metadata sync caches its required-check configuration.
	r.fake.RequireCheck("canary/required")
	if !r.setupSource() || !r.setupMachine() {
		return
	}
	t.Cleanup(func() {
		result := "pass"
		if t.Failed() {
			result = "fail"
		}
		r.counts[result]++
		r.table += "Ordered pre-approval after production rebase\tPOST /api/todos/{n}/preapproval; signed check hints; GET /api/todos/{n}\ttwo ordered sha-bound squash merges after native rebase and fresh checks\tsee Go assertions and preapproval-rebase.json\t" + result + "\tT-STK-04\n"
	})
	require.NoError(t, r.waitStackActive())
	const repo = "rehearsal-owner/app"
	q := db.New(r.pool)
	item := func(n int64) db.MythicalItem {
		t.Helper()
		var id int64
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT repository_id FROM mythical_items WHERE number=$1`, n).Scan(&id))
		row, err := q.GetMythicalItemByNumber(r.ctx, id, n)
		require.NoError(t, err)
		return row
	}
	merges := func() []githubfake.Write {
		var result []githubfake.Write
		for _, write := range r.fake.Writes() {
			if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") {
				result = append(result, write)
			}
		}
		return result
	}
	checkReads := func(head string) int {
		count := 0
		for _, read := range r.fake.Reads() {
			if strings.Contains(read.Path, "/commits/"+head+"/check-runs") {
				count++
			}
		}
		return count
	}
	refused := func(n int64, head, reason string) {
		t.Helper()
		code, data, err := r.keyedAs(r.jar, "POST", fmt.Sprintf("/api/todos/%d/merge", n), fmt.Sprintf(`{"reviewed_head_sha":%q}`, head), uuid.NewString())
		require.NoError(t, err)
		require.Equal(t, http.StatusConflict, code, "%s", data)
		var envelope struct {
			Code string `json:"code"`
		}
		require.NoError(t, json.Unmarshal(data, &envelope))
		require.Equal(t, reason, envelope.Code)
	}
	// A signed hint goes through production fetch/admission. Its body cannot
	// supply check results; the worker must read the fake GitHub REST API.
	hint := func(head string) {
		t.Helper()
		payload := []byte(fmt.Sprintf(`{"action":"completed","installation":{"id":%d},"repository":{"id":100,"name":"app","owner":{"login":"rehearsal-owner"}},"check_run":{"head_sha":%q}}`, r.installationID, head))
		mac := hmac.New(sha256.New, []byte("webhook"))
		_, _ = mac.Write(payload)
		delivery := uuid.NewString()
		for repeat := 0; repeat < 2; repeat++ {
			request, err := http.NewRequestWithContext(r.ctx, "POST", r.origin+"/webhooks/github", bytes.NewReader(payload))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-GitHub-Event", "check_run")
			request.Header.Set("X-GitHub-Delivery", delivery)
			request.Header.Set("X-Hub-Signature-256", fmt.Sprintf("sha256=%x", mac.Sum(nil)))
			response, err := r.client.Do(request)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, response.Body.Close())
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, response.StatusCode, "%s", body)
		}
	}
	first, err := r.file("First approved", "[FILE first.md] Add the first change in first.md")
	require.NoError(t, err)
	firstCard, err := r.waitTodoWithin(first, j10RunWait, "in_review")
	require.NoError(t, err)
	second, err := r.file("Second approved", "[FILE second.md] Add the second change in second.md")
	require.NoError(t, err)
	secondCard, err := r.waitTodoWithin(second, j10RunWait, "in_review")
	require.NoError(t, err)
	require.Equal(t, "order", secondCard.Merge.Reason)
	for _, card := range []rehearsalTodo{firstCard, secondCard} {
		r.fake.SetCheck(repo, card.PR.Head, "canary/required", "in_progress", "")
		_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d/preapproval", card.N), `{}`, 202)
		require.NoError(t, err)
	}
	before := item(second)
	var approval map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(before.Checks, &approval))
	require.NotEmpty(t, approval["preapproval"])
	require.NotEmpty(t, before.VerifyRunID, "initial checks ran through the engine")
	require.Empty(t, merges())
	// T2 is green first. Order still forbids it, and this result becomes
	// obsolete once T1's squash changes the base.
	r.fake.SetCheck(repo, secondCard.PR.Head, "canary/required", "completed", "success")
	hint(secondCard.PR.Head)
	refused(second, secondCard.PR.Head, "order")
	refused(first, firstCard.PR.Head, "checks")
	require.Empty(t, merges())
	// Keep the first request in flight while T2 is green. A held GitHub
	// response cannot let another stack pass send T2 or duplicate T1.
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseMerge := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseMerge)
	r.fake.OnNextRequest("PUT", fmt.Sprintf("/repos/%s/pulls/%d/merge", repo, firstCard.PR.Number), func() {
		close(entered)
		<-release
	})
	r.fake.HoldMain()
	r.fake.SetCheck(repo, firstCard.PR.Head, "canary/required", "completed", "success")
	hint(firstCard.PR.Head)
	select {
	case <-entered:
	case <-time.After(time.Minute):
		t.Fatal("pre-approved T1 did not dispatch after its current head became green")
	}
	require.Never(t, func() bool {
		return item(first).State == "landed" || item(second).State == "landed" || len(merges()) != 0
	}, 4*time.Second, 200*time.Millisecond)
	releaseMerge()
	require.Eventually(t, func() bool { return len(merges()) == 1 }, time.Minute, 200*time.Millisecond)
	// A GitHub merge response alone does not settle T1 or release T2.
	require.Never(t, func() bool {
		return item(first).State == "landed" || len(merges()) != 1 || item(second).PRHead != secondCard.PR.Head
	}, 4*time.Second, 200*time.Millisecond)
	r.fake.ReleaseMain()
	require.NoError(t, r.waitMerged(first, firstCard.PR.Number, firstCard.PR.Head))
	require.Len(t, merges(), 1)
	firstPull, err := r.readFakePull(firstCard.PR.Number)
	require.NoError(t, err)
	var rebased rehearsalTodo
	require.Eventually(t, func() bool {
		card, err := r.todo(second)
		if err == nil {
			rebased = card
		}
		if err != nil || card.State != "in_review" || card.PR.Head == secondCard.PR.Head || card.PR.Draft {
			return false
		}
		// In review remains visible during publication. A new remote head
		// alone does not mean the stack has settled its accepted proposal.
		row := item(second)
		return row.State == "proposed" && row.CandidateVerified && len(row.PendingOp) == 0
	}, 3*time.Minute, 500*time.Millisecond, "T2 must publish its production-rebased candidate: %+v", rebased)
	after := item(second)
	assert.Greater(t, after.Generation, before.Generation)
	assert.Equal(t, firstPull.MergeCommitSHA, after.CandidateBase)
	assert.True(t, after.CandidateVerified)
	assert.NotEmpty(t, after.VerifyRunID)
	assert.NotEqual(t, before.VerifyRunID, after.VerifyRunID, "the rebased candidate needs a new verification run")
	var checks map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(after.Checks, &checks))
	assert.JSONEq(t, string(approval["preapproval"]), string(checks["preapproval"]), "standing person approval survives rebase")
	var rebase struct {
		Onto    string `json:"onto"`
		Receipt string `json:"receipt_id"`
	}
	// Publication clears the pending rebase slot. The completion fact keeps
	// its native receipt durably after that slot has been consumed.
	var rebaseFact json.RawMessage
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT data FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, second, firstPull.MergeCommitSHA).Scan(&rebaseFact))
	require.NoError(t, json.Unmarshal(rebaseFact, &rebase))
	assert.Empty(t, checks["rebase"])
	assert.Equal(t, firstPull.MergeCommitSHA, rebase.Onto)
	assert.NotEmpty(t, rebase.Receipt)
	assert.Empty(t, checks["land"], "no worker fabricates a session approval")
	var receipts struct {
		Run    string `json:"run"`
		Checks []struct {
			Status string `json:"status"`
			Commit string `json:"commit"`
		} `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(checks["receipts"], &receipts))
	assert.Equal(t, after.VerifyRunID, receipts.Run)
	assert.NotEmpty(t, receipts.Checks, "production verification retains actual check receipts")
	for _, receipt := range receipts.Checks {
		assert.Equal(t, "passed", receipt.Status)
		assert.Equal(t, after.CandidateHead, receipt.Commit)
	}
	parent, err := r.githubGit("rev-parse", rebased.PR.Head+"^")
	require.NoError(t, err)
	assert.Equal(t, firstPull.MergeCommitSHA, parent)
	files, err := r.githubGit("diff", "--name-only", parent, rebased.PR.Head)
	require.NoError(t, err)
	assert.Equal(t, "second.md", files, "the new PR contains only T2's own change")
	assert.Equal(t, secondCard.PR.Number, rebased.PR.Number)
	assert.False(t, rebased.PR.Draft)
	var rebases int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.rebased' AND (data->>'n')::bigint=$1 AND data->>'onto'=$2`, second, firstPull.MergeCommitSHA).Scan(&rebases))
	assert.Equal(t, 1, rebases, "one production rebase completion onto T1's squash")
	// The old reviewed head and old green fact cannot authorize H2'.
	refused(second, secondCard.PR.Head, "stale_head")
	hint(secondCard.PR.Head)
	r.fake.SetCheck(repo, rebased.PR.Head, "canary/required", "in_progress", "")
	reads := checkReads(rebased.PR.Head)
	hint(rebased.PR.Head)
	require.Eventually(t, func() bool { return checkReads(rebased.PR.Head) > reads }, time.Minute, 200*time.Millisecond)
	refused(second, rebased.PR.Head, "checks")
	require.Never(t, func() bool { return len(merges()) != 1 }, 4*time.Second, 200*time.Millisecond, "old-head green cannot authorize the pending rebased head")
	r.fake.SetCheck(repo, rebased.PR.Head, "canary/optional", "completed", "failure")
	r.fake.SetCheck(repo, rebased.PR.Head, "canary/required", "completed", "success")
	hint(rebased.PR.Head)
	require.NoError(t, r.waitMerged(second, rebased.PR.Number, rebased.PR.Head))
	// Fresh duplicate hints after settlement cannot start another merge.
	// Settled TODOs correctly leave the active check-polling working set.
	hint(rebased.PR.Head)
	require.Eventually(t, func() bool {
		var pending int
		err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume' AND principal_id IN ('pulls','checks') AND state<>'completed'`).Scan(&pending)
		return err == nil && pending == 0
	}, time.Minute, 200*time.Millisecond)
	require.Never(t, func() bool { return len(merges()) != 2 }, 4*time.Second, 200*time.Millisecond)
	writes := merges()
	require.Len(t, writes, 2, "ordered exactly-once merges even after duplicate delivery")
	for i, card := range []rehearsalTodo{firstCard, rebased} {
		require.Equal(t, fmt.Sprintf("/repos/%s/pulls/%d/merge", repo, card.PR.Number), writes[i].Path)
		require.Equal(t, http.StatusOK, writes[i].Status)
		var send struct {
			SHA    string `json:"sha"`
			Method string `json:"merge_method"`
		}
		require.NoError(t, json.Unmarshal(writes[i].Body, &send))
		require.Equal(t, card.PR.Head, send.SHA)
		require.Equal(t, "squash", send.Method)
		require.Empty(t, item(card.N).PendingOp)
	}
	count, err := r.githubGit("rev-list", "--count", r.mainCommit+"..main")
	require.NoError(t, err)
	require.Equal(t, "2", count, "one squash commit per TODO")
	evidence, err := json.MarshalIndent(map[string]any{"github_writes": r.fake.Writes(), "before_rebase": before, "after_rebase": after, "rebase_completion": rebaseFact, "merged": []db.MythicalItem{item(first), item(second)}}, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "preapproval-rebase.json"), evidence, 0600))
}
