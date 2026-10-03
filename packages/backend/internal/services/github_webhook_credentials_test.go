package services

import (
	"context"
	"errors"
	"github.com/stretchr/testify/require"
	"testing"
)

// Unit signing fixtures isolate credential loading from delivery processing.
// The credential store's own integration suite covers sealed PostgreSQL values.
type webhookCredentialFixture struct {
	secret string
	err    error
	calls  int
}

func (f *webhookCredentialFixture) WebhookSecret(context.Context) (string, error) {
	f.calls++
	return f.secret, f.err
}
func newTestGitHubWebhookService(db GitHubWebhookDB, secret string, opts ...GitHubWebhookOption) *GitHubWebhookService {
	return NewGitHubWebhookService(db, &webhookCredentialFixture{secret: secret}, opts...)
}
func TestWebhookReloadsStoredSecretAndFailsClosed(t *testing.T) {
	fixture := &webhookCredentialFixture{secret: "first-secret"}
	svc := NewGitHubWebhookService(&mockGitHubWebhookDB{}, fixture)
	payload := []byte(`{}`)
	require.NoError(t, svc.HandleGitHubWebhook(context.Background(), "", "unsupported", signGitHubWebhookForTest(payload, fixture.secret), payload))
	fixture.secret = "second-secret"
	require.Error(t, svc.HandleGitHubWebhook(context.Background(), "", "unsupported", signGitHubWebhookForTest(payload, "first-secret"), payload))
	require.NoError(t, svc.HandleGitHubWebhook(context.Background(), "", "unsupported", signGitHubWebhookForTest(payload, fixture.secret), payload))
	fixture.err = errors.New("cannot unseal")
	require.Error(t, svc.HandleGitHubWebhook(context.Background(), "", "unsupported", signGitHubWebhookForTest(payload, fixture.secret), payload))
	require.Equal(t, 4, fixture.calls)
}
