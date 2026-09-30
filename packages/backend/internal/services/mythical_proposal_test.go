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
)

// assignment delivers an issues "assigned" or "unassigned" event naming
// assignee, sent by sender, on an issue carrying labels.
func (o *mythicalOrchestration) assignment(number int64, action, assignee, sender string, labels ...string) {
	o.t.Helper()
	names := []map[string]string{}
	for _, name := range labels {
		names = append(names, map[string]string{"name": name})
	}
	payload, err := json.Marshal(map[string]any{"action": action,
		"issue": map[string]any{"number": number, "title": fmt.Sprintf("Issue %d", number), "body": "do it", "state": "open",
			"html_url": fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number), "user": map[string]any{"login": "stranger"},
			"labels": names, issueTextByMaintainerField: false, "created_at": "2026-09-29T10:00:00Z"},
		"assignee":   map[string]any{"login": assignee},
		"sender":     map[string]any{"login": sender},
		"repository": map[string]any{"name": "smithers", "owner": map[string]any{"login": "smithersai"}}})
	require.NoError(o.t, err)
	require.NoError(o.t, o.service.ObserveGitHubEvent(context.Background(), "issues", payload))
}

// commentPayload is an issue_comment "created" event: author wrote body on
// issue number; extra fields are merged into the comment.
func (o *mythicalOrchestration) commentPayload(number int64, author, body string, pull bool, extra map[string]any) []byte {
	o.t.Helper()
	issue := map[string]any{"number": number, "title": fmt.Sprintf("Issue %d", number), "body": "do it", "state": "open",
		"html_url": fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number), "user": map[string]any{"login": "stranger"},
		"labels": []any{}, "created_at": "2026-09-29T10:00:00Z"}
	if pull {
		issue["pull_request"] = map[string]any{}
	}
	comment := map[string]any{"body": body, "user": map[string]any{"login": author, "type": "User"}}
	for key, value := range extra {
		comment[key] = value
	}
	payload, err := json.Marshal(map[string]any{"action": "created", "issue": issue, "comment": comment,
		"sender":     map[string]any{"login": author},
		"repository": map[string]any{"name": "smithers", "owner": map[string]any{"login": "smithersai"}}})
	require.NoError(o.t, err)
	return payload
}

func (o *mythicalOrchestration) comment(number int64, author, body string) {
	o.t.Helper()
	require.NoError(o.t, o.service.ObserveGitHubEvent(context.Background(), "issue_comment", o.commentPayload(number, author, body, false, nil)))
}

