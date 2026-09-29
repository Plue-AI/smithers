package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// mythicalPolicy is a committed projection naming roninjin10 as the
// maintainer, with the auto-TODO rule active since since ("" = never).
func mythicalPolicy(since string) string {
	policy := map[string]any{"mirror": "pull", "issues": "two-way", "changes": "send-upstream", "maintainers": []string{"roninjin10"}}
	if since != "" {
		policy["todoSince"] = since
	}
	raw, _ := json.Marshal(map[string]any{"on": []any{}, "github": policy})
	return string(raw)
}

// labeled delivers a GitHub "labeled" issues event through the stack's
// webhook entry, from sender, stamped as GitHubTextStamper stamps it
// (person: a person with write access, not an App, applied it).
func (o *mythicalOrchestration) labeled(number int64, labels []string, label, sender string, person bool) {
	o.t.Helper()
	names := []map[string]string{}
	for _, name := range labels {
		names = append(names, map[string]string{"name": name})
	}
	payload, err := json.Marshal(map[string]any{
		"action": "labeled",
		"issue": map[string]any{"number": number, "title": fmt.Sprintf("TODO %d", number), "body": "add the file",
			"html_url": fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number), "state": "open",
			"user": map[string]any{"login": "fucory"}, "labels": names, issueTextByMaintainerField: true,
			"created_at": "2026-01-01T00:00:00Z"},
		"label":      map[string]any{"name": label, labelAppliedByMaintainerField: person},
		"sender":     map[string]any{"login": sender},
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
	o.labeled(60, []string{"bug"}, "bug", "roninjin10", true)
	assert.Equal(t, "skipped", o.item(60).State)
	assert.Equal(t, "waiting for a maintainer to add the todo label", o.item(60).Reason)

	// Someone else's todo label is ignored and reverted, even from another
	// person with write access: only the policy's maintainers count.
	o.labeled(60, []string{"bug", "todo"}, "todo", "stranger", false)
	assert.Equal(t, "skipped", o.item(60).State)
	o.labeled(60, []string{"bug", "todo"}, "todo", "other-writer", true)
	assert.Equal(t, "skipped", o.item(60).State)
	assert.Equal(t, []string{"#60 todo", "#60 todo"}, o.github.removed)

	// The maintainer's todo label makes it a TODO.
	o.labeled(60, []string{"bug", "todo"}, "todo", "roninjin10", true)
	assert.Equal(t, "queued", o.item(60).State)
	assert.True(t, mythicalChecksOf(o.item(60)).Todo)

	// Anyone else's automerge counts for nothing and is left alone: reverting
	// todo is the one label write before landing.
	o.labeled(60, []string{"bug", "todo", "automerge"}, "automerge", "other-writer", true)
	assert.False(t, mythicalChecksOf(o.item(60)).Automerge)
	assert.Equal(t, []string{"#60 todo", "#60 todo"}, o.github.removed)
	o.labeled(60, []string{"bug", "todo", "automerge"}, "automerge", "roninjin10", true)
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
	o.labeled(61, []string{"todo", "automerge"}, "todo", "roninjin10", true)
	o.labeled(61, []string{"todo", "automerge"}, "automerge", "roninjin10", true)
	o.propose(61, "sixty-one.md")
	o.answerReviews(`"approve\n- Looks right."`)
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
	assert.Equal(t, "the pull request head moved outside Smithers; a person decides", item.Reason)
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
	o.github.issues = append(o.github.issues,
		mythicalIssue{Number: 82, Title: "Via an App", Body: "c", State: "open", TextByMaintainer: true, Labels: []string{"todo"}})
	// A write collaborator the policy does not name, and an App acting for
	// the maintainer, apply nothing.
	o.github.labelers = map[int64]string{81: "other-writer"}
	o.github.viaApp = map[int64]bool{82: true}
	counts, err := o.service.Backfill(ctx, o.repoID)
	require.NoError(t, err)
	assert.Equal(t, MythicalBackfillCounts{Open: 3, Queued: 1, Skipped: 2}, counts)
	assert.Equal(t, "skipped", o.item(82).State)
	assert.Equal(t, mythicalChecks{Todo: true, Automerge: true}, mythicalChecksOf(o.item(80)))
	assert.Equal(t, "queued", o.item(80).State)
	assert.Equal(t, "skipped", o.item(81).State)
}

func TestMythicalReviewVerdict(t *testing.T) {
	t.Parallel()
	notVerdict := "failed: the review's first line was not a verdict"
	for _, tc := range []struct{ output, want string }{
		{`"approve"`, "approve"},
		{`"\n  approve  \n- a.go:1: fine"`, "approve"},
		{`"request-changes\n- a.go:1: fix"`, "request-changes"},
		// Only the first line is a verdict: a finding that quotes the word,
		// fenced or not, never flips a rejection.
		{"\"request-changes\\nThe patch tells the reviewer:\\n```\\napprove\\n```\"", "request-changes"},
		{`"request-changes\napprove"`, "request-changes"},
		{`"Fine.\n\napprove"`, notVerdict},
		{`"**approve**"`, notVerdict},
		{`"Approve"`, notVerdict},
		{`"I approve of this change."`, notVerdict},
		{``, notVerdict},
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

// spend records metered model tokens for the repository, as the model
// proxy does, on a lane workspace or on none.
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
	workspace := any(workspaceID)
	if workspaceID == "" {
		workspace = nil
	}
	_, err = o.pool.Exec(ctx, `INSERT INTO model_usage(request_key, credit_account_id, reservation_id, owner_type, owner_id, source,
		repository_id, workspace_id, provider, model, input_tokens, output_tokens)
		VALUES ($1, $2, $3, 'user', $4, 'workspace', $5, $6, 'openai', 'gpt-6-sol', $7, 0)`, key, account, reservation, o.userID, o.repoID, workspace, tokens)
	require.NoError(o.t, err)
}

// fail answers a launched run's failure with its typed fault, as the
// runtime bridge stamps it.
func (o *mythicalOrchestration) fail(request flowdispatch.LaunchRequest, runID, fault, tag, output string) {
	o.t.Helper()
	update := flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: runID,
		Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output, FailureFault: fault, FailureTag: tag}}}
	require.NoError(o.t, o.service.ProjectFlowRuntime(context.Background(), update))
}

