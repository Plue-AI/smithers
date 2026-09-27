package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWebhook_Cov_CRUDErrorBranchesAndRedaction(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	listQ := webhookQuerier()
	listQ.listRepoWebhooksByOwnerAndRepoFn = func(context.Context, db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error) {
		return []db.Webhook{{ID: 1, Secret: "plain"}, {ID: 2}}, nil
	}
	hooks, err := newWebhookService(t, listQ).ListWebhooks(ctx, actor, "alice", "demo")
	require.NoError(t, err)
	require.Len(t, hooks, 2)
	assert.Equal(t, redactedWebhookSecret, hooks[0].Secret)
	assert.Empty(t, hooks[1].Secret)

	listQ.listRepoWebhooksByOwnerAndRepoFn = func(context.Context, db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error) {
		return nil, assert.AnError
	}
	_, err = newWebhookService(t, listQ).ListWebhooks(ctx, actor, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	getQ := webhookQuerier()
	getQ.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return db.Webhook{}, assert.AnError
	}
	_, err = newWebhookService(t, getQ).GetWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	decryptSvc := NewWebhookService(webhookQuerier(), &mockWebhookSecretCodec{
		decryptFn: func(string) (string, error) { return "", assert.AnError },
	})
	decryptSvc.queries.(*mockWebhookQuerier).getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	_, err = decryptSvc.GetWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	createQ := webhookQuerier()
	createSvc := newWebhookService(t, createQ)
	for _, input := range []CreateWebhookInput{
		{URL: ""},
		{URL: "http://example.test/hook"},
	} {
		_, err = createSvc.CreateWebhook(ctx, actor, "alice", "demo", input)
		require.Error(t, err)
		assert.Equal(t, 422, apiStatus(t, err))
	}
	createQ.countWebhooksByRepoFn = func(context.Context, int64) (int64, error) { return 0, assert.AnError }
	_, err = createSvc.CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.test/hook"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	createQ.countWebhooksByRepoFn = func(context.Context, int64) (int64, error) { return maxWebhooksPerRepo, nil }
	_, err = createSvc.CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.test/hook"})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))

	encryptSvc := NewWebhookService(webhookQuerier(), &mockWebhookSecretCodec{
		encryptFn: func(string) (string, error) { return "", assert.AnError },
	})
	_, err = encryptSvc.CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.test/hook"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	createQ = webhookQuerier()
	createQ.createWebhookFn = func(context.Context, db.CreateWebhookParams) (db.Webhook, error) {
		return db.Webhook{}, assert.AnError
	}
	_, err = newWebhookService(t, createQ).CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.test/hook"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	updateQ := webhookQuerier()
	updateQ.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	_, err = newWebhookService(t, updateQ).UpdateWebhook(ctx, actor, "alice", "demo", 1, UpdateWebhookInput{URL: stringPtr(" ")})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))
	active := false
	events := []string{"push"}
	updated, err := newWebhookService(t, updateQ).UpdateWebhook(ctx, actor, "alice", "demo", 1, UpdateWebhookInput{
		Events:   &events,
		IsActive: &active,
	})
	require.NoError(t, err)
	assert.False(t, updated.IsActive)
	assert.Equal(t, []string{"push"}, updateQ.lastUpdateWebhookArg.Events)

	deleteQ := webhookQuerier()
	deleteQ.deleteRepoWebhookByOwnerAndRepoFn = func(context.Context, db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error) {
		return 0, nil
	}
	err = newWebhookService(t, deleteQ).DeleteWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	deleteQ.deleteRepoWebhookByOwnerAndRepoFn = func(context.Context, db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error) {
		return 0, assert.AnError
	}
	err = newWebhookService(t, deleteQ).DeleteWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWebhook_Cov_DeliveriesRedeliveryAndTestWebhook(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	q := webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	q.listWebhookDeliveriesForRepoFn = func(_ context.Context, arg db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error) {
		assert.Equal(t, int32(30), arg.PageSize)
		assert.Equal(t, int32(0), arg.PageOffset)
		return []db.WebhookDelivery{{ID: 7, WebhookID: arg.WebhookID, EventType: "push", Status: "success"}}, nil
	}
	deliveries, err := newWebhookService(t, q).ListWebhookDeliveries(ctx, actor, "alice", "demo", 1, -1, 99)
	require.NoError(t, err)
	require.Len(t, deliveries, 1)
	assert.Equal(t, int64(7), deliveries[0].ID)

	q.listWebhookDeliveriesForRepoFn = func(context.Context, db.ListWebhookDeliveriesForRepoParams) ([]db.WebhookDelivery, error) {
		return nil, assert.AnError
	}
	_, err = newWebhookService(t, q).ListWebhookDeliveries(ctx, actor, "alice", "demo", 1, 1, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	redeliverQ := webhookQuerier()
	redeliverQ.getWebhookDeliveryForRepoFn = func(context.Context, db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{ID: 9, WebhookID: 1, EventType: "issues", Payload: json.RawMessage(`{"ok":true}`), Status: "failed"}, nil
	}
	redelivery, err := newWebhookService(t, redeliverQ).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 9)
	require.NoError(t, err)
	assert.Equal(t, "pending", redelivery.Status)
	assert.Equal(t, "issues", redeliverQ.lastCreateDeliveryArg.EventType)

	redeliverQ.getWebhookDeliveryForRepoFn = func(context.Context, db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{}, pgx.ErrNoRows
	}
	_, err = newWebhookService(t, redeliverQ).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 9)
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	redeliverQ.getWebhookDeliveryForRepoFn = func(context.Context, db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{ID: 9, WebhookID: 1, EventType: "issues", Payload: json.RawMessage(`{"ok":true}`)}, nil
	}
	redeliverQ.createWebhookDeliveryFn = func(context.Context, db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{}, assert.AnError
	}
	_, err = newWebhookService(t, redeliverQ).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 9)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "ping", r.Header.Get("X-Smithers-Event"))
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("pong"))
	}))
	defer server.Close()

	testQ := webhookQuerier()
	testQ.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		hook := sampleWebhook()
		hook.Url = server.URL
		return hook, nil
	}
	var finalStatus string
	testQ.updateWebhookDeliveryResultFn = func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
		finalStatus = arg.Status
		return nil
	}
	svc := newWebhookService(t, testQ)
	svc.httpClient = server.Client()
	result, err := svc.TestWebhook(ctx, actor, "alice", "demo", 1)
	require.NoError(t, err)
	assert.Equal(t, http.StatusAccepted, result.StatusCode)
	assert.Equal(t, "pong", result.Body)
	assert.Equal(t, "pending", testQ.lastCreateDeliveryArg.Status)
	assert.Equal(t, "success", finalStatus)
}

func TestWebhook_Cov_HelpersAndPermissions(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()
	svc := newWebhookService(t, webhookQuerier())

	assert.Equal(t, redactedWebhookSecret, redactWebhookSecret(db.Webhook{Secret: "x"}).Secret)
	assert.Equal(t, int32(202), toNullableInt4(202).Int32)
	assert.False(t, toNullableInt4(0).Valid)
	require.NoError(t, svc.requireAdminAccess(ctx, webhookCovSampleRepo(), actor))
	err := svc.requireAdminAccess(ctx, webhookCovSampleRepo(), nil)
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))
}

func webhookCovSampleRepo() db.Repository {
	repo, _ := ownerRepo()
	return repo
}
