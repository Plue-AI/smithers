package services

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func receiptUpdate(output string) flowdispatch.ProjectionUpdate {
	return flowdispatch.ProjectionUpdate{State: jobs.StateCompleted,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.FlowRuntimeRun{FinalOutput: &output}}}
}

func flowReceipt(check, tier, status, commit string) string {
	return fmt.Sprintf(`{"checkId":%q,"target":".","tier":%q,"change":"c","commitId":%q,"treeId":"t","inputDigest":"d","status":%q,"evidence":"{}","findings":[]}`,
		check, tier, commit, status)
}

func TestMythicalRunReceiptsReadsRequestAndVerifyResults(t *testing.T) {
	request := `{"plan":{},"outcome":{"status":"validated","result":{"status":"validated","findings":[],"changes":[` +
		`{"implementation":{},"receipts":[` + flowReceipt("affected-lint", "fast", "superseded", "a1") + `,` + flowReceipt("affected-lint", "fast", "passed", "a2") + `]},` +
		`{"implementation":{},"receipts":[` + flowReceipt("affected-test", "slow", "passed", "b2") + `]}]}}}`
	assert.Equal(t, &mythicalReceipts{Run: "run-1", Checks: []mythicalReceipt{
		{Check: "affected-lint", Tier: "fast", Status: "passed", Commit: "a2"},
		{Check: "affected-test", Tier: "slow", Status: "passed", Commit: "b2"},
	}}, mythicalRunReceipts("request", "run-1", receiptUpdate(request)), "a superseded receipt measured a replaced commit")

	// A delivery's cleanup rewrote the commits and checked them again.
	vibe := `{"cleanup":{"summary":"s","result":{"status":"validated","findings":[],"changes":[{"implementation":{},"receipts":[` +
		flowReceipt("affected-test", "slow", "passed", "e2") + `]}]}},"lane":{"itemId":"i"}}`
	assert.Equal(t, &mythicalReceipts{Run: "run-3", Checks: []mythicalReceipt{
		{Check: "affected-test", Tier: "slow", Status: "passed", Commit: "e2"},
	}}, mythicalRunReceipts("vibe", "run-3", receiptUpdate(vibe)))
	assert.Nil(t, mythicalRunReceipts("vibe", "run-3", receiptUpdate(`{"lane":{"itemId":"i"}}`)))

	infra := strings.Replace(flowReceipt("affected-test", "slow", "failed", "c1"), `"status"`, `"fault":"infra","status"`, 1)
	verify := `{"status":"failed","failed":["affected-test"],"receipts":[` + flowReceipt("affected-lint", "fast", "passed", "c1") + `,` + infra + `]}`
	assert.Equal(t, &mythicalReceipts{Run: "run-2", Checks: []mythicalReceipt{
		{Check: "affected-lint", Tier: "fast", Status: "passed", Commit: "c1"},
		{Check: "affected-test", Tier: "slow", Status: "failed", Fault: "infra", Commit: "c1"},
	}}, mythicalRunReceipts("verify", "run-2", receiptUpdate(verify)))

	// Nothing to keep: no run, no output, an unreadable or receipt-less
	// result, a blocked request, another phase, or only malformed receipts.
	assert.Nil(t, mythicalRunReceipts("verify", "", receiptUpdate(verify)))
	assert.Nil(t, mythicalRunReceipts("verify", "run", flowdispatch.ProjectionUpdate{}))
	assert.Nil(t, mythicalRunReceipts("verify", "run", flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.FlowRuntimeRun{}}}))
	assert.Nil(t, mythicalRunReceipts("verify", "run", receiptUpdate(`not json`)))
	assert.Nil(t, mythicalRunReceipts("request", "run", receiptUpdate(`not json`)))
	assert.Nil(t, mythicalRunReceipts("verify", "run", receiptUpdate(`{"status":"passed","failed":[],"receipts":[]}`)))
	assert.Nil(t, mythicalRunReceipts("request", "run", receiptUpdate(`{"outcome":{"status":"blocked","result":null}}`)))
	assert.Nil(t, mythicalRunReceipts("review", "run", receiptUpdate(verify)))
	malformed := []string{
		strings.Replace(flowReceipt("x", "fast", "passed", "c"), `"checkId":"x"`, `"checkId":""`, 1),
		flowReceipt("x", "fast", "passed", ""),
		flowReceipt("x", "nightly", "passed", "c"),
		flowReceipt("x", "fast", "", "c"),
		flowReceipt("x", "fast", "skipped", "c"),
		strings.Replace(flowReceipt("x", "fast", "failed", "c"), `"status"`, `"fault":"user","status"`, 1),
	}
	assert.Nil(t, mythicalRunReceipts("verify", "run", receiptUpdate(`{"receipts":[`+strings.Join(malformed, ",")+`]}`)))

	// At most mythicalReceiptBound are kept, and the last Change's (the
	// candidate head's) are never the ones dropped.
	changes := make([]string, 5)
	for change := range changes {
		receipts := make([]string, 50)
		for i := range receipts {
			receipts[i] = flowReceipt(fmt.Sprintf("check-%d", i), "slow", "passed", fmt.Sprintf("commit-%d", change))
		}
		changes[change] = `{"implementation":{},"receipts":[` + strings.Join(receipts, ",") + `]}`
	}
	bounded := mythicalRunReceipts("request", "run", receiptUpdate(`{"outcome":{"result":{"changes":[`+strings.Join(changes, ",")+`]}}}`))
	require.NotNil(t, bounded)
	assert.Len(t, bounded.Checks, mythicalReceiptBound)
	assert.Equal(t, mythicalReceipt{Check: "check-0", Tier: "slow", Status: "passed", Commit: "commit-1"}, bounded.Checks[0])
	assert.True(t, bounded.measures("commit-4"), "the head's receipts are kept")
	assert.False(t, bounded.measures("commit-0"))
}

