package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func gitHubIssueEventJob(eventType, action string) db.GithubWebhookJob {
	return db.GithubWebhookJob{
		ID:                 108,
		DeliveryID:         "2a356bd5-bfcc-5ec3-b779-387b94b0b64e",
		EventType:          eventType,
		Action:             action,
		Attempts:           1,
		InstallationID:     pgtype.Int8{Int64: 777, Valid: true},
		GithubRepositoryID: pgtype.Int8{Int64: 9001, Valid: true},
		Payload: json.RawMessage(`{
			"action":"created",
			"installation":{"id":777},
			"repository":{"id":9001,"name":"demo","full_name":"Acme/demo","owner":{"login":"Acme"},"default_branch":"trunk"},
			"issue":{"id":512,"number":24,"title":"Empty config crashes","body":"Steps: use []","state":"open","html_url":"https://github.com/Acme/demo/issues/24","user":{"id":922,"login":"contributor"},"labels":[{"name":"bug"}],"author_association":"COLLABORATOR"},
			"comment":{"id":2048,"body":"Here is the requested configuration: []","user":{"id":922,"login":"contributor"},"html_url":"https://github.com/Acme/demo/issues/24#issuecomment-2048","author_association":"COLLABORATOR"},
			"sender":{"id":922,"login":"contributor","type":"User"}
		}`),
	}
}

func TestGitHubIssueEventMapping_PreservesExternalIssueAndDeliveryIdentity(t *testing.T) {
	t.Parallel()

	for _, eventType := range []string{"issues", "issue_comment"} {
		t.Run(eventType, func(t *testing.T) {
			job := gitHubIssueEventJob(eventType, "edited")
			payload, err := parseGitHubWorkflowEventPayload(job.Payload)
			require.NoError(t, err)
			event, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			require.True(t, supported)
			assert.Equal(t, eventType, event.Type)
			assert.Equal(t, "edited", event.Action)
			assert.Equal(t, "trunk", event.Ref)
			assert.Empty(t, event.CommitSHA, "an issue's source branch is not an immutable revision")
			assert.Empty(t, event.ChangeID)
			assert.Equal(t, "github", event.Inputs["source"])
			assert.Equal(t, eventType, event.Inputs["eventType"])
			assert.Equal(t, job.DeliveryID, event.Inputs["githubDeliveryId"])
			assert.Equal(t, job.ID, event.Inputs["githubWebhookJobId"])
			assert.Equal(t, int64(512), event.Inputs["issueId"])
			assert.Equal(t, int64(24), event.Inputs["issueNumber"])
			assert.Equal(t, "Empty config crashes", event.Inputs["issueTitle"])
			assert.Equal(t, "Steps: use []", event.Inputs["issueBody"])
			assert.Equal(t, "contributor", event.Inputs["issueAuthor"])
			assert.Equal(t, []string{"bug"}, event.Inputs["issueLabels"])
			assert.Equal(t, "Acme/demo", event.Inputs["repoFullName"])
			assert.Equal(t, "https://github.com/Acme/demo/issues/24", event.Inputs["issueUrl"])

			// Persisted dispatch input retains the source objects (including
			// fields not projected into the convenience input names).
			encoded, err := json.Marshal(event.Inputs)
			require.NoError(t, err)
			var persisted map[string]interface{}
			require.NoError(t, json.Unmarshal(encoded, &persisted))
			assert.Equal(t, "COLLABORATOR", persisted["issue"].(map[string]interface{})["author_association"])
			assert.Equal(t, "Here is the requested configuration: []", persisted["comment"].(map[string]interface{})["body"])
			assert.Equal(t, "contributor", persisted["sender"].(map[string]interface{})["login"])

			job.Attempts++
			retry, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			require.True(t, supported)
			assert.Equal(t, event.Inputs, retry.Inputs, "a retry must preserve the signed body's delivery identity")
		})
	}
}