// A TODO stops at its launch bound, however few tokens its runs spent, and
// says so once; only a person resumes it, and its bound then counts again.
func TestMythicalTodoStopsAtItsLaunchBound(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	issue := mythicalIssue{Number: 90, Title: "Bound", State: "open", TextByMaintainer: true, Labels: []string{"todo"}}
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	for i := 0; ; i++ {
		o.wake()
		item := o.item(90)
		if item.State == "blocked" {
			break
		}
		require.Equal(t, "running", item.State, item.Reason)
		require.Less(t, i, 40)
		o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-%d", i), "infra", "flows/InfraInterrupt", "")
		o.wake()
		// Outages alone would park it first (mythicalOutageBound); this test
		// clears them so only the launch bound is left to stop it.
		_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET checks = checks - 'outages' WHERE repository_id = $1`, o.repoID)
		require.NoError(t, err)
	}
	item := o.item(90)
	assert.Equal(t, "it launched 12 runs, the bound for one TODO, which usually means something went wrong", item.Reason)
	assert.Equal(t, &mythicalFault{Class: "policy", Tag: "launch_bound"}, mythicalChecksOf(item).Fault)
	launched := len(o.launcher.requests)
	o.wake()
	assert.Len(t, o.launcher.requests, launched, "nothing more launches")
	assert.Equal(t, []string{"#90 Smithers stopped this TODO: it launched 12 runs, the bound for one TODO, which usually means something went wrong."}, o.github.comments)
	assert.NotContains(t, o.github.comments[0], "SMITHERS_", "the issue names no operator setting")

	// A run cannot lift the bound; a person can, and a maintainer's todo can.
	_, err := o.service.RetryItem(mythicalRunContext(ctx, o.userID), o.repoID, uuidString(item.ID))
	requireRunCredentialRefused(t, err)
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	o.wake()
	assert.Equal(t, "running", o.item(90).State)
	assert.EqualValues(t, o.item(90).Generation-1, mythicalChecksOf(o.item(90)).LaunchBase)
}

// While the factory's daily token budget is spent, nothing new launches;
// usage recorded without a workspace counts too.
func TestMythicalDailyBudgetHoldsNewWork(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	o.service.SetPolicyReader(policyHost{`{"on":[],"github":{"mirror":"pull","issues":"two-way","changes":"send-upstream","maintainers":["roninjin10"],"dailyTokens":1000}}`})
	o.spend("", 600)
	o.spend(uuid.NewString(), 500)
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 91, Title: "Budget", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	o.wake()
	item := o.item(91)
	assert.Equal(t, "queued", item.State)
	assert.Equal(t, "the factory's daily token budget is spent; work resumes at 00:00 UTC", item.Reason)
	assert.Empty(t, o.launcher.requests)
	assert.Equal(t, time.Now().UTC().Truncate(24*time.Hour).Add(24*time.Hour), item.NextAttemptAt.Time.UTC())
}

// An outage is not the plan's failure: three provider quota failures cost
// the TODO no attempt, back off, and the prompt never says the work failed;
// past the bound the TODO parks loudly instead of retrying forever.
func TestMythicalOutagesSpendNoAttempt(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 95, Title: "Outage", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	for i := range 3 {
		o.wake()
		require.Equal(t, "running", o.item(95).State)
		o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-quota-%d", i), "wait", "flows/model/ModelError/quota_exceeded", "")
		o.wake()
		item := o.item(95)
		require.Equal(t, "retrying", item.State)
		assert.EqualValues(t, 0, item.Attempt, "the attempt is run again, not spent")
		assert.Equal(t, "the lane's request ended outage: wait: flows/model/ModelError/quota_exceeded; this is not the TODO's fault, Smithers retries it", item.Reason)
		assert.Equal(t, i+1, mythicalChecksOf(item).Outages)
		assert.WithinDuration(t, time.Now().Add(time.Duration(1<<(i+1))*time.Minute), item.NextAttemptAt.Time, time.Minute, "backs off")
	}
	o.propose(95, "ninety-five.md")
	item := o.item(95)
	assert.EqualValues(t, 1, item.Attempt, "it lands on its first attempt")
	assert.Equal(t, 0, mythicalChecksOf(item).Outages, "a validated request clears the outages")
	var payload struct {
		Prompt string `json:"prompt"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.last("coding/request").Payload, &payload))
	assert.NotContains(t, payload.Prompt, "did not finish")

	// Past the bound, an outage parks the TODO loudly.
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 96, Title: "Down", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	for i := 0; i <= mythicalOutageBound; i++ {
		o.wake()
		require.Equal(t, "running", o.item(96).State)
		o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-down-%d", i), "", "", "")
		o.wake()
	}
	o.wake()
	item = o.item(96)
	assert.Equal(t, "blocked", item.State)
	assert.Equal(t, &mythicalFault{Class: "policy", Tag: "outages"}, mythicalChecksOf(item).Fault)
	assert.Contains(t, item.Reason, "Smithers could not run it after 7 tries")
	assert.Contains(t, item.Reason, "not the TODO's fault")
}

