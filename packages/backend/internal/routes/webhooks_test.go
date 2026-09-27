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

// --- mock service ---

type mockWebhookRouteService struct {
	listWebhooksFn          func(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error)
	getWebhookFn            func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (db.Webhook, error)
	createWebhookFn         func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWebhookInput) (db.Webhook, error)
	updateWebhookFn         func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, req services.UpdateWebhookInput) (db.Webhook, error)
	deleteWebhookFn         func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) error
	testWebhookFn           func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (*services.TestWebhookResult, error)
	listWebhookDeliveriesFn func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error)
	redeliverWebhookFn      func(ctx context.Context, actor *db.User, owner, repo string, webhookID, deliveryID int64) (db.WebhookDelivery, error)
}

func (m *mockWebhookRouteService) ListWebhooks(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error) {
	if m.listWebhooksFn != nil {
		return m.listWebhooksFn(ctx, actor, owner, repo)
	}
	return nil, nil
}

func (m *mockWebhookRouteService) GetWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (db.Webhook, error) {
	if m.getWebhookFn != nil {
		return m.getWebhookFn(ctx, actor, owner, repo, webhookID)
	}
	return db.Webhook{}, nil
}

func (m *mockWebhookRouteService) CreateWebhook(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWebhookInput) (db.Webhook, error) {
	if m.createWebhookFn != nil {
		return m.createWebhookFn(ctx, actor, owner, repo, req)
	}
	return db.Webhook{}, nil
}

func (m *mockWebhookRouteService) UpdateWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, req services.UpdateWebhookInput) (db.Webhook, error) {
	if m.updateWebhookFn != nil {
		return m.updateWebhookFn(ctx, actor, owner, repo, webhookID, req)
	}
	return db.Webhook{}, nil
}

func (m *mockWebhookRouteService) DeleteWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) error {
	if m.deleteWebhookFn != nil {
		return m.deleteWebhookFn(ctx, actor, owner, repo, webhookID)
	}
	return nil
}

func (m *mockWebhookRouteService) TestWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (*services.TestWebhookResult, error) {
	if m.testWebhookFn != nil {
		return m.testWebhookFn(ctx, actor, owner, repo, webhookID)
	}
	return nil, nil
}

func (m *mockWebhookRouteService) ListWebhookDeliveries(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
	if m.listWebhookDeliveriesFn != nil {
		return m.listWebhookDeliveriesFn(ctx, actor, owner, repo, webhookID, page, perPage)
	}
	return nil, nil
}

func (m *mockWebhookRouteService) RedeliverWebhookDelivery(ctx context.Context, actor *db.User, owner, repo string, webhookID, deliveryID int64) (db.WebhookDelivery, error) {
	if m.redeliverWebhookFn != nil {
		return m.redeliverWebhookFn(ctx, actor, owner, repo, webhookID, deliveryID)
	}
	return db.WebhookDelivery{}, nil
}

// --- test helpers ---