func TestGitHubIssueEventMapping_RejectsNonIssuePayloads(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name      string
		eventType string
		payload   string
	}{
		{"missing issue", "issues", `{}`},
		{"missing number", "issues", `{"issue":{"id":512}}`},
		{"missing issue identity", "issues", `{"issue":{"number":24}}`},
		{"PR-shaped issue", "issues", `{"issue":{"id":512,"number":24,"pull_request":{"url":"https://api.github.com/repos/Acme/demo/pulls/24"}}}`},
		{"PR conversation", "issue_comment", `{"issue":{"id":512,"number":24,"pull_request":{"url":"https://api.github.com/repos/Acme/demo/pulls/24"}},"comment":{"id":2048}}`},
		{"missing comment", "issue_comment", `{"issue":{"id":512,"number":24}}`},
		{"comment without identity", "issue_comment", `{"issue":{"id":512,"number":24},"comment":{"body":"a reply"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job := gitHubIssueEventJob(tc.eventType, "created")
			job.Payload = json.RawMessage(tc.payload)
			payload, err := parseGitHubWorkflowEventPayload(job.Payload)
			require.NoError(t, err)
			_, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			assert.False(t, supported)
		})
	}
}

func TestGitHubIssueEventWorker_DispatchesOnlyEnabledMatchingIssueRules(t *testing.T) {
	t.Parallel()

	for _, eventType := range []string{"issues", "issue_comment"} {
		t.Run(eventType, func(t *testing.T) {
			job := gitHubIssueEventJob(eventType, "created")
			queries := pushJobQuerier(job)
			queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
				return []db.WorkflowTrigger{
					{WorkflowDefinitionID: 9, EventType: eventType, Enabled: false},
					{WorkflowDefinitionID: 10, EventType: eventType, EventAction: "created", Enabled: true},
					{WorkflowDefinitionID: 10, EventType: eventType, Enabled: true},
					{WorkflowDefinitionID: 11, EventType: eventType, EventAction: "deleted", Enabled: true},
					{WorkflowDefinitionID: 12, EventType: "manual", Enabled: true},
					{WorkflowDefinitionID: 13, EventType: "pull_request", Enabled: true},
				}, nil
			}
			dispatcher := &mockGitHubWebhookEventRunDispatcher{}
			worker := NewGitHubWebhookEventWorker(queries, dispatcher)
			worker.SetTextStamper(authorWroteIssueText(t))
			require.NoError(t, worker.PollOnce(context.Background()))
			require.Len(t, dispatcher.calls, 1)
			assert.Equal(t, int64(10), *dispatcher.calls[0].WorkflowDefinitionID)
			assert.Zero(t, dispatcher.calls[0].UserID, "GitHub actor IDs do not authorize a Plue user")
			assert.Equal(t, job.DeliveryID, dispatcher.calls[0].Event.Inputs["githubDeliveryId"])
			assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
			assert.Empty(t, queries.markFailed)
		})
	}
}

func TestGitHubIssueEventWorker_DisabledSetupDoesNotDispatch(t *testing.T) {
	t.Parallel()

	job := gitHubIssueEventJob("issues", "opened")
	queries := pushJobQuerier(job)
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
		return []db.WorkflowTrigger{
			{WorkflowDefinitionID: 10, EventType: "issue", EventAction: "opened", Enabled: false},
			{WorkflowDefinitionID: 11, EventType: "manual", Enabled: true},
		}, nil
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
	assert.Empty(t, dispatcher.calls)
	assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
}

func TestGitHubIssueEventWorker_RetryRetainsIdentityAndAuthorReply(t *testing.T) {
	t.Parallel()

	job := gitHubIssueEventJob("issue_comment", "created")
	queries := pushJobQuerier(job)
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
		return []db.WorkflowTrigger{{WorkflowDefinitionID: 10, EventType: "issue_comment", EventAction: "created", Enabled: true}}, nil
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	dispatcher.dispatchForEventFn = func(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error) {
		if len(dispatcher.calls) == 1 {
			return nil, errors.New("temporary dispatcher failure")
		}
		return nil, nil
	}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)
	worker.SetTextStamper(authorWroteIssueText(t))
	require.NoError(t, worker.PollOnce(context.Background()))
	require.Len(t, queries.retried, 1)
	assert.Empty(t, queries.markDoneIDs)
	require.NoError(t, worker.PollOnce(context.Background()))
	require.Len(t, dispatcher.calls, 2)
	assert.Equal(t, dispatcher.calls[0].Event.Inputs, dispatcher.calls[1].Event.Inputs)
	assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
}

// setGitHubIssueEventAssociations rewrites the fixture's issue and comment
// author_association values.
func setGitHubIssueEventAssociations(t *testing.T, job *db.GithubWebhookJob, issueAssociation, commentAssociation string) {
	t.Helper()
	var payload map[string]map[string]interface{}
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(job.Payload, &raw))
	payload = map[string]map[string]interface{}{}
	for _, key := range []string{"issue", "comment"} {
		var object map[string]interface{}
		require.NoError(t, json.Unmarshal(raw[key], &object))
		payload[key] = object
	}
	payload["issue"]["author_association"] = issueAssociation
	payload["comment"]["author_association"] = commentAssociation
	for key, object := range payload {
		encoded, err := json.Marshal(object)
		require.NoError(t, err)
		raw[key] = encoded
	}
	encoded, err := json.Marshal(raw)
	require.NoError(t, err)
	job.Payload = encoded
}

// Issue text is an instruction channel into an agent that holds the
// repository's credentials. Automatic work starts only when the event's author
// is a repository OWNER, MEMBER or COLLABORATOR; a stranger's issue or comment
// starts nothing (security-engineer lane, action 4).
func TestGitHubIssueEventWorker_UntrustedAuthorsStartNothing(t *testing.T) {
	t.Parallel()

	untrusted := []string{"NONE", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", ""}
	for _, eventType := range []string{"issues", "issue_comment"} {
		for _, association := range untrusted {
			t.Run(eventType+"/"+association, func(t *testing.T) {
				t.Parallel()
				job := gitHubIssueEventJob(eventType, "opened")
				if eventType == "issue_comment" {
					job.Action = "created"
					// A stranger's comment on a maintainer's issue is still untrusted text.
					setGitHubIssueEventAssociations(t, &job, "OWNER", association)
				} else {
					setGitHubIssueEventAssociations(t, &job, association, "OWNER")
				}
				queries := pushJobQuerier(job)
				queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
					return []db.WorkflowTrigger{{WorkflowDefinitionID: 10, EventType: eventType, Enabled: true}}, nil
				}
				dispatcher := &mockGitHubWebhookEventRunDispatcher{}
				require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
				assert.Empty(t, dispatcher.calls, "an untrusted author starts no automatic work")
				assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
			})
		}
	}

	for _, association := range []string{"OWNER", "MEMBER", "COLLABORATOR"} {
		for _, eventType := range []string{"issues", "issue_comment"} {
			job := gitHubIssueEventJob(eventType, "opened")
			setGitHubIssueEventAssociations(t, &job, association, association)
			payload, err := parseGitHubWorkflowEventPayload(job.Payload)
			require.NoError(t, err)
			_, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
			assert.True(t, supported, "%s %s dispatches", association, eventType)
		}
	}

	// A maintainer's comment does not approve a stranger's issue text.
	job := gitHubIssueEventJob("issue_comment", "created")
	setGitHubIssueEventAssociations(t, &job, "NONE", "OWNER")
	queries := pushJobQuerier(job)
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
		return []db.WorkflowTrigger{{WorkflowDefinitionID: 10, EventType: "issue_comment", Enabled: true}}, nil
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
	assert.Empty(t, dispatcher.calls, "a maintainer's comment on a stranger's issue starts nothing")
	assert.False(t, gitHubIssueEventApproves("issue_comment", "created", job.Payload, issueApprovalLabel))
}

func setGitHubIssueEventLabel(t *testing.T, job *db.GithubWebhookJob, label, senderType string, senderID int, issueLabels ...string) {
	t.Helper()
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(job.Payload, &raw))
	var issue map[string]interface{}
	require.NoError(t, json.Unmarshal(raw["issue"], &issue))
	names := []map[string]string{}
	for _, name := range issueLabels {
		names = append(names, map[string]string{"name": name})
	}
	issue["labels"] = names
	encode := func(value interface{}) json.RawMessage {
		encoded, err := json.Marshal(value)
		require.NoError(t, err)
		return encoded
	}
	raw["issue"] = encode(issue)
	raw["label"] = encode(map[string]string{"name": label})
	raw["sender"] = encode(map[string]interface{}{"id": senderID, "login": "user" + strconv.Itoa(senderID), "type": senderType})
	job.Payload = encode(raw)
}

// Only the trigger label, applied by a person other than the author,
// approves a stranger's issue text; any other label, an app's label, or an
// assignee or milestone change approves nothing. Workflow triggers configure
// no trigger label, so a stranger's issue never starts one.
func TestGitHubIssueEventWorker_OnlyTheTriggerLabelFromAPersonStartsAStrangersIssue(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		action, label, sender string
		senderID              int
		labels                []string
		starts                bool
	}{
		"other label":           {"labeled", "invalid", "User", 7, []string{"invalid"}, false},
		"other label, tagged":   {"labeled", "invalid", "User", 7, []string{"smithers", "invalid"}, false},
		"assigned":              {"assigned", "", "User", 7, []string{"smithers"}, false},
		"milestoned":            {"milestoned", "", "User", 7, []string{"smithers"}, false},
		"unlabeled":             {"unlabeled", "smithers", "User", 7, nil, false},
		"app label":             {"labeled", "smithers", "Bot", 7, []string{"smithers"}, false},
		"author template label": {"labeled", "smithers", "User", 922, []string{"smithers"}, false},
		"trigger label":         {"labeled", "Smithers", "User", 7, []string{"smithers"}, true},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			job := gitHubIssueEventJob("issues", tc.action)
			setGitHubIssueEventAssociations(t, &job, "NONE", "NONE")
			setGitHubIssueEventLabel(t, &job, tc.label, tc.sender, tc.senderID, tc.labels...)
			queries := pushJobQuerier(job)
			queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
				return []db.WorkflowTrigger{{WorkflowDefinitionID: 10, EventType: "issues", Enabled: true}}, nil
			}
			dispatcher := &mockGitHubWebhookEventRunDispatcher{}
			require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
			assert.Empty(t, dispatcher.calls)
			assert.Equal(t, tc.starts, gitHubIssueEventApproves("issues", tc.action, job.Payload, issueApprovalLabel))
			assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
		})
	}
}

func TestGitHubEventByOutsiderCoversEveryAuthoredPart(t *testing.T) {
	t.Parallel()
	for payload, outsider := range map[string]bool{
		`{"issue":{"author_association":"OWNER","smithers_text_by_maintainer":true}}`:                                                                                          false,
		`{"issue":{"author_association":"OWNER"}}`:                                                                                                                             true,
		`{"issue":{"author_association":"NONE"}}`:                                                                                                                              true,
		`{"pull_request":{"author_association":"FIRST_TIME_CONTRIBUTOR"}}`:                                                                                                     true,
		`{"issue":{"author_association":"MEMBER"},"comment":{"author_association":"CONTRIBUTOR"}}`:                                                                             true,
		`{"pull_request":{"author_association":"MEMBER"},"review":{"author_association":"NONE"}}`:                                                                              true,
		`{"pull_request":{"author_association":"COLLABORATOR"},"review":{"author_association":"OWNER"}}`:                                                                       true,
		`{"pull_request":{"author_association":"COLLABORATOR","smithers_text_by_maintainer":true},"review":{"author_association":"OWNER","smithers_text_by_maintainer":true}}`: false,
		`{"pull_request":{"author_association":"COLLABORATOR","smithers_text_by_maintainer":true},"review":{"author_association":"OWNER"}}`:                                    true,
		`{"ref":"refs/heads/main"}`: false,
	} {
		assert.Equal(t, outsider, gitHubEventByOutsider([]byte(payload)), payload)
	}
}
