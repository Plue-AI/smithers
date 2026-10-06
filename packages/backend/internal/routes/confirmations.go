package routes

import (
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"time"
)

// ConfirmationsHandler adapts the existing approvals store for the install.
// Approval execution remains refused until the production dispatch consumer
// supplies the subject transaction; never turn a row into authority by itself.
type ConfirmationsHandler struct{ Queries *db.Queries }

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
	// Explicit creation is never a session action. It must be resolved and
	// authorized once against a catalog command by the delegated dispatcher.
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil {
		confirmationError(w, 401, "permission", "unauthenticated", "Sign in")
		return
	}
	if !info.IsTokenAuth || (info.CredentialKind() != middleware.CredentialDelegated && info.CredentialKind() != middleware.CredentialPerson) || !info.Scopes.Has(middleware.ScopeWriteRepository) {
		confirmationError(w, 403, "permission", "permission", "A delegated command is required")
		return
	}
	if key := r.Header.Get("Idempotency-Key"); len(key) == 0 || len(key) > 256 {
		confirmationError(w, 400, "user", "idempotency_key_required", "Idempotency-Key is required")
		return
	}
	if _, ok := info.TerminalDelegation(); ok {
		confirmationError(w, 403, "permission", "permission", "Not available for this credential")
		return
	}
	var input struct {
		Command string `json:"command"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || input.Command == "" {
		confirmationError(w, 400, "user", "invalid_confirmation", "A command is required")
		return
	}
	// Resolve authority for the requested action once. Reading confirmations
	// is not authority to request a merge or a person-only write. In
	// particular, a missing consumer must not hide permission/never refusals.
	if _, err := services.Authorize(r.Context(), h.Queries, input.Command); err != nil {
		var access *services.AccessError
		if !errors.As(err, &access) || access.Code != "confirm_in_app" {
			todoRouteError(w, err)
			return
		}
		// Eligible TODO creation still requires the private dispatch consumer.
	}
	confirmationError(w, 503, "infra", "confirmation_unavailable", "Confirmation dispatch unavailable")
}

func (h *ConfirmationsHandler) decide(w http.ResponseWriter, r *http.Request, decision string) {
	if h == nil || h.Queries == nil {
		confirmationError(w, 503, "infra", "confirmation_unavailable", "Confirmation store unavailable")
		return
	}
	member, ok := h.member(w, r, true)
	if !ok {
		return
	}
	if key := r.Header.Get("Idempotency-Key"); len(key) == 0 || len(key) > 256 {
		confirmationError(w, 400, "user", "idempotency_key_required", "Idempotency-Key is required")
		return
	}
	row, err := h.Queries.GetMemberConfirmation(r.Context(), chi.URLParam(r, "id"), member)
	if errors.Is(err, pgx.ErrNoRows) {
		confirmationError(w, 403, "permission", "permission", "Not your confirmation")
		return
	}
	if err != nil {
		todoRouteError(w, err)
		return
	}
	// The decision is for the bound command, never a generic permission to
	// approve. A role downgrade takes effect before row/effect disclosure.
	if _, err = services.Authorize(r.Context(), h.Queries, row.Command); err != nil {
		todoRouteError(w, err)
		return
	}
	credential := middleware.AuthInfoFromContext(r.Context()).SessionHash
	key := r.Header.Get("Idempotency-Key")
	previous, pressErr := h.Queries.ConfirmationPress(r.Context(), credential, key)
	if pressErr != nil && !errors.Is(pressErr, pgx.ErrNoRows) {
		todoRouteError(w, pressErr)
		return
	}
	if previous != "" && (previous != row.ID || decision != "deny") {
		confirmationError(w, 409, "conflict", "idempotency_mismatch", "Idempotency-Key was already used for a different request")
		return
	}
	if previous == row.ID && row.State == "rejected" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": row.ID, "state": "rejected"})
		return
	}
	if row.State == "pending" && !row.ExpiresAt.After(time.Now()) {
		_, err = h.Queries.SettleMemberConfirmation(r.Context(), row.ID, member, "expired")
		if err != nil {
			todoRouteError(w, err)
			return
		}
		row.State = "expired"
	}
	if row.State != "pending" {
		confirmationError(w, 409, "conflict", "confirmation_resolved", "Confirmation is "+row.State)
		return
	}
	if decision != "deny" {
		confirmationError(w, 503, "infra", "confirmation_unavailable", "Confirmation execution unavailable")
		return
	}
	changed, err := h.Queries.DenyMemberConfirmation(r.Context(), row.ID, member, credential, key)
	var duplicate *pgconn.PgError
	if errors.As(err, &duplicate) && duplicate.Code == "23505" {
		confirmationError(w, 409, "conflict", "idempotency_mismatch", "Idempotency-Key was already used for a different request")
		return
	}
	if err != nil {
		todoRouteError(w, err)
		return
	}
	if !changed {
		confirmationError(w, 409, "conflict", "confirmation_resolved", "Confirmation changed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": row.ID, "state": "rejected"})
}

func RegisterConfirmationRoutes(r chi.Router, h *ConfirmationsHandler) {
	r.Get("/confirmations", h.List)
	r.Post("/confirmations", h.Create)
	r.Post("/confirmations/{id}/approve", func(w http.ResponseWriter, r *http.Request) { h.decide(w, r, "approve") })
	r.Post("/confirmations/{id}/deny", func(w http.ResponseWriter, r *http.Request) { h.decide(w, r, "deny") })
}