func TestMythicalReceiptsViewShowsOnlyTheCandidatesEvidence(t *testing.T) {
	stored := func(commit string) []byte {
		raw, _ := json.Marshal(mythicalChecks{Receipts: &mythicalReceipts{Run: "run", Checks: []mythicalReceipt{
			{Check: "affected-lint", Tier: "fast", Status: "passed", Commit: "parent"},
			{Check: "affected-test", Tier: "slow", Status: "passed", Commit: commit}}}})
		return raw
	}
	receipts := []MythicalReceiptView{{Check: "affected-lint", Tier: "fast", Status: "passed", Commit: "parent"},
		{Check: "affected-test", Tier: "slow", Status: "passed", Commit: "head"}}
	for _, tc := range []struct {
		name string
		item db.MythicalItem
		want *MythicalChecksView
	}{
		{"receipts that measured the candidate's head",
			db.MythicalItem{State: "proposing", CandidateVerified: true, CandidateHead: "head", Checks: stored("head")},
			&MythicalChecksView{State: "passed", Failed: []string{}, Receipts: receipts}},
		{"a failed verification keeps its receipts",
			db.MythicalItem{State: "retrying", CandidateHead: "head", VerifyOutcome: "failed: affected-test", Checks: stored("head")},
			&MythicalChecksView{State: "failed", Failed: []string{"affected-test"}, Receipts: receipts}},
		{"a pending verification shows none of the earlier commit's",
			db.MythicalItem{State: "verifying", CandidateHead: "rebased", Checks: stored("head")},
			&MythicalChecksView{State: "pending", Failed: []string{}}},
		{"a cleaned candidate shows none of its uncleaned commit's",
			db.MythicalItem{State: "proposing", CandidateVerified: true, CandidateHead: "cleaned", Checks: stored("head")},
			&MythicalChecksView{State: "passed", Failed: []string{}}},
		{"no receipts were recorded",
			db.MythicalItem{State: "proposing", CandidateVerified: true, CandidateHead: "head"},
			&MythicalChecksView{State: "passed", Failed: []string{}}},
		{"nothing was verified",
			db.MythicalItem{State: "running", Checks: stored("")}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, mythicalChecksView(tc.item))
		})
	}
}

