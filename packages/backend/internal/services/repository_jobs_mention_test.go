package services

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func mentionProjection(t *testing.T, on string) FactoryProjection {
	t.Helper()
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal([]byte(`{"flows":[{"id":"issue-triage","kind":"mdx","capabilities":["fs:read:**"],"flows":[],"budget":{"tokens":200000,"milliseconds":600000}}],"on":`+on+`}`), &projection))
	return projection
}

func TestFactoryMentionRules(t *testing.T) {
	t.Parallel()
	rules, err := factoryRegistrations(mentionProjection(t, `[
		{"event":"issue.assigned:@Smithers","flow":"issue-triage"},
		{"event":"issue_comment.created:@smithers","flow":"issue-triage"},
		{"event":"issue.labeled:todo","flow":"issue-triage"}]`), strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Len(t, rules, 3)
	for i, want := range []struct{ kind, action, mention, label string }{
		{"issue", "assigned", "smithers", ""},
		{"issue_comment", "created", "smithers", ""},
		{"issue", "labeled", "", "todo"},
	} {
		input := rules[i].input
		require.Equal(t, []RepositoryJobEventRule{{Type: want.kind, Actions: []string{want.action}}}, input.Events)
		require.Equal(t, want.mention, input.Mention, "a login is lowercased and never a label")
		require.Equal(t, want.label, input.Label)
		input.WorkspaceID = repositoryJobTestInput().WorkspaceID
		input.Revision = 1
		_, err := validateRepositoryJob(rules[i].job, input, time.Now())
		require.NoError(t, err)
	}
	require.NotEqual(t, rules[0].input.Digest, rules[1].input.Digest)

	for _, event := range []string{"issue.opened:@smithers", "issue_comment.edited:@smithers", "pull_request.opened:@smithers", "issue.assigned:@", "issue.assigned:@-x", "issue_comment.created:@a b"} {
		_, err := factoryRegistrations(mentionProjection(t, `[{"event":"`+event+`","flow":"issue-triage"}]`), strings.Repeat("a", 40))
		require.ErrorContains(t, err, "a mention applies only to issue.assigned or issue_comment.created", event)
	}
}

func TestRepositoryJobMentionValidation(t *testing.T) {
	t.Parallel()
	input := repositoryJobTestInput()
	input.Events = []RepositoryJobEventRule{{Type: "issues", Actions: []string{"assigned"}}}
	input.Mention = "smithers"
	_, err := validateRepositoryJob("issues", input, time.Now())
	require.NoError(t, err)
	for name, edit := range map[string]func(*RegisterRepositoryJobInput){
		"uppercase":      func(i *RegisterRepositoryJobInput) { i.Mention = "Smithers" },
		"two actions":    func(i *RegisterRepositoryJobInput) { i.Events[0].Actions = []string{"assigned", "opened"} },
		"two events":     func(i *RegisterRepositoryJobInput) { i.Events = append(i.Events, i.Events[0]) },
		"other action":   func(i *RegisterRepositoryJobInput) { i.Events[0].Actions = []string{"opened"} },
		"comment edited": func(i *RegisterRepositoryJobInput) { i.Events[0] = RepositoryJobEventRule{Type: "issue_comment", Actions: []string{"edited"}} },
		"too long":       func(i *RegisterRepositoryJobInput) { i.Mention = strings.Repeat("a", 40) },
	} {
		changed := input
		changed.Events = slices.Clone(input.Events)
		changed.Events[0].Actions = slices.Clone(input.Events[0].Actions)
		edit(&changed)
		_, err := validateRepositoryJob("issues", changed, time.Now())
		require.ErrorContains(t, err, "a mention selects one issue assignment or comment creation", name)
	}
}

func mentionEvent(t *testing.T, kind, action string, maintainerIssue bool, extra map[string]any) db.RepositoryJobEvent {
	t.Helper()
	payload := map[string]any{"action": action, "issue": map[string]any{"number": 4, "title": "Crash", "body": "text", "smithers_text_by_maintainer": maintainerIssue, "labels": []any{}}}
	for key, value := range extra {
		payload[key] = value
	}
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	return db.RepositoryJobEvent{Source: "github", EventType: kind, EventAction: action, IssueNumber: 4, Payload: raw}
}

func TestRepositoryJobAssignmentProposesWork(t *testing.T) {
	t.Parallel()
	rule := repositoryJobTestInput()
	rule.Events = []RepositoryJobEventRule{{Type: "issue", Actions: []string{"assigned"}}}
	rule.Mention = "smithers"
	assigned := func(login string, maintainerIssue bool) db.RepositoryJobEvent {
		return mentionEvent(t, "issues", "assigned", maintainerIssue, map[string]any{"assignee": map[string]any{"login": login, "type": "Bot"}})
	}
	require.True(t, repositoryJobMatches(rule, assigned("smithers", true), nil), "assigned to the app starts intake")
	require.True(t, repositoryJobMatches(rule, assigned("Smithers[bot]", true), nil), "the GitHub App account is login[bot]")
	require.False(t, repositoryJobMatches(rule, assigned("someone", true), nil))
	require.False(t, repositoryJobMatches(rule, assigned("smithers-bot", true), nil))
	require.False(t, repositoryJobMatches(rule, assigned("smithers", false), nil), "assignment never approves an outsider's text (D-25)")
	require.False(t, repositoryJobMatches(rule, mentionEvent(t, "issues", "assigned", true, nil), nil), "an event without an assignee names no one")
	require.False(t, repositoryJobMatches(rule, mentionEvent(t, "issues", "opened", true, map[string]any{"assignee": map[string]any{"login": "smithers"}}), nil))
	bad := assigned("smithers", true)
	bad.Payload = json.RawMessage(`{"assignee":`)
	require.False(t, repositoryJobMatches(rule, bad, nil))
}

func TestRepositoryJobMentionProposesWork(t *testing.T) {
	t.Parallel()
	rule := repositoryJobTestInput()
	rule.Events = []RepositoryJobEventRule{{Type: "issue_comment", Actions: []string{"created"}}}
	rule.Mention = "smithers"
	comment := func(body string, byMaintainer, maintainerIssue bool) db.RepositoryJobEvent {
		return mentionEvent(t, "issue_comment", "created", maintainerIssue, map[string]any{"comment": map[string]any{"id": 9, "body": body, "smithers_text_by_maintainer": byMaintainer}})
	}
	for _, body := range []string{"@smithers please fix this", "Thoughts, @Smithers?", "(@smithers)", "cc @smithers.\n```\ncode\n```"} {
		require.True(t, repositoryJobMatches(rule, comment(body, true, true), nil), body)
	}
	for _, body := range []string{"`@smithers` is the bot", "```\n@smithers\n```", "~~~\n@smithers\n~~~", "mail me@smithers.dev", "@smithers-bot", "@smithersx", "smithers", "", "@@smithers"} {
		require.False(t, repositoryJobMatches(rule, comment(body, true, true), nil), "mention inside a code span is ignored: %q", body)
	}
	require.False(t, repositoryJobMatches(rule, comment("@smithers go", false, true), nil), "an outsider's comment approves nothing")
	require.False(t, repositoryJobMatches(rule, comment("@smithers go", true, false), nil), "a maintainer's mention never approves an outsider's issue")
	require.False(t, repositoryJobMatches(rule, mentionEvent(t, "issue_comment", "created", true, nil), nil))
	edited := comment("@smithers go", true, true)
	edited.EventAction = "edited"
	require.False(t, repositoryJobMatches(rule, edited, nil))
	_, ok := repositoryJobCommentBody(mentionEvent(t, "issues", "assigned", true, nil))
	require.False(t, ok)
	_, ok = repositoryJobCommentBody(db.RepositoryJobEvent{EventType: "issue_comment", Payload: json.RawMessage(`[]`)})
	require.False(t, ok)
}

// The checked-in factory declares both entry points, and neither implements:
// they propose work through triage, while only todo starts coding.
func TestCheckedInFactoryAssignmentAndMentionProposeWork(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", ".smithers", "factory.json"))
	require.NoError(t, err)
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal(raw, &projection))
	rules, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	var mentions []RegisterRepositoryJobInput
	for _, rule := range rules {
		if rule.input.Mention != "" {
			mentions = append(mentions, rule.input)
		}
	}
	require.Len(t, mentions, 2)
	for _, input := range mentions {
		require.Equal(t, "smithers", input.Mention)
		require.Equal(t, "issue-triage", input.FlowID, "assignment and mention propose work; only todo implements")
	}
	require.Equal(t, "issue", mentions[0].Events[0].Type)
	require.Equal(t, []string{"assigned"}, mentions[0].Events[0].Actions)
	require.Equal(t, "issue_comment", mentions[1].Events[0].Type)
	require.Equal(t, []string{"created"}, mentions[1].Events[0].Actions)
}

