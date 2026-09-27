package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func webhookHService(q *mockWebhookQuerier) *WebhookService {
	return NewWebhookService(q, &mockWebhookSecretCodec{
		encryptFn: func(s string) (string, error) { return "enc:" + s, nil },
		decryptFn: func(s string) (string, error) { return "dec:" + s, nil },
	})
}

func TestWebhook_H_QueryAndCodecErrorBranches(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	q := webhookQuerier()
	q.listRepoWebhooksByOwnerAndRepoFn = func(context.Context, db.ListRepoWebhooksByOwnerAndRepoParams) ([]db.Webhook, error) {
		return nil, errors.New("list failed")
	}
	_, err := webhookHService(q).ListWebhooks(ctx, actor, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return db.Webhook{}, errors.New("load failed")
	}
	_, err = webhookHService(q).GetWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.countWebhooksByRepoFn = func(context.Context, int64) (int64, error) { return 0, errors.New("count failed") }
	_, err = webhookHService(q).CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.com/hook"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	svc := NewWebhookService(q, &mockWebhookSecretCodec{encryptFn: func(string) (string, error) { return "", errors.New("encrypt failed") }})
	_, err = svc.CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.com/hook"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.createWebhookFn = func(context.Context, db.CreateWebhookParams) (db.Webhook, error) {
		return db.Webhook{}, errors.New("insert failed")
	}
	_, err = webhookHService(q).CreateWebhook(ctx, actor, "alice", "demo", CreateWebhookInput{URL: "https://example.com/hook"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	svc = NewWebhookService(q, &mockWebhookSecretCodec{decryptFn: func(string) (string, error) { return "", errors.New("decrypt failed") }})
	_, err = svc.GetWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestWebhook_H_UpdateDeleteErrorBranches(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	_, err := webhookHService(webhookQuerier()).UpdateWebhook(ctx, actor, "alice", "demo", 0, UpdateWebhookInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	q := webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return db.Webhook{}, errors.New("load failed")
	}
	_, err = webhookHService(q).UpdateWebhook(ctx, actor, "alice", "demo", 1, UpdateWebhookInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = webhookQuerier()
	q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		return sampleWebhook(), nil
	}
	blank := " "
	_, err = webhookHService(q).UpdateWebhook(ctx, actor, "alice", "demo", 1, UpdateWebhookInput{URL: &blank})
	require.Error(t, err)
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	svc := NewWebhookService(q, &mockWebhookSecretCodec{encryptFn: func(string) (string, error) { return "", errors.New("encrypt failed") }})
	secret := "next"
	_, err = svc.UpdateWebhook(ctx, actor, "alice", "demo", 1, UpdateWebhookInput{Secret: &secret})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	for _, updateErr := range []error{pgx.ErrNoRows, errors.New("update failed")} {
		q = webhookQuerier()
		q.getRepoWebhookByOwnerAndRepoFn = func(context.Context, db.GetRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return sampleWebhook(), nil
		}
		q.updateRepoWebhookByOwnerAndRepoFn = func(context.Context, db.UpdateRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
			return db.Webhook{}, updateErr
		}
		_, err = webhookHService(q).UpdateWebhook(ctx, actor, "alice", "demo", 1, UpdateWebhookInput{})
		require.Error(t, err)
	}

	err = webhookHService(webhookQuerier()).DeleteWebhook(ctx, actor, "alice", "demo", 0)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	q = webhookQuerier()
	q.deleteRepoWebhookByOwnerAndRepoFn = func(context.Context, db.DeleteRepoWebhookByOwnerAndRepoParams) (int64, error) {
		return 0, errors.New("delete failed")
	}
	err = webhookHService(q).DeleteWebhook(ctx, actor, "alice", "demo", 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestWebhook_H_RedeliverBranchesAndPagination(t *testing.T) {
	ctx := context.Background()
	_, actor := ownerRepo()

	_, err := webhookHService(webhookQuerier()).RedeliverWebhookDelivery(ctx, nil, "alice", "demo", 1, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = webhookHService(webhookQuerier()).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 0, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = webhookHService(webhookQuerier()).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 0)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	for _, getErr := range []error{pgx.ErrNoRows, errors.New("load failed")} {
		q := webhookQuerier()
		q.getWebhookDeliveryForRepoFn = func(context.Context, db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error) {
			return db.WebhookDelivery{}, getErr
		}
		_, err = webhookHService(q).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 1)
		require.Error(t, err)
	}

	q := webhookQuerier()
	q.getWebhookDeliveryForRepoFn = func(context.Context, db.GetWebhookDeliveryForRepoParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{ID: 1, WebhookID: 2, EventType: "push", Payload: []byte(`{"ref":"main"}`)}, nil
	}
	q.createWebhookDeliveryFn = func(context.Context, db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
		return db.WebhookDelivery{}, errors.New("queue failed")
	}
	_, err = webhookHService(q).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 1)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q.createWebhookDeliveryFn = nil
	created, err := webhookHService(q).RedeliverWebhookDelivery(ctx, actor, "alice", "demo", 1, 1)
	require.NoError(t, err)
	assert.Equal(t, "push", created.EventType)
	assert.Equal(t, "pending", created.Status)

	size, offset, page, pages := normalizeWebhookPage(-1, 100)
	assert.Equal(t, 30, size)
	assert.Equal(t, 0, offset)
	assert.Equal(t, 1, page)
	assert.Equal(t, 0, pages)
}

func TestWebhook_H_RepoAndAdminInternalErrors(t *testing.T) {
	ctx := context.Background()
	q := &mockWebhookQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}
	_, err := NewWebhookService(q, defaultWebhookSecretCodec(t)).resolveRepoByOwnerAndName(ctx, "alice", "demo")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	repo, actor := ownerRepo()
	q = webhookQuerier()
	q.getCollaboratorPermissionForRepoFn = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "", errors.New("perm failed")
	}
	err = NewWebhookService(q, defaultWebhookSecretCodec(t)).requireAdminAccess(ctx, repo, &db.User{ID: actor.ID + 1})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}
