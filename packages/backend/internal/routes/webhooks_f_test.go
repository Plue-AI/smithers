package routes

import (
	"context"
	stderrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// TestWebhooks_F_GuardBranches drives the remaining owner/name, auth, id-param
// and service-error guards across every webhook handler.
func TestWebhooks_F_GuardBranches(t *testing.T) {
	ownerRepo := map[string]string{"owner": "alice", "repo": "demo"}

	t.Run("ListWebhooks missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//hooks", nil)
		rec := httptest.NewRecorder()
		h.ListWebhooks(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("GetWebhook missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//hooks/1", nil)
		rec := httptest.NewRecorder()
		h.GetWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("CreateWebhook missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos//hooks", strings.NewReader(`{"url":"https://x"}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.CreateWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("CreateWebhook service error", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			createWebhookFn: func(_ context.Context, _ *db.User, _, _ string, _ services.CreateWebhookInput) (db.Webhook, error) {
				return db.Webhook{}, stderrors.New("db down")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks", strings.NewReader(`{"url":"https://x"}`))
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.CreateWebhook(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("UpdateWebhook requires auth", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/hooks/1", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		h.UpdateWebhook(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("UpdateWebhook missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos//hooks/1", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.UpdateWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DeleteWebhook missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos//hooks/1", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("DeleteWebhook missing id param", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/hooks/", nil)
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.DeleteWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("TestWebhook requires auth", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/1/test", nil)
		rec := httptest.NewRecorder()
		h.TestWebhook(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("TestWebhook missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos//hooks/1/test", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.TestWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("ListWebhookDeliveries missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos//hooks/1/deliveries", nil)
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("RedeliverWebhookDelivery missing repo params", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos//hooks/1/deliveries/2/redeliver", nil)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.RedeliverWebhookDelivery(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("RedeliverWebhookDelivery missing id param", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks//deliveries/2/redeliver", nil)
		req = withRouteParams(req, ownerRepo)
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()
		h.RedeliverWebhookDelivery(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
