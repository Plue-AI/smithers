package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestWebhooks_Cov_DeliveryBranches(t *testing.T) {
	t.Parallel()

	t.Run("delivery pagination caps cursor limit", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhookDeliveriesFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
				assert.Equal(t, int64(5), webhookID)
				assert.Equal(t, 3, page)
				assert.Equal(t, 30, perPage)
				return []db.WebhookDelivery{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/5/deliveries?cursor=60&limit=99", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "5"})
		rec := httptest.NewRecorder()
		handler.ListWebhookDeliveries(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
	})
}

func TestWebhooks_Cov_RedeliverWebhookDelivery(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	delivery := db.WebhookDelivery{
		ID:        88,
		WebhookID: 5,
		EventType: "issues",
		Payload:   []byte(`{"action":"opened"}`),
		Status:    "pending",
		Attempts:  0,
		CreatedAt: now,
		UpdatedAt: now,
	}

	t.Run("requires auth", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/5/deliveries/88/redeliver", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "5", "delivery_id": "88"})
		rec := httptest.NewRecorder()
		handler.RedeliverWebhookDelivery(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("rejects invalid delivery id", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/5/deliveries/nope/redeliver", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "5", "delivery_id": "nope"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.RedeliverWebhookDelivery(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "invalid webhook delivery id")
	})

	t.Run("returns created delivery", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{
			redeliverWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID, deliveryID int64) (db.WebhookDelivery, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(5), webhookID)
				assert.Equal(t, int64(88), deliveryID)
				return delivery, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/5/deliveries/88/redeliver", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "5", "delivery_id": "88"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.RedeliverWebhookDelivery(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var got db.WebhookDelivery
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		assert.Equal(t, int64(88), got.ID)
		assert.Equal(t, "issues", got.EventType)
	})

	t.Run("propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{
			redeliverWebhookFn: func(context.Context, *db.User, string, string, int64, int64) (db.WebhookDelivery, error) {
				return db.WebhookDelivery{}, pkgerrors.NotFound("delivery not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/5/deliveries/88/redeliver", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "5", "delivery_id": "88"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.RedeliverWebhookDelivery(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

func TestWebhooks_Cov_WriteHandlerErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("update propagates service error", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{
			updateWebhookFn: func(context.Context, *db.User, string, string, int64, services.UpdateWebhookInput) (db.Webhook, error) {
				return db.Webhook{}, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/hooks/5", strings.NewReader(`{"url":"https://example.com/hook"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "5"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.UpdateWebhook(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("test webhook rejects invalid id", func(t *testing.T) {
		t.Parallel()
		handler := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/nope/tests", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "nope"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		handler.TestWebhook(rec, req)

		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
