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
