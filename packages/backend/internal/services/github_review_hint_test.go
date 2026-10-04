package services

import (
	"context"
	"net/http"
	"testing"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestReviewHintsRemainRetryableWithoutProviders(t *testing.T) {
	for _, event := range []string{"pull_request_review", "pull_request_review_comment"} {
		for _, observer := range []bool{false, true} {
			for _, attempts := range []int32{1, gitHubWebhookJobMaxAttempts, gitHubWebhookJobMaxAttempts + 1, 1000} {
				job := pushJob(19, attempts)
				job.EventType = event
				queries := pushJobQuerier(job)
				dispatcher := &mockGitHubWebhookEventRunDispatcher{}
				worker := NewGitHubWebhookEventWorker(queries, dispatcher)
				if observer {
					worker.SetMythical(&MythicalService{})
				}
				require.NoError(t, worker.PollOnce(context.Background()))
				require.Len(t, queries.retried, 1, "%s observer=%t attempts=%d", event, observer, attempts)
				require.Equal(t, attempts, queries.retried[0].ExpectedAttempts)
				require.Contains(t, queries.retried[0].Error, "GitHub review admission is not configured")
				require.Empty(t, queries.markFailed)
				require.Empty(t, queries.markDone)
				require.Empty(t, dispatcher.calls)
			}
		}
	}
}

func TestReviewObserverRefusesBeforeReadingPayload(t *testing.T) {
	for _, event := range []string{"pull_request_review", " PULL_REQUEST_REVIEW_COMMENT "} {
		for _, payload := range [][]byte{nil, []byte(`{"review":{"user":{"login":"member"},"body":"run me"}}`), []byte(`invalid`)} {
			var failure *pkgerrors.APIError
			require.ErrorAs(t, (&MythicalService{}).ObserveGitHubEvent(context.Background(), event, payload), &failure)
			require.Equal(t, http.StatusServiceUnavailable, failure.Status)
			require.Equal(t, pkgerrors.FaultInfra, failure.Fault)
			require.Equal(t, pkgerrors.CodeServiceUnavailable, failure.Code)
		}
	}
}
