package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// fakeMythicalGitHub is GitHub for the stack: a real bare repository the
// proposal is pushed to, plus recorded issues and pull requests.
type fakeMythicalGitHub struct {
	mu     sync.Mutex
	dir    string
	issues []mythicalIssue
	pulls  map[int64]*mythicalPull
}

func (g *fakeMythicalGitHub) Resolve(context.Context, db.Repository, string, int64) (mythicalGitHubRepo, error) {
	return mythicalGitHubRepo{Owner: "smithersai", Name: "smithers", Token: "t", GitURL: g.dir}, nil
}

func (g *fakeMythicalGitHub) OpenIssues(context.Context, mythicalGitHubRepo) ([]mythicalIssue, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]mythicalIssue(nil), g.issues...), nil
}

func (g *fakeMythicalGitHub) Pull(_ context.Context, _ mythicalGitHubRepo, number int64) (mythicalPull, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull, ok := g.pulls[number]
	if !ok {
		return mythicalPull{}, fmt.Errorf("no pull %d", number)
	}
	return *pull, nil
}

func (g *fakeMythicalGitHub) FindPull(_ context.Context, _ mythicalGitHubRepo, branch string) (*mythicalPull, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, pull := range g.pulls {
		if pull.HeadRef == branch {
			found := *pull
			return &found, nil
		}
	}
	return nil, nil
}

func (g *fakeMythicalGitHub) CreatePull(_ context.Context, _ mythicalGitHubRepo, title, head, base, body string) (mythicalPull, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pulls == nil {
		g.pulls = map[int64]*mythicalPull{}
	}
	pull := &mythicalPull{Number: int64(100 + len(g.pulls)), URL: "https://github.com/smithersai/smithers/pull/x", State: "open", HeadRef: head}
	g.pulls[pull.Number] = pull
	return *pull, nil
}

func (g *fakeMythicalGitHub) merge(number int64, commit string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull := g.pulls[number]
	pull.Merged, pull.State, pull.MergeCommit = true, "closed", commit
}

type fakeMythicalLauncher struct {
	mu       sync.Mutex
	requests []flowdispatch.LaunchRequest
	fail     int
}

// AdmitInTx records the launch only when the item's transaction commits, as
// flowdispatch does; fail makes the next admission fail (a lost launch).
func (l *fakeMythicalLauncher) AdmitInTx(ctx context.Context, tx pgx.Tx, request flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fail > 0 {
		l.fail--
		return jobs.RequestReceipt{}, errors.New("dispatch unavailable")
	}
	for _, seen := range l.requests {
		if seen.RequestID == request.RequestID {
			return jobs.RequestReceipt{}, errors.New("duplicate launch " + request.RequestID)
		}
	}
	l.requests = append(l.requests, request)
	return jobs.RequestReceipt{}, nil
}

func (l *fakeMythicalLauncher) last(flowID string) flowdispatch.LaunchRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.requests) - 1; i >= 0; i-- {
		if l.requests[i].FlowID == flowID {
			return l.requests[i]
		}
	}
	return flowdispatch.LaunchRequest{}
}

type fakeMythicalLanes struct {
	mu      sync.Mutex
	created []string
	deleted []string
	owned   map[string]bool
}

