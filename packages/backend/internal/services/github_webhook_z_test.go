package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitHubWebhook_Z_InstallationAndReplaceErrors(t *testing.T) {
	payload := []byte(`{"action":"created"}`)
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "secret")
	err := svc.HandleGitHubWebhook(context.Background(), uuid.NewString(), "installation", signGitHubWebhookForTest(payload, "secret"), payload)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, errors.New("upsert failed")
		},
	}, "secret")
	err = svc.replaceInstallationRepositories(context.Background(), svc.db, 99, gitHubWebhookEnvelope{})
	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "installation"))
}