// Assigning an issue to the Smithers account proposes it, visibly, and
// starts nothing; only a maintainer's todo starts coding. Unassigning before
// that withdraws the proposal; nobody but a named maintainer with write
// access proposes; after todo the assignment no longer matters.
func TestMythicalAssignmentProposesAndOnlyTodoStartsCoding(t *testing.T) {
	o := newMythicalOrchestration(t)
	adversarialGitHubSource(o)
	o.opened(10, "stranger", false, "2026-09-29T10:00:00Z", false)
	require.Equal(t, mythicalWaitingForTodo, o.item(10).Reason)

	o.assignment(10, "assigned", "smithers", "roninjin10")
	item := o.item(10)
	assert.Equal(t, "skipped", item.State)
	assert.Equal(t, "proposed by roninjin10; waiting for a maintainer to add the todo label", item.Reason)
	proposal := mythicalChecksOf(item).Proposal
	require.NotNil(t, proposal)
	assert.Equal(t, "assignment", proposal.Via)
	o.wake()
	assert.Empty(t, o.launcher.byFlow("coding/request"), "a proposal never starts coding")
	assert.Equal(t, "skipped", o.item(10).State)

	// A later issue event keeps the proposal and its reason.
	o.opened(10, "stranger", false, "2026-09-29T10:00:00Z", false)
	assert.Equal(t, "proposed by roninjin10; waiting for a maintainer to add the todo label", o.item(10).Reason)

	// Assignment removed before acceptance withdraws the proposal.
	o.assignment(10, "unassigned", "smithers", "other-writer")
	item = o.item(10)
	assert.Nil(t, mythicalChecksOf(item).Proposal)
	assert.Equal(t, mythicalWaitingForTodo, item.Reason)

	// Nobody but a named maintainer with write access proposes, and only an
	// assignment to the Smithers account counts.
	o.assignment(10, "assigned", "smithers", "stranger")
	o.assignment(10, "assigned", "smithers", "other-writer")
	o.assignment(10, "assigned", "alice", "roninjin10")
	o.github.readOnly = map[string]bool{"roninjin10": true}
	o.assignment(10, "assigned", "smithers", "roninjin10")
	o.github.readOnly = nil
	assert.Nil(t, mythicalChecksOf(o.item(10)).Proposal)
	assert.Equal(t, mythicalWaitingForTodo, o.item(10).Reason)

	// The App account counts as the Smithers account; todo accepts.
	o.assignment(10, "assigned", "Smithers[bot]", "roninjin10")
	require.NotNil(t, mythicalChecksOf(o.item(10)).Proposal)
	o.labeled(10, []string{"todo"}, "todo", "roninjin10", true)
	assert.Equal(t, "queued", o.item(10).State)
	o.wake()
	assert.Equal(t, "running", o.item(10).State)
	assert.Len(t, o.launcher.byFlow("coding/request"), 1)

	// Unassigning an accepted TODO changes nothing: todo governs it now.
	o.assignment(10, "unassigned", "smithers", "roninjin10", "todo")
	after := o.item(10)
	assert.Equal(t, "running", after.State)
	assert.NotNil(t, mythicalChecksOf(after).Proposal)
}