func (l *fakeMythicalLanes) Create(_ context.Context, _ db.Repository, _ string, _ int64, name string, bind func(string) error) (string, error) {
	id := uuid.NewString()
	if err := bind(id); err != nil {
		return "", err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.created = append(l.created, id)
	return id, nil
}

func (l *fakeMythicalLanes) Owned(_ context.Context, _, _ int64, id string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.owned[id], nil
}

func (l *fakeMythicalLanes) Delete(_ context.Context, _, _ int64, id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.deleted = append(l.deleted, id)
	return nil
}

type mythicalOrchestration struct {
	*mythicalServiceFixture
	github   *fakeMythicalGitHub
	launcher *fakeMythicalLauncher
	lanes    *fakeMythicalLanes
}

func newMythicalOrchestration(t *testing.T) *mythicalOrchestration {
	f := newMythicalServiceFixture(t)
	f.commit("✨ feat: one", "a.txt", "a\n")
	f.commit("✨ feat: two", "b.txt", "b\n")
	f.publish()
	github := &fakeMythicalGitHub{dir: f.bare("github.git")}
	f.git(f.work, "push", "-q", github.dir, "main:refs/heads/main")
	o := &mythicalOrchestration{mythicalServiceFixture: f, github: github, launcher: &fakeMythicalLauncher{}, lanes: &fakeMythicalLanes{}}
	f.service.SetOrchestration(github, o.launcher, o.lanes)
	f.service.markBackfill(f.repoID) // the tests admit issues themselves
	_, err := f.service.RequestBootstrap(context.Background(), f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	return o
}

func (o *mythicalOrchestration) item(number int64) db.MythicalItem {
	o.t.Helper()
	item, err := db.New(o.pool).GetMythicalItemByIssue(context.Background(), o.repoID, number)
	require.NoError(o.t, err)
	return item
}

// wake makes the stack and every item due and runs one claim.
func (o *mythicalOrchestration) wake() db.MythicalStack {
	o.t.Helper()
	ctx := context.Background()
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(o.t, err)
	o.service.MainMoved(ctx, o.repoID)
	return o.poll()
}

// project answers a launched run's terminal outcome, as flowdispatch would.
func (o *mythicalOrchestration) project(request flowdispatch.LaunchRequest, state jobs.State, runID, output string) {
	o.t.Helper()
	update := flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: runID,
		Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output}}}
	require.NoError(o.t, o.service.ProjectFlowRuntime(context.Background(), update))
}

