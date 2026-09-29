package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// labeled delivers a GitHub "labeled" issues event through the stack's
// webhook entry, stamped as GitHubTextStamper stamps it.
func (o *mythicalOrchestration) labeled(number int64, labels []string, label string, byMaintainer bool) {
	o.t.Helper()
	names := []map[string]string{}
	for _, name := range labels {
		names = append(names, map[string]string{"name": name})
	}
	payload, err := json.Marshal(map[string]any{
		"action": "labeled",
		"issue": map[string]any{"number": number, "title": fmt.Sprintf("TODO %d", number), "body": "add the file",
			"html_url": fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number), "state": "open",
			"user": map[string]any{"login": "fucory"}, "labels": names, issueTextByMaintainerField: true},
		"label":      map[string]any{"name": label, labelAppliedByMaintainerField: byMaintainer},
		"repository": map[string]any{"name": "smithers", "owner": map[string]any{"login": "smithersai"}},
	})
	require.NoError(o.t, err)
	require.NoError(o.t, o.service.ObserveGitHubEvent(context.Background(), "issues", payload))
}

// propose runs a queued TODO through its lane to an open pull request whose
// review is running, and answers the review's launch.
func (o *mythicalOrchestration) propose(number int64, file string) {
	o.t.Helper()
	ctx := context.Background()
	stack := o.wake()
	item := o.item(number)
	require.Equal(o.t, "running", item.State, item.Reason)
	o.project(o.launcher.last("coding/request"), jobs.StateCompleted, fmt.Sprintf("run-%d", number), validatedRequest)
	o.wake()
	candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, map[string]string{file: "x\n"}, "📝 docs: add "+file)
	_, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: fmt.Sprintf("run-%d", number), Summary: "📝 docs: add " + file})
	require.NoError(o.t, err)
	o.wake() // integrating -> proposing
	o.wake() // proposing -> proposed, review launched
	item = o.item(number)
	require.Equal(o.t, "proposed", item.State, item.Reason)
	require.True(o.t, mythicalChecksOf(item).reviewing(item), "change.opened starts the review")
}

// A TODO is an issue a maintainer person labeled todo. Its pull request is
// reviewed when it opens, and merged at the reviewed head only when the
// review approves and a maintainer person labeled it automerge. Anyone
// else's todo or automerge label counts for nothing and is taken off.
func TestMythicalTodoIsReviewedAndAutomerged(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	_, err := o.pool.Exec(ctx, `UPDATE repositories SET mirror_destination = 'https://github.com/smithersai/smithers' WHERE id = $1`, o.repoID)
	require.NoError(t, err)

	// An issue is a proposal: a maintainer's own text waits for the label.
	o.labeled(60, []string{"bug"}, "bug", true)
	assert.Equal(t, "skipped", o.item(60).State)
	assert.Equal(t, "waiting for a maintainer to add the todo label", o.item(60).Reason)

	// Someone else's todo label is ignored and reverted.
	o.labeled(60, []string{"bug", "todo"}, "todo", false)
	assert.Equal(t, "skipped", o.item(60).State)
	assert.Equal(t, []string{"#60 todo"}, o.github.removed)

	// A maintainer person's todo label makes it a TODO.
	o.labeled(60, []string{"bug", "todo"}, "todo", true)
	assert.Equal(t, "queued", o.item(60).State)
	assert.True(t, mythicalChecksOf(o.item(60)).Todo)

	// The same holds for automerge.
	o.labeled(60, []string{"bug", "todo", "automerge"}, "automerge", false)
	assert.False(t, mythicalChecksOf(o.item(60)).Automerge)
	assert.Equal(t, []string{"#60 todo", "#60 automerge"}, o.github.removed)
	o.labeled(60, []string{"bug", "todo", "automerge"}, "automerge", true)
	assert.True(t, mythicalChecksOf(o.item(60)).Automerge)
	assert.Equal(t, "queued", o.item(60).State)

	// The review requests changes: nothing merges; the pull request waits.
	o.propose(60, "sixty.md")
	o.answerReviews(`"request-changes\n- sixty.md:1: say why"`)
	item := o.item(60)
	assert.Equal(t, "request-changes", mythicalChecksOf(item).Review.Verdict)
	assert.Equal(t, "proposed", item.State)
	assert.Empty(t, o.github.merges)
	assert.Empty(t, item.WorkspaceID, "the lane is retired once the review answers")
	o.wake()
	assert.Len(t, o.launcher.requests, 3, "a head is reviewed once")

	// A second TODO: its review approves and it is merged at the reviewed
	// head, then lands.
	o.labeled(61, []string{"todo", "automerge"}, "todo", true)
	o.labeled(61, []string{"todo", "automerge"}, "automerge", true)
	o.propose(61, "sixty-one.md")
	o.answerReviews(`"Looks right.\n\n**approve**"`)
	item = o.item(61)
	require.Equal(t, "landed", item.State, item.Reason)
	assert.Equal(t, map[int64]string{item.PRNumber.Int64: item.PRHead}, o.github.merges)
	assert.Equal(t, "merged", item.PRState)
	assert.Equal(t, "squash-of-"+item.PRHead, item.PRMergeCommit)
	assert.Equal(t, "proposed", o.item(60).State, "the refused TODO still waits for a person")
}