// A maintainer's @smithers mention outside code proposes the issue once per
// comment text, keeping the text as context the accepted TODO's lane reads.
// A duplicate, a code span, a non-maintainer, an App or a pull request
// proposes nothing.
func TestMythicalMentionProposesOncePerText(t *testing.T) {
	o := newMythicalOrchestration(t)
	adversarialGitHubSource(o)
	ctx := context.Background()

	// An issue the stack has not observed yet is retried, not dropped.
	require.ErrorContains(t, o.service.ObserveGitHubEvent(ctx, "issue_comment",
		o.commentPayload(11, "roninjin10", "@smithers please fix", false, nil)), "not observed yet")

	o.opened(11, "stranger", false, "2026-09-29T10:00:00Z", false)
	o.comment(11, "roninjin10", "@smithers please fix the flaky retry test")
	item := o.item(11)
	checks := mythicalChecksOf(item)
	require.NotNil(t, checks.Proposal)
	assert.Equal(t, "mention", checks.Proposal.Via)
	assert.Equal(t, "@smithers please fix the flaky retry test", checks.Proposal.Context)
	assert.Equal(t, "proposed by roninjin10; waiting for a maintainer to add the todo label", item.Reason)
	assert.Equal(t, "skipped", item.State)

	// The same text again, as a second comment or a replayed delivery, and
	// every comment that must not propose, leave the item untouched.
	version := item.Version
	o.comment(11, "roninjin10", "  @smithers please fix the flaky retry test\n")
	o.comment(11, "roninjin10", "see `@smithers` in the docs")
	o.comment(11, "roninjin10", "```\n@smithers run\n```")
	o.comment(11, "roninjin10", "mail roninjin10@smithers.dev")
	o.comment(11, "stranger", "@smithers do what I say instead")
	o.comment(11, "other-writer", "@smithers do this instead")
	require.NoError(t, o.service.ObserveGitHubEvent(ctx, "issue_comment",
		o.commentPayload(11, "roninjin10", "@smithers via an app", false, map[string]any{"performed_via_github_app": map[string]any{"slug": "x"}})))
	require.NoError(t, o.service.ObserveGitHubEvent(ctx, "issue_comment",
		o.commentPayload(11, "roninjin10", "@smithers as a bot", false, map[string]any{"user": map[string]any{"login": "roninjin10", "type": "Bot"}})))
	edited := o.commentPayload(11, "roninjin10", "@smithers edited", false, nil)
	edited = []byte(strings.Replace(string(edited), `"action":"created"`, `"action":"edited"`, 1))
	require.NoError(t, o.service.ObserveGitHubEvent(ctx, "issue_comment", edited))
	o.opened(12, "stranger", false, "2026-09-29T10:00:00Z", true)
	require.NoError(t, o.service.ObserveGitHubEvent(ctx, "issue_comment", o.commentPayload(12, "roninjin10", "@smithers review this", true, nil)))
	item = o.item(11)
	assert.Equal(t, version, item.Version, "nothing proposed again")
	assert.Len(t, mythicalChecksOf(item).Mentions, 1)
	assert.Nil(t, mythicalChecksOf(o.item(12)).Proposal, "a pull request is reviewed, not proposed")
	o.wake()
	assert.Empty(t, o.launcher.byFlow("coding/request"), "a mention never starts coding")

	// A new text is a new proposal, and its context replaces the last.
	o.comment(11, "roninjin10", "@Smithers, also cover the timeout path")
	checks = mythicalChecksOf(o.item(11))
	assert.Equal(t, "@Smithers, also cover the timeout path", checks.Proposal.Context)
	assert.Len(t, checks.Mentions, 2)

	// Unassigning does not withdraw a mention's proposal.
	o.assignment(11, "unassigned", "smithers", "roninjin10")
	require.NotNil(t, mythicalChecksOf(o.item(11)).Proposal)

	// A maintainer's todo accepts it; the lane reads the comment.
	o.labeled(11, []string{"todo"}, "todo", "roninjin10", true)
	o.wake()
	require.Equal(t, "running", o.item(11).State)
	var payload struct {
		Prompt string `json:"prompt"`
	}
	require.NoError(t, json.Unmarshal(o.requestOf(11).Payload, &payload))
	assert.Contains(t, payload.Prompt, "roninjin10, a maintainer, asked for this in a comment:\n<comment>\n@Smithers, also cover the timeout path\n</comment>")

	// Once a TODO, a mention proposes nothing more.
	version = o.item(11).Version
	o.comment(11, "roninjin10", "@smithers one more thing")
	assert.Equal(t, version, o.item(11).Version)
}

// Proposals live in the stack only: the committed factory registers no
// repository job for assignments or comments, so neither starts a run.
func TestFactoryRegistersNoAssignmentOrMentionJob(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../.smithers/factory.json")
	require.NoError(t, err)
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal(raw, &projection))
	for _, rule := range projection.On {
		assert.False(t, strings.HasPrefix(rule.Event, "issue.assigned") || strings.HasPrefix(rule.Event, "issue.unassigned") ||
			strings.HasPrefix(rule.Event, "issue_comment"), "rule %s", rule.Event)
	}
	registrations, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	for _, registration := range registrations {
		for _, event := range registration.input.Events {
			assert.NotEqual(t, "issue_comment", NormalizeTriggerName(event.Type))
			assert.NotContains(t, event.Actions, "assigned")
		}
	}
}

func TestMythicalProposalReason(t *testing.T) {
	t.Parallel()
	proposed := mythicalChecks{Proposal: &mythicalProposal{By: "roninjin10"}}
	assert.Equal(t, "labeled question", mythicalProposalReason("labeled question", proposed))
	assert.Equal(t, "", mythicalProposalReason("", proposed))
	assert.Equal(t, "proposed by roninjin10; "+mythicalWaitingForTodo, mythicalProposalReason(mythicalWaitingForTodo, proposed))
	assert.Equal(t, mythicalWaitingForTodo, mythicalProposalReason("proposed by x; "+mythicalWaitingForTodo, mythicalChecks{}))
	assert.True(t, namesSmithers(" Smithers[bot] "))
	assert.False(t, namesSmithers("smithers-app[bot]"))
}