// laneResult writes a candidate on base, as a lane's coding host publishes
// it: an ordinary commit retained in the lane workspace's source ref.
func (o *mythicalOrchestration) laneResult(workspaceID, base string, files map[string]string, message string) string {
	o.t.Helper()
	index := filepath.Join(o.t.TempDir(), "index")
	run := func(stdin string, args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir", o.hostDir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+index, "GIT_AUTHOR_NAME=Lane", "GIT_AUTHOR_EMAIL=lane@example.com",
			"GIT_COMMITTER_NAME=Lane", "GIT_COMMITTER_EMAIL=lane@example.com", "GIT_AUTHOR_DATE=2026-09-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-09-01T00:00:00Z")
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		require.NoError(o.t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	run("", "read-tree", base)
	for path, content := range files {
		blob := run(content, "hash-object", "-w", "--stdin")
		run("", "update-index", "--add", "--cacheinfo", "100644,"+blob+","+path)
	}
	tree := run("", "write-tree")
	commit := run("", "commit-tree", tree, "-p", base, "-m", message)
	run("", "update-ref", repohost.WorkspaceSourceRef(workspaceID, commit), commit)
	return commit
}

const validatedRequest = `{"plan":{"changes":[{"title":"Docs","atoms":[{"changeId":null,"message":"📝 docs: add docs"}],
"checks":[{"id":"fast","target":"flows","flow":"checks/fast","flowDigest":"f","tier":"fast","required":true}]}]},
"outcome":{"status":"validated"}}`

func TestMythicalItemsFlowFromIssueToLandedAndAdopted(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 7, Title: "Add docs", URL: "https://github.com/smithersai/smithers/issues/7",
		State: "open", AuthorAssociation: "OWNER", Body: "Please add a docs page."}, ""))
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 8, Title: "Drive-by", State: "open", AuthorAssociation: "NONE"}, ""))
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 9, Title: "A PR", State: "open", PullRequest: true}, ""))
	assert.Equal(t, "queued", o.item(7).State)
	assert.Equal(t, "skipped", o.item(8).State)
	assert.Contains(t, o.item(8).Reason, "smithers label")
	assert.Equal(t, "skipped", o.item(9).State)

	// A lane starts: a fresh workspace, the tip retained into its source ref,
	// and coding/request launched on the stack.
	stack := o.wake()
	item := o.item(7)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.lanes.created, 1)
	assert.EqualValues(t, 0, item.Lane.Int32, "the first lane is lane 0")
	require.True(t, item.LaneStartedAt.Valid)
	assert.WithinDuration(t, time.Now(), item.LaneStartedAt.Time, time.Minute)
	workspace := o.lanes.created[0]
	request := o.launcher.last("coding/request")
	require.Equal(t, mythicalBindingKind, request.Target.BindingKind)
	assert.Equal(t, workspace, request.Target.WorkspaceID)
	assert.Equal(t, flowdispatch.ApprovalAuto, request.ApprovalPolicy)
	var payload struct {
		Prompt string `json:"prompt"`
		Base   struct {
			CommitID string `json:"commitId"`
			Ref      string `json:"ref"`
		} `json:"base"`
	}
	require.NoError(t, json.Unmarshal(request.Payload, &payload))
	assert.Equal(t, stack.TipCommit, payload.Base.CommitID)
	assert.Equal(t, repohost.WorkspaceSourceRef(workspace, stack.TipCommit), payload.Base.Ref)
	assert.Equal(t, stack.TipCommit, o.hostRef(payload.Base.Ref), "the tip is retained where the lane's import reads it")
	assert.Contains(t, payload.Prompt, "#7: Add docs")
	assert.Contains(t, payload.Prompt, "#8 Drive-by", "other open issues are listed for duplicates")

	// A duplicate launch is impossible: the lane is busy until the run settles.
	o.wake()
	assert.Len(t, o.launcher.requests, 1)

	// The request validates; its plan is projected and vibe is launched.
	o.project(request, jobs.StateCompleted, "run-request", validatedRequest)
	o.wake()
	item = o.item(7)
	require.Equal(t, "delivering", item.State, item.Reason)
	var plan struct {
		Appends int               `json:"appends"`
		Checks  []json.RawMessage `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(item.Plan, &plan))
	assert.Equal(t, 1, plan.Appends)
	assert.Len(t, plan.Checks, 1)
	vibe := o.launcher.last("coding/vibe")
	assert.JSONEq(t, `{"requestExecutionId":"run-request"}`, string(vibe.Payload))

	// The lane hands its cleaned result to the stack.
	candidate := o.laneResult(workspace, stack.TipCommit, map[string]string{"docs.md": "docs\n"}, "📝 docs: add docs")
	receipt, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: workspace, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-request", Summary: "📝 docs: add docs\n\nAdds the docs page."})
	require.NoError(t, err)
	assert.Equal(t, "integrating", receipt.State)
	again, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: workspace, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-request", Summary: "📝 docs: add docs"})
	require.NoError(t, err)
	assert.Equal(t, receipt.ItemID, again.ItemID, "a replayed submission is idempotent")

	// Built on the tip: it is proposed as is, as one commit on main whose tree
	// is exactly the candidate's.
	o.wake()
	require.Equal(t, "proposing", o.item(7).State)
	assert.Equal(t, candidate, o.hostRef(repohost.MythicalReservedRefNS+"keep/"+candidate), "the candidate is pinned")
	o.wake()
	item = o.item(7)
	require.Equal(t, "proposed", item.State, item.Reason)
	require.True(t, item.PRNumber.Valid)
	branchHead := o.git(o.github.dir, "rev-parse", "refs/heads/smithers/issue-7")
	assert.Equal(t, o.hostTree(candidate), o.git(o.github.dir, "rev-parse", branchHead+"^{tree}"))
	assert.Equal(t, o.git(o.github.dir, "rev-parse", "refs/heads/main"), o.git(o.github.dir, "rev-parse", branchHead+"^"))
	assert.Contains(t, o.git(o.github.dir, "log", "-1", "--format=%B", branchHead), "Closes #7")
	assert.Contains(t, o.lanes.deleted, workspace, "the lane is retired once the candidate is pinned")

	// The owner squash-merges on GitHub; the main pull brings it to Smithers.
	o.git(o.work, "pull", "-q", "--ff-only", o.github.dir, "main")
	o.git(o.work, "fetch", "-q", o.github.dir, "refs/heads/smithers/issue-7")
	o.git(o.work, "merge", "-q", "--squash", branchHead)
	o.git(o.work, "commit", "-q", "-m", "📝 docs: add docs (#101)")
	merged := o.publish()
	o.github.merge(item.PRNumber.Int64, merged)
	stack = o.wake()
	require.Equal(t, "active", stack.State, stack.LastError)
	assert.Equal(t, merged, stack.LandedMain)
	assert.Equal(t, "landed", o.item(7).State)
	assert.Equal(t, o.hostTree(merged), o.hostTree(stack.TipCommit))
	// The fold adopted the item's own change instead of a flat copy.
	changes, err := db.New(o.pool).ListRecentMythicalChanges(ctx, o.repoID, 1)
	require.NoError(t, err)
	require.Len(t, changes, 1)
	assert.Equal(t, "item", changes[0].Kind)
	assert.Equal(t, "📝 docs: add docs", changes[0].Title)
	assert.EqualValues(t, 7, changes[0].IssueNumber.Int64)
	assert.Equal(t, merged, changes[0].FoldedFrom)
}

func TestMythicalItemsRebaseVerifyRetryAndDecline(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	for _, number := range []int64{11, 12, 13} {
		require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: number, Title: fmt.Sprintf("Issue %d", number),
			State: "open", AuthorAssociation: "MEMBER"}, ""))
	}
	// Four lanes: one stays reserved for direct chat work, so three issues run.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_stacks SET max_parallel = 4 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	stack := o.wake()
	oldTip := stack.TipCommit
	lanes := map[int32]int64{}
	for _, number := range []int64{11, 12, 13} {
		item := o.item(number)
		require.Equal(t, "running", item.State)
		require.True(t, item.Lane.Valid)
		assert.True(t, item.LaneStartedAt.Valid, "the launch records when the lane started")
		lanes[item.Lane.Int32] = number
	}
	assert.Len(t, lanes, 3, "three items in flight hold three distinct lanes")
	for index := int32(0); index < 3; index++ {
		assert.Contains(t, lanes, index, "the lowest free lanes are taken")
	}
	requests := map[int64]flowdispatch.LaunchRequest{}
	for _, request := range o.launcher.requests {
		var projection mythicalProjection
		require.NoError(t, json.Unmarshal(request.Projection, &projection))
		for _, number := range []int64{11, 12, 13} {
			if uuidString(o.item(number).ID) == projection.ItemID {
				requests[number] = request
			}
		}
	}

	// #13 is declined by the planner: skipped with the reason.
	o.project(requests[13], jobs.StateFailed, "run-13",
		`{"_tag":"coding/Error","code":"declined","message":"Already done: README.md has it."}`)
	// #11 and #12 validate and hand results built on the old tip.
	o.project(requests[11], jobs.StateCompleted, "run-11", validatedRequest)
	o.project(requests[12], jobs.StateCompleted, "run-12", validatedRequest)
	o.wake()
	assert.Equal(t, "skipped", o.item(13).State)
	assert.Equal(t, "Already done: README.md has it.", o.item(13).Reason)
	ws11, ws12 := o.item(11).WorkspaceID, o.item(12).WorkspaceID
	appended := o.laneResult(ws11, oldTip, map[string]string{"eleven.txt": "11\n"}, "✨ feat: eleven")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: ws11, Base: oldTip, Source: appended,
		RequestRunID: "run-11", Summary: "✨ feat: eleven"})
	require.NoError(t, err)
	conflicting := o.laneResult(ws12, oldTip, map[string]string{"b.txt": "twelve\n"}, "🐛 fix: twelve")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: ws12, Base: oldTip, Source: conflicting,
		RequestRunID: "run-12", Summary: "🐛 fix: twelve"})
	require.NoError(t, err)

	// Main moves underneath them (an outside commit touching b.txt).
	o.commit("🔧 chore: outside", "b.txt", "outside\n")
	o.publish()
	// One poll folds main, then advances the items against the new tip.
	stack = o.wake()
	require.NotEqual(t, oldTip, stack.TipCommit)

	// #11 only appended: rebased onto the new tip and sent to coding/verify.
	item := o.item(11)
	require.Equal(t, "verifying", item.State, item.Reason)
	assert.Contains(t, string(item.Integration), "rebased")
	assert.Equal(t, stack.TipCommit, item.CandidateBase)
	assert.NotEqual(t, appended, item.CandidateHead)
	verify := o.launcher.last("coding/verify")
	assert.Contains(t, string(verify.Payload), item.CandidateHead)
	assert.Contains(t, string(verify.Payload), `"checks/fast"`)
	assert.Equal(t, item.CandidateHead, o.hostRef(repohost.WorkspaceSourceRef(ws11, item.CandidateHead)))

	// #12 conflicts with main: back to a lane with the paths, attempt 2.
	twelve := o.item(12)
	require.Equal(t, "retrying", twelve.State)
	assert.Contains(t, twelve.Reason, "b.txt")
	assert.Contains(t, string(twelve.Integration), "b.txt")

	// A stale verify projection (an older generation) changes nothing.
	o.project(requests[11], jobs.StateCompleted, "stale", `{"status":"failed","failed":["fast"]}`)
	assert.Equal(t, "", o.item(11).VerifyOutcome)
	o.project(verify, jobs.StateCompleted, "run-verify", `{"status":"passed","failed":[],"receipts":[]}`)
	o.wake()
	o.wake()
	item = o.item(11)
	require.Equal(t, "proposed", item.State, item.Reason)
	branchHead := o.git(o.github.dir, "rev-parse", "refs/heads/smithers/issue-11")
	assert.Equal(t, o.hostTree(item.CandidateHead), o.git(o.github.dir, "rev-parse", branchHead+"^{tree}"),
		"the proposal is exactly the verified rebased tree")

	// #12's retries run out: blocked, visibly, and a retry re-queues it.
	for attempt := 2; attempt <= mythicalAttempts; attempt++ {
		_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
		require.NoError(t, err)
		o.wake()
		twelve = o.item(12)
		require.Equal(t, "running", twelve.State, twelve.Reason)
		require.EqualValues(t, attempt, twelve.Attempt)
		o.project(o.launcher.last("coding/request"), jobs.StateFailed, fmt.Sprintf("run-12-%d", attempt), `{}`)
		o.wake()
	}
	twelve = o.item(12)
	assert.Equal(t, "blocked", twelve.State)
	payload := string(o.launcher.last("coding/request").Payload)
	assert.Contains(t, payload, "Append new changes at the head only", "the last attempt appends only")
	view, err := o.service.RetryItem(ctx, o.repoID, uuidString(twelve.ID))
	require.NoError(t, err)
	assert.Equal(t, "queued", view.State)

	// Main moves again while #11's PR is open; GitHub reports it behind, so
	// the proposal is rebuilt on the new tip and verified on a fresh lane.
	eleven := o.item(11)
	require.Empty(t, eleven.WorkspaceID, "the proposed item's lane was retired")
	pullNumber := eleven.PRNumber.Int64
	o.commit("🔧 chore: more outside", "c.txt", "c\n")
	o.publish()
	stack = o.wake()
	o.github.mu.Lock()
	o.github.pulls[eleven.PRNumber.Int64].MergeableState = "behind"
	o.github.mu.Unlock()
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	o.wake() // follow: behind on a moved tip -> integrating
	require.Equal(t, "integrating", o.item(11).State)
	o.wake() // integrate: rebase, fresh lane, verify
	eleven = o.item(11)
	require.Equal(t, "verifying", eleven.State, eleven.Reason)
	assert.Equal(t, stack.TipCommit, eleven.CandidateBase)
	assert.NotEmpty(t, eleven.WorkspaceID, "a fresh lane verifies the refreshed proposal")
	assert.Equal(t, pullNumber, eleven.PRNumber.Int64, "the same pull request is updated")

	// The snapshot shows the items and their lanes.
	snapshot, err := o.service.Snapshot(ctx, o.repoID, "smithers-canary/smithers", "", MythicalViewer{UserID: o.userID})
	require.NoError(t, err)
	states := map[string]string{}
	for _, row := range snapshot.Items {
		states[row.Issue.Title] = row.State
	}
	assert.Equal(t, map[string]string{"Issue 11": "verifying", "Issue 12": "running", "Issue 13": "skipped"}, states)
	busy := map[string]string{}
	for _, lane := range snapshot.Lanes {
		if lane.State == "busy" {
			busy[lane.WorkspaceID] = lane.StartedAt
		}
	}
	require.Len(t, busy, 2, "the verifying proposal's fresh lane and #12's lane both show")
	for workspace, started := range busy {
		assert.NotEmpty(t, started, "lane %s shows when it started", workspace)
	}
	_ = pgtype.UUID{}
}

func TestMythicalItemsSurviveFailuresAndStayBound(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()

	// An outsider's issue is approved only by a maintainer's label on that
	// exact text; an edit afterwards needs a new label.
	outsider := mythicalIssue{Number: 21, Title: "Outsider", Body: "do x", State: "open", AuthorAssociation: "NONE", Labels: []string{"smithers"}}
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, outsider, ""))
	assert.Equal(t, "skipped", o.item(21).State, "a label seen only in a sweep may predate an edit")
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, outsider, "labeled"))
	assert.Equal(t, "queued", o.item(21).State)
	assert.Equal(t, "do x", o.item(21).IssueBody, "the admitted text is pinned")
	edited := outsider
	edited.Body = "do something else entirely"
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, edited, "edited"))
	assert.Equal(t, "skipped", o.item(21).State)
	assert.Contains(t, o.item(21).Reason, "re-applies the smithers label")
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, edited, "labeled"))
	assert.Equal(t, "queued", o.item(21).State)
	assert.Equal(t, "do something else entirely", o.item(21).IssueBody)

	// A lost launch leaves the item exactly as it was; the next claim
	// launches once, under the attempt's own request id.
	o.launcher.fail = 1
	o.wake()
	assert.Equal(t, "queued", o.item(21).State)
	assert.Empty(t, o.launcher.requests)
	o.wake()
	item := o.item(21)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.launcher.requests, 1)
	assert.Len(t, o.lanes.created, 1, "the bound lane is found again, never duplicated")

	// A lane the sweep retired while its launch kept failing never strands
	// the item: the next attempt binds the next name in the series.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at = NOW() WHERE workspace_id = $1`, item.WorkspaceID)
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET state = 'queued', workspace_id = '', generation = generation - 1, attempt = attempt - 1,
		version = version + 1 WHERE id = $1`, item.ID)
	require.NoError(t, err)
	o.launcher.mu.Lock()
	o.launcher.requests = nil
	o.launcher.mu.Unlock()
	o.wake()
	item = o.item(21)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.lanes.created, 2)
	rebound, err := db.New(o.pool).GetMythicalLane(ctx, item.WorkspaceID)
	require.NoError(t, err)
	assert.True(t, strings.HasSuffix(rebound.Name, " r1"), rebound.Name)
	require.Len(t, o.launcher.requests, 1)
	var payload struct {
		Prompt string `json:"prompt"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.requests[0].Payload, &payload))
	assert.Contains(t, payload.Prompt, "<issue>\ndo something else entirely\n</issue>")

	// A result must come from this lane's current run, on its tip, and be
	// retained by the lane workspace itself.
	o.project(o.launcher.requests[0], jobs.StateCompleted, "run-21", validatedRequest)
	o.wake()
	require.Equal(t, "delivering", o.item(21).State)
	stack, err := db.New(o.pool).GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, map[string]string{"x.txt": "x\n"}, "✨ feat: x")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "some-other-run", Summary: "✨ feat: x"})
	require.Error(t, err)
	unretained := strings.Repeat("9", 40)
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: unretained, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.Error(t, err)
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID+1, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.Error(t, err, "only the stack's account submits")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.NoError(t, err)
	lane := item.WorkspaceID

	// A workspace the stack never bound hands a chat result only when it is
	// a live workspace of the stack's account.
	chat := uuid.NewString()
	chatResult := o.laneResult(chat, stack.TipCommit, map[string]string{"y.txt": "y\n"}, "✨ feat: y")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: chat, Base: stack.TipCommit,
		Source: chatResult, RequestRunID: "chat-run", Summary: "✨ feat: y"})
	require.Error(t, err, "an unowned or deleted workspace is not a chat source")
	o.lanes.mu.Lock()
	o.lanes.owned = map[string]bool{chat: true}
	o.lanes.mu.Unlock()
	receipt, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: chat, Base: stack.TipCommit,
		Source: chatResult, RequestRunID: "chat-run", Summary: "✨ feat: y"})
	require.NoError(t, err)
	assert.Equal(t, "integrating", receipt.State)
	again, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: chat, Base: stack.TipCommit,
		Source: chatResult, RequestRunID: "chat-run", Summary: "✨ feat: y"})
	require.NoError(t, err)
	assert.Equal(t, receipt.ItemID, again.ItemID, "a replayed chat result is one item")

	// A proposal push that landed on GitHub but was never recorded is settled
	// from the branch, not pushed again or blocked.
	o.wake() // integrating -> proposing
	require.Equal(t, "proposing", o.item(21).State)
	item = o.item(21)
	main := o.git(o.github.dir, "rev-parse", "refs/heads/main")
	tree := o.hostTree(candidate)
	head := o.git(o.hostDir, "commit-tree", tree, "-p", main, "-m", "✨ feat: x")
	o.git(o.hostDir, "update-ref", repohost.MythicalReservedRefNS+"keep/"+head, head)
	o.git(o.hostDir, "push", "-q", o.github.dir, head+":refs/heads/smithers/issue-21")
	pending, _ := json.Marshal(mythicalProposalOp{Branch: "smithers/issue-21", Expected: "", Head: head})
	item.PendingOp = pending
	_, err = db.New(o.pool).SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	o.wake()
	item = o.item(21)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Equal(t, head, item.PRHead)
	assert.Empty(t, item.PendingOp)

	// A retired lane's results never reach the stack again, as a lane or as chat.
	assert.Contains(t, o.lanes.deleted, lane)
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: lane, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.Error(t, err)

	// A rejected item retried proposes on a new branch, never its closed PR.
	o.github.mu.Lock()
	o.github.pulls[item.PRNumber.Int64].State = "closed"
	o.github.mu.Unlock()
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "rejected", o.item(21).State)
	view, err := o.service.RetryItem(ctx, o.repoID, uuidString(item.ID))
	require.NoError(t, err)
	assert.Equal(t, "queued", view.State)
	retried := o.item(21)
	assert.False(t, retried.PRNumber.Valid)
	assert.Equal(t, "smithers/issue-21-r1", mythicalBranch(retried))
}
