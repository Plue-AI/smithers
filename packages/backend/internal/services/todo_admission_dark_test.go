package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

// A nil store/GitHub/launcher is intentional: any read, write or launch panics.
// The unavailable provider must be refused before even attempting an effect.
func TestIssueTodoUnavailableBeforeEffects(t *testing.T) {
	s := &MythicalService{}
	ctx := context.Background()
	for _, applied := range []gitHubLabelApplication{
		{}, {Label: "todo", By: "member", ByMaintainer: true, EventID: 7},
		{AutoTodo: "legacy policy"}, {FiledBy: "member", FiledRequest: "request"},
	} {
		err := s.ObserveIssue(ctx, 1, mythicalIssue{Number: 9, State: "open", Title: "Original", Body: "Quoted issue", TextByMaintainer: true}, applied)
		var failure *pkgerrors.APIError
		require.ErrorAs(t, err, &failure)
		require.Equal(t, http.StatusServiceUnavailable, failure.Status)
		require.Equal(t, pkgerrors.FaultInfra, failure.Fault)
		require.Equal(t, pkgerrors.CodeServiceUnavailable, failure.Code)
	}
}

func TestIssueWebhookRemainsRetryableWithoutAdmission(t *testing.T) {
	s := &MythicalService{}
	for _, event := range []string{"issues", " ISSUES ", "issue_comment", " Issue_Comment "} {
		for _, payload := range [][]byte{nil, []byte(`{"action":"labeled","label":{"name":"todo"}}`), []byte(`{"action":"created","comment":{"body":"@smithers do this"}}`)} {
			var failure *pkgerrors.APIError
			require.ErrorAs(t, s.ObserveGitHubEvent(context.Background(), event, payload), &failure)
			require.Equal(t, pkgerrors.CodeServiceUnavailable, failure.Code)
		}
	}
	for _, event := range []string{"", "push", "pull_request"} {
		require.NoError(t, s.ObserveGitHubEvent(context.Background(), event, nil))
	}
	var absent *MythicalService
	require.NoError(t, absent.ObserveGitHubEvent(context.Background(), "issues", nil))
}

func TestFileTodoNeverCreatesAnIssueWithoutAdmission(t *testing.T) {
	s := &MythicalService{}
	for _, input := range []MythicalTodoInput{{}, {Title: "Original", Prompt: "Prompt", Request: "same-request"}} {
		item, err := s.FileTodo(context.Background(), 1, 2, input)
		require.Equal(t, MythicalItemView{}, item)
		var failure *pkgerrors.APIError
		require.ErrorAs(t, err, &failure)
		require.Equal(t, pkgerrors.CodeServiceUnavailable, failure.Code)
	}
	ctx := middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: 2}, IsTokenAuth: true, TokenSystemIssued: true})
	_, err := s.FileTodo(ctx, 1, 2, MythicalTodoInput{Title: "Original"})
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, http.StatusForbidden, failure.Status)
}

// This exercises the production poll/retry path. The mock stores only observe
// receipts; real database admission is unavailable and must never be attempted.
func TestIssueAdmissionUnavailableNeverExhaustsWebhookDelivery(t *testing.T) {
	for _, event := range []string{"issues", "issue_comment"} {
		for _, attempts := range []int32{1, gitHubWebhookJobMaxAttempts, gitHubWebhookJobMaxAttempts + 1, 1000} {
			job := pushJob(19, attempts)
			job.EventType = event
			queries := pushJobQuerier(job)
			dispatcher := &mockGitHubWebhookEventRunDispatcher{}
			worker := NewGitHubWebhookEventWorker(queries, dispatcher)
			worker.SetMythical(&MythicalService{})
			require.NoError(t, worker.PollOnce(context.Background()))
			require.Len(t, queries.retried, 1)
			require.Equal(t, attempts, queries.retried[0].ExpectedAttempts)
			require.Contains(t, queries.retried[0].Error, "Issue TODO admission is not configured")
			require.Empty(t, queries.markFailed)
			require.Empty(t, queries.markDone)
			require.Empty(t, dispatcher.calls)
		}
	}
}
