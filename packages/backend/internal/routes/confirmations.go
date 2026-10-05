package routes

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ConfirmationRouteService is a person's confirmations
// (services.ApprovalsService).
type ConfirmationRouteService interface {
	Confirmations(ctx context.Context, repositoryID, memberID int64) ([]services.Confirmation, error)
	ApproveConfirmation(ctx context.Context, repositoryID, memberID int64, id string) (services.Confirmation, error)
	DenyConfirmation(ctx context.Context, repositoryID, memberID int64, id string) (services.Confirmation, error)
}

// ConfirmationsHandler serves /api/confirmations on an install (spec §5.4,
// §6.3): a person's own confirmations, and their Confirm or Cancel. Each
// route authorizes its command for the request's person (services.Authorize)
// and resolves the install's persisted repository.
type ConfirmationsHandler struct {
	Queries *db.Queries
	Service ConfirmationRouteService
}

func (h *ConfirmationsHandler) available(w http.ResponseWriter) bool {
	if h == nil || h.Service == nil {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "confirmation_unavailable", Class: "infra", Message: "Confirmations are unavailable"})
		return false
	}
	return true
}

// List is GET /api/confirmations: the caller's own confirmations, newest
// first. A person's browser session reads each with its Confirm card; a
// terminal's credential reads only {confirmation, state} of the ones it asked
// for.
func (h *ConfirmationsHandler) List(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	repo, decision, ok := authorizeInstallRepository(w, r, h.Queries, "confirmations.read")
	if !ok {
		return
	}
	list, err := h.Service.Confirmations(r.Context(), repo, decision.UserID)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	var body any = list
	if info := middleware.AuthInfoFromContext(r.Context()); info.IsTokenAuth {
		body = services.ConfirmationReceipts(list, info.TokenID)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}

// Approve is POST /api/confirmations/{id}/approve, the person's Confirm:
// 202 with the confirmation, approved, and the TODO it committed. Only the
// person it asks, in their own browser session, may press it; a second
// press commits nothing more.
func (h *ConfirmationsHandler) Approve(w http.ResponseWriter, r *http.Request) {
	h.press(w, r, http.StatusAccepted, func(ctx context.Context, repo, member int64, id string) (services.Confirmation, error) {
		return h.Service.ApproveConfirmation(ctx, repo, member, id)
	})
}

// Deny is POST /api/confirmations/{id}/deny, the person's Cancel: 200 with
// the confirmation, rejected; nothing runs.
func (h *ConfirmationsHandler) Deny(w http.ResponseWriter, r *http.Request) {
	h.press(w, r, http.StatusOK, func(ctx context.Context, repo, member int64, id string) (services.Confirmation, error) {
		return h.Service.DenyConfirmation(ctx, repo, member, id)
	})
}

func (h *ConfirmationsHandler) press(w http.ResponseWriter, r *http.Request, status int, decide func(context.Context, int64, int64, string) (services.Confirmation, error)) {
	if !h.available(w) {
		return
	}
	if r.Header.Get("Idempotency-Key") == "" {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusBadRequest, Code: "idempotency_key_required", Class: "user", Message: "Idempotency-Key is required"})
		return
	}
	repo, decision, ok := authorizeInstallRepository(w, r, h.Queries, "confirmations.decide")
	if !ok {
		return
	}
	confirmation, err := decide(r.Context(), repo, decision.UserID, chi.URLParam(r, "id"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(confirmation)
}