// A person cancelling a run stops the TODO; it never relaunches on its own.
func TestMythicalCancelledRunStopsTheTodo(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 97, Title: "Cancel", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	o.wake()
	o.project(o.launcher.last("coding/request"), jobs.StateCancelled, "run-97", "")
	o.wake()
	o.wake()
	item := o.item(97)
	assert.Equal(t, "blocked", item.State)
	assert.Equal(t, "the run was cancelled", item.Reason)
	assert.Len(t, o.launcher.requests, 1)
}

// Every attempt's plan failing continues once more on the last plan,
// marked very hard, then stops for a person with one comment each.
func TestMythicalVeryHardContinuesOnceThenStops(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 98, Title: "Hard", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	for i := range mythicalAttempts + 1 {
		o.wake()
		require.Equal(t, "running", o.item(98).State, o.item(98).Reason)
		o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-hard-%d", i), "factory", "coding/Error/stalled", "")
		o.wake()
		if i == mythicalAttempts-1 {
			item := o.item(98)
			assert.Equal(t, "retrying", item.State)
			assert.True(t, mythicalChecksOf(item).VeryHard)
			assert.EqualValues(t, mythicalAttempts-1, item.Attempt, "the continuation keeps the last attempt")
		}
	}
	item := o.item(98)
	assert.Equal(t, "blocked", item.State)
	assert.True(t, strings.HasPrefix(item.Reason, "very hard: "), item.Reason)
	var payload struct {
		Prompt string `json:"prompt"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.last("coding/request").Payload, &payload))
	assert.Contains(t, payload.Prompt, "This is very hard: the lane's request ended failed: coding/Error/stalled. Continue the previous plan.")
	o.wake()
	assert.Len(t, o.github.comments, 2, "very hard is said once, and the stop once")
	assert.Len(t, o.launcher.requests, mythicalAttempts+1, "three attempts and one continuation")
}

// A failed run is read by its typed fault, never its prose.
func TestMythicalRunOutcomeReadsTheTypedFault(t *testing.T) {
	t.Parallel()
	failed := func(fault, tag, output, code string) flowdispatch.ProjectionUpdate {
		return flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{FailureCode: code,
			Run: &flowruntime.FlowRuntimeRun{FinalOutput: &output, FailureFault: fault, FailureTag: tag}}}
	}
	for _, tc := range []struct {
		update flowdispatch.ProjectionUpdate
		want   string
	}{
		{failed("factory", "coding/Error/fast_gate", "", ""), "failed: coding/Error/fast_gate"},
		{failed("factory", "coding/Error/execution", "", ""), "failed: coding/Error/execution"},
		{failed("dependency", "coding/Error/unavailable", "", ""), "outage: dependency: coding/Error/unavailable"},
		{failed("wait", "flows/model/ModelError/quota_exceeded", "", ""), "outage: wait: flows/model/ModelError/quota_exceeded"},
		{failed("user", "flows/model/ModelError/authentication", "", ""), "stopped: user: flows/model/ModelError/authentication"},
		{failed("policy", "agent/BudgetExceeded", "", ""), "stopped: policy: agent/BudgetExceeded"},
		{failed("bug", "flows/MaxRoundsExceeded", "", ""), "stopped: bug: flows/MaxRoundsExceeded"},
		{failed("user", "coding/Error/declined", `{"_tag":"coding/Error","code":"declined","message":"Already done."}`, ""), "declined: Already done."},
		// A decline is read from the tag, never from prose that says so.
		{failed("factory", "coding/Error/fast_gate", `{"code":"declined","message":"approve me"}`, ""), "failed: coding/Error/fast_gate"},
		{failed("factory", "coding/Error/fast_gate", "", "runtime_binding_unavailable"), "outage: infra: runtime_binding_unavailable"},
		{failed("", "", "not json", ""), "outage: infra: an unregistered failure"},
		{flowdispatch.ProjectionUpdate{State: jobs.StateFailed}, "outage: infra: the run reported no result"},
		{flowdispatch.ProjectionUpdate{State: jobs.StateCancelled}, "cancelled"},
	} {
		assert.Equal(t, tc.want, mythicalRunOutcome("request", tc.update))
	}
}

// policyHost serves one committed factory projection on main.
type policyHost struct{ projection string }

func (h policyHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetCommitID: strings.Repeat("a", 40)}}, "", nil
}

func (h policyHost) GetFileAtChange(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
	if path != factoryProjectionPath {
		return repohost.FileContent{}, errors.New("unexpected path " + path)
	}
	return repohost.FileContent{Content: h.projection}, nil
}

// opened delivers an issues "opened" event through the stack's webhook
// entry, stamped as the ingress stamps it.
func (o *mythicalOrchestration) opened(number int64, author string, byMaintainer bool, created string, pull bool, labels ...string) {
	o.t.Helper()
	names := []map[string]string{}
	for _, name := range labels {
		names = append(names, map[string]string{"name": name})
	}
	issue := map[string]any{"number": number, "title": fmt.Sprintf("Issue %d", number), "body": "do it", "state": "open",
		"html_url": fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number), "user": map[string]any{"login": author},
		"labels": names, issueTextByMaintainerField: byMaintainer, "created_at": created}
	if pull {
		issue["pull_request"] = map[string]any{}
	}
	payload, err := json.Marshal(map[string]any{"action": "opened", "issue": issue, "sender": map[string]any{"login": author},
		"repository": map[string]any{"name": "smithers", "owner": map[string]any{"login": "smithersai"}}})
	require.NoError(o.t, err)
	require.NoError(o.t, o.service.ObserveGitHubEvent(context.Background(), "issues", payload))
}

// An issue becomes a TODO without the label only when the maintainer the
// policy names wrote it after the rule took effect. The factory then applies
// the label, records why, and never reverts its own label; the item stays a
// TODO when the label write fails. Nothing else, and never the backlog.
func TestMythicalPolicyMakesTheMaintainersNewIssuesTodos(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	_, err := o.pool.Exec(ctx, `UPDATE repositories SET mirror_destination = 'https://github.com/smithersai/smithers' WHERE id = $1`, o.repoID)
	require.NoError(t, err)
	o.service.SetPolicyReader(policyHost{mythicalPolicy("2026-09-28T00:00:00Z")})
	after, before := "2026-09-29T10:00:00Z", "2026-09-27T10:00:00Z"

	o.opened(1, "roninjin10", true, after, false)
	item := o.item(1)
	assert.Equal(t, "queued", item.State, item.Reason)
	assert.Equal(t, "written by roninjin10, a maintainer", mythicalChecksOf(item).AutoTodo)
	o.opened(2, "other-writer", true, after, false)
	assert.Equal(t, "skipped", o.item(2).State, "another writer's issue waits for the label")
	o.opened(3, "stranger", false, after, false)
	assert.Equal(t, "skipped", o.item(3).State, "an outsider's issue waits for the label")
	o.opened(4, "roninjin10", false, after, false)
	assert.Equal(t, "skipped", o.item(4).State, "the maintainer's issue someone else rewrote waits")
	o.opened(5, "roninjin10", true, before, false)
	assert.Equal(t, "skipped", o.item(5).State, "the backlog from before the rule stays proposals")
	o.opened(6, "roninjin10", true, after, true)
	assert.Equal(t, "skipped", o.item(6).State, "a pull request is never a TODO")
	assert.Equal(t, []string{"#1 todo"}, o.github.added, "the factory labels only the TODO it made")

	// The App's own labeled event is not reverted; the item stays a TODO.
	o.labeled(1, []string{"todo"}, "todo", "smithers-app[bot]", false)
	assert.Empty(t, o.github.removed)
	assert.Equal(t, "queued", o.item(1).State)

	// The decision is the item's: an edit that arrives before the label (the
	// label write failed) keeps it a TODO, and the label is tried again.
	o.opened(7, "roninjin10", true, after, false)
	o.opened(7, "roninjin10", true, after, false)
	assert.Equal(t, "queued", o.item(7).State)
	assert.Equal(t, []string{"#1 todo", "#7 todo", "#7 todo"}, o.github.added, "each event retries the missing label")

	// A sweep of the backlog makes none of it a TODO.
	o.github.issues = []mythicalIssue{{Number: 8, Title: "Old", Body: "x", State: "open", TextByMaintainer: true,
		Author: gitHubActor{Login: "roninjin10"}, CreatedAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}}
	_, err = o.service.Backfill(ctx, o.repoID)
	require.NoError(t, err)
	assert.Equal(t, "skipped", o.item(8).State)

	// Without the rule's start, no issue is a TODO on its own.
	o.service.SetPolicyReader(policyHost{mythicalPolicy("")})
	o.opened(9, "roninjin10", true, after, false)
	assert.Equal(t, "skipped", o.item(9).State)
}

// Automerge also needs GitHub CI green on the exact approved head: it waits
// while CI runs, never merges on red, and merges pinned once green.
func TestMythicalAutomergeWaitsForGreenCIOnTheApprovedHead(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	issue := mythicalIssue{Number: 75, Title: "CI", State: "open", TextByMaintainer: true, Labels: []string{"todo", "automerge"}}
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, gitHubLabelApplication{Label: automergeLabel, ByMaintainer: true}))
	o.propose(75, "seventy-five.md")
	head := o.item(75).PRHead
	o.github.mu.Lock()
	o.github.ci = map[string]string{head: mythicalCIPending}
	o.github.mu.Unlock()
	o.answerReviews(`"approve"`)
	item := o.item(75)
	assert.Equal(t, "proposed", item.State)
	assert.Equal(t, "waiting for CI on the approved head", item.Reason)
	assert.Empty(t, o.github.merges)

	o.github.mu.Lock()
	o.github.ci[head] = mythicalCIRed
	o.github.mu.Unlock()
	o.wake()
	item = o.item(75)
	assert.Equal(t, "proposed", item.State)
	assert.Equal(t, "CI failed on the approved head", item.Reason)
	assert.Empty(t, o.github.merges, "never on red")

	o.github.mu.Lock()
	o.github.ci[head] = mythicalCIGreen
	o.github.mu.Unlock()
	o.wake()
	item = o.item(75)
	require.Equal(t, "landed", item.State, item.Reason)
	assert.Equal(t, map[int64]string{item.PRNumber.Int64: head}, o.github.merges, "merged at the head CI and the review passed")
}

// Right before the merge the stack reads the pull request and the label
// again: a head someone else pushed, or an automerge a maintainer took off,
// stops it and holds the TODO visibly with one comment; a refused merge
// holds it the same way, and a comment GitHub drops is posted later.
func TestMythicalAutomergeRereadsEverythingItRestsOn(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	start := func(number int64, file string) db.MythicalItem {
		issue := mythicalIssue{Number: number, Title: "Hold", State: "open", TextByMaintainer: true, Labels: []string{"todo", "automerge"}}
		require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
		require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, gitHubLabelApplication{Label: automergeLabel, ByMaintainer: true}))
		o.propose(number, file)
		return o.item(number)
	}

	// The automerge label was taken off after the stack saw it.
	item := start(76, "seventy-six.md")
	o.github.labelers = map[int64]string{76: "other-writer"}
	o.answerReviews(`"approve"`)
	item = o.item(76)
	assert.Equal(t, "proposed", item.State)
	assert.Equal(t, "a maintainer's automerge label is no longer on the issue", item.Reason)
	assert.False(t, mythicalChecksOf(item).Automerge)
	assert.Empty(t, o.github.merges)
	o.wake()
	assert.Equal(t, []string{"#76 Smithers is holding this TODO: a maintainer's automerge label is no longer on the issue."}, o.github.comments)
	o.wake()
	assert.Len(t, o.github.comments, 1, "said once")

	// Someone pushed to the pull request: its new head is theirs.
	item = start(77, "seventy-seven.md")
	head := item.PRHead
	o.git(o.github.dir, "update-ref", "refs/heads/smithers/issue-77",
		o.git(o.github.dir, "commit-tree", o.git(o.github.dir, "rev-parse", head+"^{tree}"), "-p", head, "-m", "a person's push"))
	o.answerReviews(`"approve"`)
	item = o.item(77)
	assert.Equal(t, "proposed", item.State)
	assert.Equal(t, "the pull request head moved outside Smithers; a person decides", item.Reason)
	assert.NotEmpty(t, mythicalChecksOf(item).ForeignHead)
	assert.Empty(t, o.github.merges)

	// A comment GitHub drops is owed and posted on a later pass.
	o.github.mu.Lock()
	o.github.commentErr = errors.New("GitHub is down")
	o.github.mu.Unlock()
	item = start(78, "seventy-eight.md")
	o.github.mu.Lock()
	o.github.ci = map[string]string{item.PRHead: mythicalCIRed}
	o.github.mu.Unlock()
	o.answerReviews(`"approve"`)
	assert.Equal(t, "CI failed on the approved head", o.item(78).Reason)
	require.NotNil(t, mythicalChecksOf(o.item(78)).Notice, "the comment is owed")
	o.github.mu.Lock()
	o.github.commentErr = nil
	o.github.mu.Unlock()
	o.wake()
	assert.Contains(t, o.github.comments, "#78 Smithers is holding this TODO: CI failed on the approved head.")
	assert.Nil(t, mythicalChecksOf(o.item(78)).Notice)
}

// A review whose first line is not a verdict holds the TODO visibly and
// says so once; it is reviewed again only on a new head.
func TestMythicalUnreadableReviewHoldsTheTodo(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	issue := mythicalIssue{Number: 79, Title: "Unread", State: "open", TextByMaintainer: true, Labels: []string{"todo", "automerge"}}
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, gitHubLabelApplication{Label: automergeLabel, ByMaintainer: true}))
	o.propose(79, "seventy-nine.md")
	o.answerReviews("\"Looks right to me.\\n\\napprove\"")
	item := o.item(79)
	assert.Equal(t, "proposed", item.State)
	assert.Equal(t, "the review of this head failed (the review's first line was not a verdict); a person decides", item.Reason)
	assert.Empty(t, o.github.merges)
	reviews := len(o.launcher.requests)
	o.wake()
	o.wake()
	assert.Len(t, o.launcher.requests, reviews, "the same head is not reviewed again")
	assert.Len(t, o.github.comments, 1)
}

// A running review holds one of the stack's lanes: a new TODO waits for it.
func TestMythicalReviewLanesCountTowardTheLaneCap(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	_, err := o.pool.Exec(ctx, `UPDATE mythical_stacks SET max_parallel = 1 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 85, Title: "First", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	o.propose(85, "eighty-five.md")
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, mythicalIssue{Number: 86, Title: "Second", State: "open", TextByMaintainer: true,
		Labels: []string{"todo"}}, maintainerTodo))
	o.wake()
	assert.Equal(t, "queued", o.item(86).State, "the review holds the only lane")
	o.answerReviews(`"request-changes"`)
	o.wake()
	assert.Equal(t, "running", o.item(86).State, "the lane is free once the review answers")
}