func TestMythicalKeepReceiptsNeverDropsTheCandidatesEvidence(t *testing.T) {
	on := func(run, commit string) *mythicalReceipts {
		return &mythicalReceipts{Run: run, Checks: []mythicalReceipt{{Check: "affected-test", Tier: "slow", Status: "passed", Commit: commit}}}
	}
	verified := on("run-verify", "rebased")
	// A new attempt's request replaces the last attempt's receipts.
	assert.Equal(t, on("run-request", "c1"), mythicalKeepReceipts("", on("run-old", "c0"), on("run-request", "c1")))
	// A run that returned none keeps what was kept.
	assert.Equal(t, verified, mythicalKeepReceipts("rebased", verified, nil))
	assert.Nil(t, mythicalKeepReceipts("", nil, nil))
	// A delivery's cleanup rechecks replace the request's uncleaned ones.
	assert.Equal(t, on("run-vibe", "cleaned"), mythicalKeepReceipts("cleaned", on("run-request", "c1"), on("run-vibe", "cleaned")))
	// A delivery that ends after its candidate was rebased and verified
	// leaves the verification's receipts in place.
	assert.Equal(t, verified, mythicalKeepReceipts("rebased", verified, on("run-vibe", "cleaned")))
	// Verification of the rebased candidate replaces the delivery's.
	assert.Equal(t, verified, mythicalKeepReceipts("rebased", on("run-vibe", "cleaned"), verified))
}

