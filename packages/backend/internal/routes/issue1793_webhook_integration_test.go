package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestIssue1793GitHubWebhookSignedBodyLimitPostgres(t *testing.T) {
	pool := setupGitHubWebhookRouteTestPool(t)
	const secret = "issue1793-route-secret"
	handler := &GitHubWebhookHandler{Service: services.NewGitHubWebhookService(pool, routeWebhookCredentialFixture(secret))}

	base := `{"ref":"refs/heads/issue1793","installation":{"id":9001},"repository":{"id":8001,"name":"demo","owner":{"login":"acme"}}}`
	body := []byte(base + strings.Repeat(" ", gitHubWebhookMaxBodyBytes-len(base)))
	require.Len(t, body, gitHubWebhookMaxBodyBytes)

	countJobs := func() int {
		t.Helper()
		var count int
		require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM github_webhook_jobs
			WHERE event_type = 'push' AND payload->>'ref' = 'refs/heads/issue1793'`).Scan(&count))
		return count
	}

	// The prefix has a valid signature. A reader that silently truncates the
	// extra byte would dispatch it, instead of rejecting it.
	oversize := append(append([]byte(nil), body...), 'x')
	bad := postGitHubWebhookForRouteTest(t, handler, "push", "17930000-0000-4000-8000-000000000001", oversize, secret, signRouteGitHubWebhookBody(body, secret))
	require.Equal(t, http.StatusRequestEntityTooLarge, bad.Code)
	require.Zero(t, countJobs())

	first := postGitHubWebhookForRouteTest(t, handler, "push", "17930000-0000-4000-8000-000000000002", body, secret, "")
	require.Equal(t, http.StatusOK, first.Code)
	require.Equal(t, 1, countJobs())

	replay := postGitHubWebhookForRouteTest(t, handler, "push", "17930000-0000-4000-8000-000000000003", body, secret, "")
	require.Equal(t, http.StatusOK, replay.Code)
	require.Equal(t, 1, countJobs())
}