// The merge is pinned to the reviewed head: a pull request whose branch
// moved after the review is not merged, and waits visibly.
func TestMythicalAutomergeRefusesAMovedHead(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 70, Title: "Move", State: "open", TextByMaintainer: true,
		Labels: []string{"todo", "automerge"}}, maintainerTodo))
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 70, Title: "Move", State: "open", TextByMaintainer: true,
		Labels: []string{"todo", "automerge"}}, gitHubLabelApplication{Label: automergeLabel, ByMaintainer: true}))
	o.propose(70, "seventy.md")
	head := o.item(70).PRHead
	moved := o.git(o.github.dir, "commit-tree", o.git(o.github.dir, "rev-parse", head+"^{tree}"), "-p", head, "-m", "outside push")
	o.git(o.github.dir, "update-ref", "refs/heads/smithers/issue-70", moved)
	o.answerReviews(`"approve"`)
	item := o.item(70)
	assert.Equal(t, "proposed", item.State)
	assert.Contains(t, item.Reason, "the approved pull request could not be merged")
	assert.Empty(t, o.github.merges)
}

// A sweep recovers label events the stack missed: a todo label a
// maintainer person applied admits a maintainer's issue; one anyone else
// applied does not.
func TestMythicalBackfillReadsWhoAppliedTheTodoLabel(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	o.github.issues = []mythicalIssue{
		{Number: 80, Title: "Missed", Body: "a", State: "open", TextByMaintainer: true, Labels: []string{"todo", "automerge"}},
		{Number: 81, Title: "Triaged", Body: "b", State: "open", TextByMaintainer: true, Labels: []string{"todo"}},
	}
	o.github.labelers = map[int64]string{81: "triager"}
	o.github.readOnly = map[string]bool{"triager": true}
	counts, err := o.service.Backfill(ctx, o.repoID)
	require.NoError(t, err)
	assert.Equal(t, MythicalBackfillCounts{Open: 2, Queued: 1, Skipped: 1}, counts)
	assert.Equal(t, mythicalChecks{Todo: true, Automerge: true}, mythicalChecksOf(o.item(80)))
	assert.Equal(t, "queued", o.item(80).State)
	assert.Equal(t, "skipped", o.item(81).State)
}

func TestMythicalReviewVerdict(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ output, want string }{
		{`"approve"`, "approve"},
		{`"Fine.\n\n**Approve**"`, "approve"},
		{"`request-changes`\n- a.go:1: fix", "request-changes"},
		{`"approve\nrequest-changes\n- a.go:3: late finding"`, "request-changes"},
		{`"I approve of this change."`, "failed: the review finished without a verdict"},
		{``, "failed: the review finished without a verdict"},
	} {
		assert.Equal(t, tc.want, mythicalReviewVerdict(tc.output), tc.output)
	}
}

// The stack is the one executor of the TODO rows of this repository's own
// factory: the factory reconciler registers no repository job for them, so
// one todo label never starts two runs.
func TestFactoryTodoRowsRegisterNoRepositoryJob(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../.smithers/factory.json")
	require.NoError(t, err)
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal(raw, &projection))
	events := map[string]bool{}
	for _, rule := range projection.On {
		events[rule.Event] = true
	}
	require.True(t, events["issue.labeled:todo"] && events["change.opened"] && events["change.updated"])
	registrations, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	for _, registration := range registrations {
		assert.Empty(t, registration.input.Events, "only schedules register: %s %s", registration.job, registration.input.FlowID)
	}
}

// spend records metered model tokens for a lane workspace, as the model
// proxy does.
func (o *mythicalOrchestration) spend(workspaceID string, tokens int64) {
	o.t.Helper()
	ctx := context.Background()
	var account, reservation int64
	key := uuid.NewString()
	_, err := o.pool.Exec(ctx, `INSERT INTO credit_accounts(owner_type, owner_id) VALUES ('user', $1) ON CONFLICT DO NOTHING`, o.userID)
	require.NoError(o.t, err)
	require.NoError(o.t, o.pool.QueryRow(ctx, `SELECT id FROM credit_accounts WHERE owner_type = 'user' AND owner_id = $1`, o.userID).Scan(&account))
	require.NoError(o.t, o.pool.QueryRow(ctx, `INSERT INTO credit_reservations(account_id, request_key, reserved_nanos)
		VALUES ($1, $2, 1) RETURNING id`, account, key).Scan(&reservation))
	_, err = o.pool.Exec(ctx, `INSERT INTO model_usage(request_key, credit_account_id, reservation_id, owner_type, owner_id, source,
		repository_id, workspace_id, provider, model, input_tokens, output_tokens)
		VALUES ($1, $2, $3, 'user', $4, 'workspace', $5, $6, 'openai', 'gpt-6-sol', $7, 0)`, key, account, reservation, o.userID, o.repoID, workspaceID, tokens)
	require.NoError(o.t, err)
}

