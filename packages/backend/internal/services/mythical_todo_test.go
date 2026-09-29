package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

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