func sampleWebhookDB() db.Webhook {
	now := time.Now().UTC().Truncate(time.Second)
	return db.Webhook{
		ID:           1,
		RepositoryID: 10,
		Url:          "https://example.com/webhook",
		Secret:       "s3cr3t",
		Events:       []string{"push", "issues"},
		IsActive:     true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

// --- List Webhooks ---

func TestWebhookHandler_ListWebhooks(t *testing.T) {
	t.Parallel()

	t.Run("returns webhooks list", func(t *testing.T) {
		hook := sampleWebhookDB()
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhooksFn: func(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				return []db.Webhook{hook}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhooks(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var body []map[string]interface{}
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		require.Len(t, body, 1)
		assert.Equal(t, "********", body[0]["secret"])
	})

	t.Run("service error propagated", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhooksFn: func(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhooks(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})
}

// --- Get Webhook ---

func TestWebhookHandler_GetWebhook(t *testing.T) {
	t.Parallel()

	t.Run("returns webhook by id", func(t *testing.T) {
		hook := sampleWebhookDB()
		h := WebhookHandler{Service: &mockWebhookRouteService{
			getWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (db.Webhook, error) {
				assert.Equal(t, int64(1), webhookID)
				return hook, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/1", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.GetWebhook(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var body map[string]interface{}
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		assert.Equal(t, "********", body["secret"])
	})

	t.Run("invalid id returns 400", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/abc", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "abc"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.GetWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("not found returns 404", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			getWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (db.Webhook, error) {
				return db.Webhook{}, pkgerrors.NotFound("webhook not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/999", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "999"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.GetWebhook(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

// --- Create Webhook ---

func TestWebhookHandler_CreateWebhook(t *testing.T) {
	t.Parallel()

	t.Run("creates webhook", func(t *testing.T) {
		hook := sampleWebhookDB()
		h := WebhookHandler{Service: &mockWebhookRouteService{
			createWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWebhookInput) (db.Webhook, error) {
				assert.Equal(t, "https://example.com/hook", req.URL)
				assert.Equal(t, "mysecret", req.Secret)
				assert.Equal(t, []string{"push"}, req.Events)
				assert.True(t, req.IsActive)
				return hook, nil
			},
		}}
		body := `{"url":"https://example.com/hook","secret":"mysecret","events":["push"],"is_active":true}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks", strings.NewReader(body))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateWebhook(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("no auth returns 401", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		body := `{"url":"https://example.com/hook"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks", strings.NewReader(body))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.CreateWebhook(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
}

// --- Update Webhook ---

func TestWebhookHandler_UpdateWebhook(t *testing.T) {
	t.Parallel()

	t.Run("updates webhook fields", func(t *testing.T) {
		hook := sampleWebhookDB()
		h := WebhookHandler{Service: &mockWebhookRouteService{
			updateWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, req services.UpdateWebhookInput) (db.Webhook, error) {
				assert.Equal(t, int64(1), webhookID)
				require.NotNil(t, req.URL)
				assert.Equal(t, "https://new.example.com/hook", *req.URL)
				return hook, nil
			},
		}}
		body := `{"url":"https://new.example.com/hook"}`
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/hooks/1", strings.NewReader(body))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.UpdateWebhook(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/hooks/1", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.UpdateWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("invalid id returns 400", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/hooks/abc", strings.NewReader(`{}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "abc"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.UpdateWebhook(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

// --- Delete Webhook ---

func TestWebhookHandler_DeleteWebhook(t *testing.T) {
	t.Parallel()

	t.Run("deletes webhook returns 204", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			deleteWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) error {
				assert.Equal(t, int64(1), webhookID)
				return nil
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/hooks/1", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteWebhook(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	})

	t.Run("not found returns 404", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			deleteWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) error {
				return pkgerrors.NotFound("webhook not found")
			},
		}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/hooks/999", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "999"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.DeleteWebhook(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("no auth returns 401", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/hooks/1", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		rec := httptest.NewRecorder()
		h.DeleteWebhook(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})
}

// --- Test Webhook (send ping) ---

func TestWebhookHandler_TestWebhook(t *testing.T) {
	t.Parallel()

	t.Run("sends ping returns 200", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			testWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (*services.TestWebhookResult, error) {
				assert.Equal(t, int64(1), webhookID)
				return &services.TestWebhookResult{StatusCode: 200, Body: "ok"}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/1/tests", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TestWebhook(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("not found returns 404", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			testWebhookFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (*services.TestWebhookResult, error) {
				return nil, pkgerrors.NotFound("webhook not found")
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/hooks/999/tests", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "999"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.TestWebhook(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})
}

// --- List Webhook Deliveries ---

func TestWebhookHandler_ListWebhookDeliveries(t *testing.T) {
	t.Parallel()

	sampleDelivery := db.WebhookDelivery{
		ID:        1,
		WebhookID: 1,
		EventType: "push",
		Payload:   []byte(`{"action":"opened"}`),
		Status:    "delivered",
		Attempts:  1,
		CreatedAt: time.Now().UTC().Truncate(time.Second),
		UpdatedAt: time.Now().UTC().Truncate(time.Second),
	}

	t.Run("returns deliveries list", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhookDeliveriesFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
				assert.Equal(t, int64(1), webhookID)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, 1, page)
				assert.Equal(t, 30, perPage)
				return []db.WebhookDelivery{sampleDelivery}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/1/deliveries", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var body []map[string]interface{}
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		require.Len(t, body, 1)
		assert.Equal(t, float64(1), body[0]["id"])
		assert.Equal(t, "push", body[0]["event_type"])
	})

	t.Run("returns empty list when no deliveries", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhookDeliveriesFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
				return []db.WebhookDelivery{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/1/deliveries", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var body []map[string]interface{}
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		require.Empty(t, body)
	})

	t.Run("invalid id returns 400", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/abc/deliveries", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "abc"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("service error propagated as 403", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhookDeliveriesFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
				return nil, pkgerrors.Forbidden("permission denied")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/1/deliveries", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("webhook not found returns 404", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhookDeliveriesFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
				return nil, pkgerrors.NotFound("webhook not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/999/deliveries", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "999"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("pagination params are parsed", func(t *testing.T) {
		h := WebhookHandler{Service: &mockWebhookRouteService{
			listWebhookDeliveriesFn: func(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error) {
				assert.Equal(t, 2, page)
				assert.Equal(t, 10, perPage)
				return []db.WebhookDelivery{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/hooks/1/deliveries?page=2&per_page=10", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "id": "1"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.ListWebhookDeliveries(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})
}