// A candidate rebased onto a moved tip is verified with exactly the paths it
// changes there, so the affected checks select those paths' targets; the
// receipts of the run that measured the candidate reach the TODO's view.
func TestMythicalVerifyChecksTheRebasedPathsAndRecordsItsReceipts(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	for _, number := range []int64{21, 22} {
		require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: number, Title: fmt.Sprintf("Issue %d", number),
			State: "open", TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	}
	_, err := o.pool.Exec(ctx, `UPDATE mythical_stacks SET max_parallel = 3 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	stack := o.wake()
	oldTip := stack.TipCommit
	launched := func(flowID string, number int64) flowdispatch.LaunchRequest {
		t.Helper()
		for _, request := range o.launcher.byFlow(flowID) {
			var projection mythicalProjection
			require.NoError(t, json.Unmarshal(request.Projection, &projection))
			if uuidString(o.item(number).ID) == projection.ItemID {
				return request
			}
		}
		t.Fatalf("no %s launched for #%d", flowID, number)
		return flowdispatch.LaunchRequest{}
	}
	requests := map[int64]flowdispatch.LaunchRequest{21: launched("coding/request", 21), 22: launched("coding/request", 22)}
	validated := func(commit string) string {
		return `{"plan":{"changes":[{"title":"Docs","atoms":[{"changeId":null,"message":"📝 docs: add docs"}],` +
			`"checks":[{"id":"affected-lint","target":".","flow":"checks/affected-lint","flowDigest":"f","tier":"fast","required":true},` +
			`{"id":"affected-test","target":".","flow":"checks/affected-test","flowDigest":"s","tier":"slow","required":true}]}]},` +
			`"outcome":{"status":"validated","rounds":1,"blocked":null,"result":{"status":"validated","findings":[],"changes":[{"implementation":{},"receipts":[` +
			flowReceipt("affected-lint", "fast", "passed", commit) + `,` + flowReceipt("affected-test", "slow", "passed", commit) + `]}]}}}`
	}
	submit := func(number int64, base string, files map[string]string) string {
		item := o.item(number)
		candidate := o.laneResult(item.WorkspaceID, base, files, fmt.Sprintf("📝 docs: %d", number))
		o.project(requests[number], jobs.StateCompleted, fmt.Sprintf("run-%d", number), validated(candidate))
		o.wake()
		_, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: base,
			Source: candidate, RequestRunID: fmt.Sprintf("run-%d", number), Summary: fmt.Sprintf("📝 docs: %d", number)})
		require.NoError(t, err)
		return candidate
	}
	itemView := func(number int64) MythicalItemView {
		t.Helper()
		view, err := o.service.Snapshot(ctx, o.repoID, "smithers-canary/smithers", "", MythicalViewer{Admin: true})
		require.NoError(t, err)
		id := uuidString(o.item(number).ID)
		for _, item := range view.Items {
			if item.ID == id {
				return item
			}
		}
		t.Fatalf("item #%d is not in the stack view", number)
		return MythicalItemView{}
	}

	// #22 built on the tip: the lane's own request receipts are its checks.
	onTip := submit(22, oldTip, map[string]string{"docs/twenty-two.md": "22\n"})
	o.wake()
	require.Equal(t, "proposing", o.item(22).State, o.item(22).Reason)
	assert.Equal(t, &MythicalChecksView{State: "passed", Failed: []string{}, Receipts: []MythicalReceiptView{
		{Check: "affected-lint", Tier: "fast", Status: "passed", Commit: onTip},
		{Check: "affected-test", Tier: "slow", Status: "passed", Commit: onTip},
	}}, itemView(22).Checks)
	// Its delivery ends after handing the result over; the cleanup's own
	// rechecks of the candidate replace the request's.
	o.project(launched("coding/vibe", 22), jobs.StateCompleted, "run-vibe-22",
		`{"cleanup":{"result":{"changes":[{"receipts":[`+flowReceipt("affected-test", "slow", "passed", onTip)+`]}]}},"lane":{"itemId":"x"}}`)
	assert.Equal(t, []MythicalReceiptView{{Check: "affected-test", Tier: "slow", Status: "passed", Commit: onTip}},
		itemView(22).Checks.Receipts)

	// #21 built on the old tip, which main then moves past.
	submit(21, oldTip, map[string]string{"packages/rpc/src/twenty-one.ts": "21\n", "docs/twenty-one.md": "21\n"})
	o.commit("🔧 chore: outside", "outside.txt", "outside\n")
	o.publish()
	stack = o.wake()
	require.NotEqual(t, oldTip, stack.TipCommit)
	item := o.item(21)
	require.Equal(t, "verifying", item.State, item.Reason)
	verify := o.launcher.last("coding/verify")
	var payload struct {
		Source struct {
			CommitID string `json:"commitId"`
		} `json:"source"`
		Writes []string `json:"writes"`
	}
	require.NoError(t, json.Unmarshal(verify.Payload, &payload))
	assert.Equal(t, item.CandidateHead, payload.Source.CommitID)
	assert.Equal(t, []string{"docs/twenty-one.md", "packages/rpc/src/twenty-one.ts"}, payload.Writes,
		"only the candidate's own paths, never main's outside change")
	assert.Equal(t, &MythicalChecksView{State: "pending", Failed: []string{}}, itemView(21).Checks,
		"the lane's receipts measured the old commit")

	// The verification fails its slow check on the rebased commit.
	rebased := item.CandidateHead
	o.project(verify, jobs.StateCompleted, "run-verify-21", `{"status":"failed","failed":["affected-test"],"receipts":[`+
		flowReceipt("affected-lint", "fast", "passed", rebased)+`,`+flowReceipt("affected-test", "slow", "failed", rebased)+`]}`)
	item = o.item(21)
	assert.Equal(t, "failed: affected-test", item.VerifyOutcome)
	checks := itemView(21).Checks
	assert.Equal(t, &MythicalChecksView{State: "failed", Failed: []string{"affected-test"}, Receipts: []MythicalReceiptView{
		{Check: "affected-lint", Tier: "fast", Status: "passed", Commit: rebased},
		{Check: "affected-test", Tier: "slow", Status: "failed", Commit: rebased},
	}}, checks)
	encoded, err := json.Marshal(checks)
	require.NoError(t, err)
	assert.JSONEq(t, fmt.Sprintf(`{"state":"failed","failed":["affected-test"],"receipts":[`+
		`{"check":"affected-lint","tier":"fast","status":"passed","commit":%q},`+
		`{"check":"affected-test","tier":"slow","status":"failed","commit":%q}]}`, rebased, rebased), string(encoded))
	// A repeated projection of the same run changes nothing.
	before := o.item(21)
	o.project(verify, jobs.StateCompleted, "run-verify-21", `{"status":"passed","failed":[],"receipts":[]}`)
	assert.Equal(t, before.Checks, o.item(21).Checks)
}

// A candidate that changes nothing is verified with an empty path list,
// which the verify flow's payload requires; an unreadable commit is an error.
func TestMythicalChangedPathsIsEmptyNotNil(t *testing.T) {
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	f.commit("✨ feat: one", "a.txt", "a\n")
	head := f.git(f.work, "rev-parse", "HEAD")
	g := mythicalGit{dir: filepath.Join(f.work, ".git")}
	changed, err := g.changedPaths(context.Background(), head, head)
	require.NoError(t, err)
	require.NotNil(t, changed)
	encoded, err := json.Marshal(changed)
	require.NoError(t, err)
	assert.Equal(t, "[]", string(encoded))
	_, err = g.changedPaths(context.Background(), head, strings.Repeat("0", 40))
	assert.Error(t, err)
}