// A TODO whose lanes spend past its cap stops before anything more
// launches, says so once on its issue, and resumes when a maintainer
// re-applies todo under a raised cap.
func TestMythicalTodoStopsAtItsSpendCap(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	o.service.todoTokenCap = 1_000
	issue := mythicalIssue{Number: 90, Title: "Spend", State: "open", TextByMaintainer: true, Labels: []string{"todo"}}
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	o.wake()
	item := o.item(90)
	require.Equal(t, "running", item.State)
	o.spend(item.WorkspaceID, 600)
	o.project(o.launcher.last("coding/request"), jobs.StateCompleted, "run-90", validatedRequest)
	o.wake()
	require.Equal(t, "delivering", o.item(90).State, "under the cap the TODO goes on")

	o.spend(item.WorkspaceID, 600)
	launched := len(o.launcher.requests)
	o.project(o.launcher.last("coding/vibe"), jobs.StateFailed, "run-vibe-90", "")
	o.wake()
	item = o.item(90)
	require.Equal(t, "blocked", item.State)
	assert.True(t, strings.HasPrefix(item.Reason, "budget_exceeded: this TODO spent 1200 tokens, past its cap of 1000."), item.Reason)
	assert.Len(t, o.launcher.requests, launched, "nothing more launches")
	assert.Empty(t, item.WorkspaceID, "its lane is retired")
	o.wake()
	require.Len(t, o.github.comments, 1, "the issue hears about it once")
	assert.Contains(t, o.github.comments[0], "#90 Smithers stopped work on this TODO: this TODO spent 1200 tokens")

	// Re-applying todo without raising the cap stops it again at once.
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	require.Equal(t, "queued", o.item(90).State)
	o.wake()
	require.Equal(t, "blocked", o.item(90).State)
	// Under a raised cap, re-applying todo resumes it; a plain issue event does not.
	o.service.todoTokenCap = 10_000
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, gitHubLabelApplication{}))
	require.Equal(t, "blocked", o.item(90).State)
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	o.wake()
	assert.Equal(t, "running", o.item(90).State)
}

func TestMythicalTodoTokenCapReadsOnlyAPositiveNumber(t *testing.T) {
	t.Parallel()
	for configured, want := range map[string]int64{"": 800_000_000, "abc": 800_000_000, "0": 800_000_000, "-5": 800_000_000, " 300000000 ": 300_000_000} {
		assert.Equal(t, want, mythicalTodoTokenCap(configured), configured)
	}
}

// An outage is not the plan's failure: three provider quota failures cost
// the TODO no attempt, and the prompt never says the work failed.
func TestMythicalOutagesSpendNoAttempt(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 95, Title: "Outage", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	quota := `{"_tag":"flows/model/ModelError","code":"quota_exceeded","message":"no credits remaining"}`
	for i := range 3 {
		o.wake()
		require.Equal(t, "running", o.item(95).State)
		o.project(o.launcher.last("coding/request"), jobs.StateFailed, fmt.Sprintf("run-quota-%d", i), quota)
		o.wake()
		item := o.item(95)
		require.Equal(t, "retrying", item.State)
		assert.EqualValues(t, 0, item.Attempt, "the attempt is run again, not spent")
		assert.Equal(t, "outage: failed; this is not the TODO's fault, Smithers retries it", item.Reason)
	}
	o.propose(95, "ninety-five.md")
	item := o.item(95)
	assert.EqualValues(t, 1, item.Attempt, "it lands on its first attempt")
	assert.Equal(t, "proposed", item.State)
	var payload struct {
		Prompt string `json:"prompt"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.last("coding/request").Payload, &payload))
	assert.NotContains(t, payload.Prompt, "did not finish")
}

// A typed plan failure still spends an attempt, and an unparseable or
// bridge-refused failure is an outage.
func TestMythicalRunOutcomeSeparatesPlanFailuresFromOutages(t *testing.T) {
	t.Parallel()
	failed := func(output, code string) flowdispatch.ProjectionUpdate {
		return flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{FailureCode: code,
			Run: &flowruntime.FlowRuntimeRun{FinalOutput: &output}}}
	}
	for _, tc := range []struct {
		update flowdispatch.ProjectionUpdate
		want   string
	}{
		{failed(`{"_tag":"coding/Error","code":"fast_gate","message":"a.ts failed"}`, ""), "failed: fast_gate"},
		{failed(`{"_tag":"coding/Error","code":"stalled","message":"x"}`, ""), "failed: stalled"},
		{failed(`{"_tag":"coding/Error","code":"unavailable","message":"Jev down"}`, ""), "outage: failed"},
		{failed(`{"_tag":"coding/Error","code":"fast_gate","message":"x"}`, "runtime_binding_unavailable"), "outage: runtime_binding_unavailable"},
		{failed("not json", ""), "outage: failed"},
		{flowdispatch.ProjectionUpdate{State: jobs.StateCancelled}, "outage: cancelled"},
	} {
		assert.Equal(t, tc.want, mythicalRunOutcome("request", tc.update))
	}
}
