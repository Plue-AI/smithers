package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type WebhookRouteService interface {
	ListWebhooks(ctx context.Context, actor *db.User, owner, repo string) ([]db.Webhook, error)
	GetWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (db.Webhook, error)
	CreateWebhook(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWebhookInput) (db.Webhook, error)
	UpdateWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, req services.UpdateWebhookInput) (db.Webhook, error)
	DeleteWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) error
	TestWebhook(ctx context.Context, actor *db.User, owner, repo string, webhookID int64) (*services.TestWebhookResult, error)
	ListWebhookDeliveries(ctx context.Context, actor *db.User, owner, repo string, webhookID int64, page, perPage int) ([]db.WebhookDelivery, error)
	RedeliverWebhookDelivery(ctx context.Context, actor *db.User, owner, repo string, webhookID, deliveryID int64) (db.WebhookDelivery, error)
}

type WebhookHandler struct {
	Service WebhookRouteService
}

type createWebhookRequest struct {
	URL      string   `json:"url"`
	Secret   string   `json:"secret"`
	Events   []string `json:"events"`
	IsActive bool     `json:"is_active"`
}

type patchWebhookRequest struct {
	URL      *string   `json:"url,omitempty"`
	Secret   *string   `json:"secret,omitempty"`
	Events   *[]string `json:"events,omitempty"`
	IsActive *bool     `json:"is_active,omitempty"`
}

func (h *WebhookHandler) ListWebhooks(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	hooks, err := h.Service.ListWebhooks(r.Context(), actor, owner, repo)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, toWebhookResponseList(hooks))
}

func (h *WebhookHandler) GetWebhook(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "webhook id is required", "invalid webhook id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	hook, err := h.Service.GetWebhook(r.Context(), actor, owner, repo, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, toWebhookResponse(hook))
}

func (h *WebhookHandler) CreateWebhook(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req createWebhookRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateWebhook(r.Context(), actor, owner, repo, services.CreateWebhookInput{
		URL:      req.URL,
		Secret:   req.Secret,
		Events:   req.Events,
		IsActive: req.IsActive,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, toWebhookResponse(created))
}

func (h *WebhookHandler) UpdateWebhook(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "webhook id is required", "invalid webhook id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req patchWebhookRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, err := h.Service.UpdateWebhook(r.Context(), actor, owner, repo, id, services.UpdateWebhookInput{
		URL:      req.URL,
		Secret:   req.Secret,
		Events:   req.Events,
		IsActive: req.IsActive,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, toWebhookResponse(updated))
}

func (h *WebhookHandler) DeleteWebhook(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "webhook id is required", "invalid webhook id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if err := h.Service.DeleteWebhook(r.Context(), actor, owner, repo, id); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WebhookHandler) TestWebhook(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "webhook id is required", "invalid webhook id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	result, err := h.Service.TestWebhook(r.Context(), actor, owner, repo, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *WebhookHandler) ListWebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "webhook id is required", "invalid webhook id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	cursor, limit := parseWebhookDeliveryPagination(r)
	page := cursorToPage(cursor, limit)
	perPage := limit
	deliveries, err := h.Service.ListWebhookDeliveries(r.Context(), actor, owner, repo, id, page, perPage)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, deliveries)
}

func (h *WebhookHandler) RedeliverWebhookDelivery(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "webhook id is required", "invalid webhook id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	deliveryID, err := parseInt64RouteParam(r, "delivery_id", "webhook delivery id is required", "invalid webhook delivery id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	delivery, err := h.Service.RedeliverWebhookDelivery(r.Context(), actor, owner, repo, id, deliveryID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, delivery)
}

// parseWebhookDeliveryPagination extracts cursor/limit from the query string
// with defaults (limit=30, max limit=30).
func parseWebhookDeliveryPagination(r *http.Request) (cursor string, limit int) {
	cursor, limit, err := parsePaginationWithLimits(r, 30, 30, "invalid limit value", true)
	if err != nil {
		return strings.TrimSpace(r.URL.Query().Get("cursor")), 30
	}
	return cursor, limit
}
