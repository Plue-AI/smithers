package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A push repo-host refuses because it holds the repository is a 503 with its
// message and Retry-After, not a sanitized 500.
func TestGitProxyFailureKeepsARepositoryHold(t *testing.T) {
	err := gitProxyFailure(context.Background(), "receive-pack", "alice", "demo", &repohost.StatusError{
		StatusCode: http.StatusServiceUnavailable, Code: repohost.RepositoryHeldCode,
		Message: "repository maintenance is finishing; retry in 5s", RetryAfter: 5,
	})
	var apiErr *errors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, http.StatusServiceUnavailable, apiErr.Status)
	require.Equal(t, errors.CodeRepositoryHeld, apiErr.Code)
	require.Equal(t, 5, apiErr.RetryAfter)
	require.Equal(t, "repository maintenance is finishing; retry in 5s", apiErr.Message)

	err = gitProxyFailure(context.Background(), "receive-pack", "alice", "demo", &repohost.StatusError{StatusCode: http.StatusServiceUnavailable})
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, http.StatusInternalServerError, apiErr.Status)
}
