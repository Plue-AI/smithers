package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWebhook_Z_CRUDAccessAndResolveErrors(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	_, err := newWebhookService(t, webhookQuerier()).GetWebhook(ctx, actor, "", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = newWebhookService(t, webhookQuerier()).GetWebhook(ctx, nil, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	_, err = newWebhookService(t, webhookQuerier()).CreateWebhook(ctx, actor, "", "demo", CreateWebhookInput{URL: "https://example.test"})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	_, err = newWebhookService(t, webhookQuerier()).UpdateWebhook(ctx, actor, "", "demo", 1, UpdateWebhookInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = newWebhookService(t, webhookQuerier()).UpdateWebhook(ctx, &db.User{ID: 99}, "alice", "demo", 1, UpdateWebhookInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	err = newWebhookService(t, webhookQuerier()).DeleteWebhook(ctx, actor, "", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	err = newWebhookService(t, webhookQuerier()).DeleteWebhook(ctx, &db.User{ID: 99}, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	_, err = newWebhookService(t, webhookQuerier()).ListWebhookDeliveries(ctx, actor, "", "demo", 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = newWebhookService(t, webhookQuerier()).ListWebhookDeliveries(ctx, &db.User{ID: 99}, "alice", "demo", 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	q := webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return db.Webhook{}, errors.New("load failed")
	}
	_, err = newWebhookService(t, q).ListWebhookDeliveries(ctx, actor, "alice", "demo", 1, 1, 30)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = newWebhookService(t, webhookQuerier()).RedeliverWebhookDelivery(ctx, actor, "", "demo", 1, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = newWebhookService(t, webhookQuerier()).RedeliverWebhookDelivery(ctx, &db.User{ID: 99}, "alice", "demo", 1, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
}

func TestWebhook_Z_TestWebhookErrorBranches(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	_, err := newWebhookService(t, webhookQuerier()).TestWebhook(ctx, actor, "alice", "demo", 0)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	_, err = newWebhookService(t, webhookQuerier()).TestWebhook(ctx, actor, "", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	_, err = newWebhookService(t, webhookQuerier()).TestWebhook(ctx, &db.User{ID: 99}, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	q := webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return db.Webhook{}, errors.New("load failed")
	}
	_, err = newWebhookService(t, q).TestWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	_, err = NewWebhookService(q, &mockWebhookSecretCodec{
		decryptFn: func(string) (string, error) { return "", errors.New("decrypt failed") },
	}).TestWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	q.createWebhookDeliveryFn = func(context.Context, db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{}, errors.New("insert failed")
	}
	_, err = newWebhookService(t, q).TestWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)
	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		hook := sampleWebhook()
		hook.Url = server.URL
		return hook, nil
	}
	q.updateWebhookDeliveryResultFn = func(context.Context, db.UpdateWebhookDeliveryResultParams) error {
		return errors.New("update failed")
	}
	svc := newWebhookService(t, q)
	svc.httpClient = server.Client()
	result, err := svc.TestWebhook(ctx, actor, "alice", "demo", 1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusAccepted, result.StatusCode)

	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		hook := sampleWebhook()
		hook.Url = "://bad-url"
		return hook, nil
	}
	var failedStatus string
	q.updateWebhookDeliveryResultFn = func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
		failedStatus = arg.Status
		return nil
	}
	result, err = newWebhookService(t, q).TestWebhook(ctx, actor, "alice", "demo", 1)
	require.NoError(t, err, "an unreachable endpoint is the endpoint's fault, not a server error")
	assert.Equal(t, 0, result.StatusCode)
	assert.NotEmpty(t, result.Error)
	assert.Equal(t, "failed", failedStatus)
}

func TestWebhook_Z_ResolveBranches(t *testing.T) {
	ctx := context.Background()

	_, err := newWebhookService(t, webhookQuerier()).resolveRepoByOwnerAndName(ctx, "owner", "")
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
}