func TestRepositoryJobsIntegrationMentionProposesOncePerText(t *testing.T) {
	_, q, service, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := gateway.target.RepositoryID
	projection := mentionProjection(t, `[{"event":"issue.assigned:@smithers","flow":"issue-triage"},{"event":"issue_comment.created:@smithers","flow":"issue-triage"}]`)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("a", 40), projection))
	registrations, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, registrations, 2)
	jobs := map[string]string{}
	for _, reg := range registrations {
		var input RegisterRepositoryJobInput
		require.NoError(t, json.Unmarshal(reg.Configuration, &input))
		jobs[input.Events[0].Type] = reg.Job
		gateway.config.Envelope = input.Envelope
	}
	admit := func(delivery, kind, action string, extra string) {
		body := json.RawMessage(`{"action":"` + action + `","issue":{"id":100,"number":7,"title":"Crash","body":"text","user":{"login":"author"},"smithers_text_by_maintainer":true,"labels":[]}` + extra + `}`)
		require.NoError(t, service.AdmitGitHubEvent(ctx, repo, db.GithubWebhookJob{DeliveryID: delivery, Payload: body}, TriggerEvent{Type: kind, Action: action}))
	}
	mention := func(id int, text string) string {
		return `,"comment":{"id":` + strconv.Itoa(id) + `,"body":` + jsonString(text) + `,"smithers_text_by_maintainer":true}`
	}
	// One poll claims one dispatch; drain them.
	poll := func() {
		for range 6 {
			repositoryJobPoll(t, service, gateway)
		}
	}
	runIDs := map[string]string{}
	statuses := func(job string) map[string]string {
		rows, err := service.Dispatches(ctx, repo, gateway.target.UserID, job)
		require.NoError(t, err)
		result := map[string]string{}
		for _, row := range rows {
			key := strings.TrimPrefix(row.DeliveryKey, "github:")
			result[key] = row.Status
			if job == jobs["issue_comment"] {
				runIDs[key] = row.RunID
			}
		}
		return result
	}

	admit("assigned-other", "issues", "assigned", `,"assignee":{"login":"someone"}`)
	admit("assigned-app", "issues", "assigned", `,"assignee":{"login":"smithers[bot]"}`)
	admit("mention-1", "issue_comment", "created", mention(1, "@smithers please look"))
	admit("mention-code", "issue_comment", "created", mention(2, "`@smithers` is our bot"))
	poll()
	assignments := statuses(jobs["issue"])
	require.Equal(t, "submitted", assignments["assigned-app"], "assigned to the app starts intake")
	require.Equal(t, "skipped", assignments["assigned-other"])
	require.Equal(t, "skipped", assignments["mention-1"], "a comment is not an assignment")
	comments := statuses(jobs["issue_comment"])
	require.Equal(t, "submitted", comments["mention-1"], "@smithers mention starts intake")
	require.Equal(t, "skipped", comments["mention-code"], "mention inside a code span is ignored")

	// A redelivery and a second identical comment propose nothing new; new
	// text still reaches the issue's run.
	admit("mention-1", "issue_comment", "created", mention(1, "@smithers please look"))
	admit("mention-again", "issue_comment", "created", mention(3, "  @smithers please look\n"))
	admit("mention-new", "issue_comment", "created", mention(4, "@smithers also check Windows"))
	poll()
	comments = statuses(jobs["issue_comment"])
	require.Len(t, comments, 6, "a redelivery adds no dispatch")
	require.Equal(t, "submitted", comments["mention-1"])
	require.Equal(t, "skipped", comments["mention-again"], "@smithers mention starts intake once")
	require.NotEqual(t, "skipped", comments["mention-new"])
	require.NotEmpty(t, runIDs["mention-1"])
	require.Equal(t, runIDs["mention-1"], runIDs["mention-new"], "new text signals the issue's run, never a second one")
	require.Len(t, gateway.launches, 2, "one launch per rule: the assignment and the first mention")
}

func jsonString(text string) string {
	raw, _ := json.Marshal(text)
	return string(raw)
}
