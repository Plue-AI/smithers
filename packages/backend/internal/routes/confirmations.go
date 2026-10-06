package routes

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ConfirmationsHandler adapts the existing approvals store for the install.
// Approval execution remains refused until the production dispatch consumer
// supplies the subject transaction; never turn a row into authority by itself.
type ConfirmationsHandler struct {
	Queries *db.Queries
	Service *services.ApprovalsService
}

func confirmationError(w http.ResponseWriter, status int, class, code, message string) {
	todoRouteError(w, &services.AccessError{Status: status, Class: class, Code: code, Message: message})
}

func (h *ConfirmationsHandler) member(w http.ResponseWriter, r *http.Request, session bool) (int64, bool) {
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil {
		confirmationError(w, 401, "permission", "unauthenticated", "Sign in")
		return 0, false
	}
	if session && (info.IsTokenAuth || info.SessionHash == "" || info.IsAgent()) {
		confirmationError(w, 403, "permission", "permission", "Use your browser session")
		return 0, false
	}
	if session {
		return info.User.ID, true
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "confirmations.read"); err != nil {
		todoRouteError(w, err)
		return 0, false
	}
	return info.User.ID, true
}

func (h *ConfirmationsHandler) List(w http.ResponseWriter, r *http.Request) {
	member, ok := h.member(w, r, false)
	if !ok {
		return
	}
	rows, err := h.Queries.ListMemberConfirmations(r.Context(), member)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	info := middleware.AuthInfoFromContext(r.Context())
	if info.IsTokenAuth {
		result := make([]map[string]string, 0, len(rows))
		for _, row := range rows {
			result = append(result, map[string]string{"id": row.ID, "state": row.State})
		}
		_ = json.NewEncoder(w).Encode(result)
		return
	}
	_ = json.NewEncoder(w).Encode(rows)
}

func (h *ConfirmationsHandler) Create(w http.ResponseWriter, r *http.Request) {
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil {
		confirmationError(w, 401, "permission", "unauthenticated", "Sign in")
		return
	}
	if info.CredentialKind() != middleware.CredentialDelegated || !info.Scopes.Has(middleware.ScopeWriteRepository) {
		confirmationError(w, 403, "permission", "permission", "A delegated command is required")
		return
	}
	if key := r.Header.Get("Idempotency-Key"); key == "" || len(key) > 256 {
		confirmationError(w, 400, "user", "idempotency_key_required", "Idempotency-Key is required")
		return
	}
	var input services.ConfirmationInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || input.Command == "" {
		confirmationError(w, 400, "user", "invalid_confirmation", "Invalid confirmation request")
		return
	}
	input.Key = r.Header.Get("Idempotency-Key")
	receipt, err := h.Service.RequestConfirmation(r.Context(), input)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	WriteRequestedConfirmation(w, r, receipt)
}

// WriteRequestedConfirmation preserves the two-field receipt. Presentation
// metadata names the credential's person without another CLI request; it grants
// no authority and never takes identity from caller-supplied attribution.
func WriteRequestedConfirmation(w http.ResponseWriter, r *http.Request, receipt services.ConfirmationReceipt) {
	if info := middleware.AuthInfoFromContext(r.Context()); info != nil && info.User != nil {
		person := info.User.DisplayName
		if person == "" {
			person = info.User.Username
		}
		w.Header().Set("Smithers-Confirmation-Person", url.PathEscape(person))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(receipt)
}

func (h *ConfirmationsHandler) decide(w http.ResponseWriter, r *http.Request, decision string) {
	if _, ok := h.member(w, r, true); !ok {
		return
	}
	if key := r.Header.Get("Idempotency-Key"); key == "" || len(key) > 256 {
		confirmationError(w, 400, "user", "idempotency_key_required", "Idempotency-Key is required")
		return
	}
	receipt, err := h.Service.DecideConfirmation(r.Context(), chi.URLParam(r, "id"), decision, r.Header.Get("Idempotency-Key"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": receipt.ID, "state": receipt.State})
}

func RegisterConfirmationRoutes(r chi.Router, h *ConfirmationsHandler) {
	r.Get("/confirmations", h.List)
	r.Post("/confirmations", h.Create)
	r.Post("/confirmations/{id}/approve", func(w http.ResponseWriter, r *http.Request) { h.decide(w, r, "approve") })
	r.Post("/confirmations/{id}/deny", func(w http.ResponseWriter, r *http.Request) { h.decide(w, r, "deny") })
}
