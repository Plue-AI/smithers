package services

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestRepositoryJobPushWithoutActionMatchesCIRegistration(t *testing.T) {
	body := json.RawMessage(`{"ref":"refs/heads/main","before":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","after":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created":false,"deleted":false,"forced":false,"repository":{"id":42,"full_name":"original/source"},"sender":{"login":"maintainer"}}`)
	job := db.GithubWebhookJob{EventType: "push", Action: "", DeliveryID: "signed-body-digest", Payload: body}
	payload, err := parseGitHubWorkflowEventPayload(body)
	require.NoError(t, err)
	event, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
	require.True(t, supported)
	require.Empty(t, event.Action, "GitHub push has no action field")
	require.Equal(t, "refs/heads/main", event.Ref)
	require.Equal(t, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", event.CommitSHA)
	stored := db.RepositoryJobEvent{EventType: event.Type, EventAction: event.Action, Payload: body}
	require.False(t, repositoryJobMatches(RegisterRepositoryJobInput{Events: []RepositoryJobEventRule{{Type: "push", Actions: []string{"pushed"}}}}, stored, nil))
	require.True(t, repositoryJobMatches(RegisterRepositoryJobInput{Events: []RepositoryJobEventRule{{Type: "push", Actions: []string{}}}}, stored, nil))
}
