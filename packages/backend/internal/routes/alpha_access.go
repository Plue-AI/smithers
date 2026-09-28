package routes

import (
	"context"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AlphaAccessRouteService interface {
	JoinWaitlist(ctx context.Context, input services.WaitlistJoinInput) (services.AlphaWaitlistEntry, error)
	ListWhitelistEntries(ctx context.Context) ([]services.AlphaWhitelistEntry, error)
	AddWhitelistEntry(ctx context.Context, actor *db.User, input services.AddWhitelistEntryInput) (services.AlphaWhitelistEntry, error)
	RemoveWhitelistEntry(ctx context.Context, input services.RemoveWhitelistEntryInput) error
	ListWaitlistEntries(ctx context.Context, input services.ListWaitlistInput) (services.AlphaWaitlistListResult, error)
	ApproveWaitlistEntry(ctx context.Context, actor *db.User, email string) (services.AlphaWaitlistEntry, error)
}

type AlphaAccessHandler struct {
	Service      AlphaAccessRouteService
	AuditService *services.AuditService
}

func (h *AlphaAccessHandler) audit(r *http.Request, user *db.User, eventType, targetType, targetName, action string, targetID *int64, metadata map[string]any) {
	if h.AuditService == nil || user == nil {
		return
	}
	h.AuditService.Log(r.Context(), services.AuditEvent{
		EventType: eventType, ActorID: &user.ID, ActorName: user.Username,
		TargetType: targetType, TargetID: targetID, TargetName: targetName,
		Action: action, Metadata: metadata, IPAddress: r.RemoteAddr,
	})
}

type postWaitlistJoinRequest struct {
	Email  string `json:"email"`
	Note   string `json:"note"`
	Source string `json:"source"`
}

type postWhitelistEntryRequest struct {
	IdentityType  string `json:"identity_type"`
	IdentityValue string `json:"identity_value"`
}

type postWaitlistApproveRequest struct {
	Email string `json:"email"`
}

func (h *AlphaAccessHandler) PostWaitlistJoin(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.NotFound("alpha access service is not configured"))
		return
	}

	var req postWaitlistJoinRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	entry, err := h.Service.JoinWaitlist(r.Context(), services.WaitlistJoinInput{
		Email:  req.Email,
		Note:   req.Note,
		Source: req.Source,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, entry)
}

func (h *AlphaAccessHandler) GetAdminWhitelist(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.NotFound("alpha access service is not configured"))
		return
	}

	rows, err := h.Service.ListWhitelistEntries(r.Context())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, rows)
}

func (h *AlphaAccessHandler) PostAdminWhitelist(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.NotFound("alpha access service is not configured"))
		return
	}

	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req postWhitelistEntryRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	entry, err := h.Service.AddWhitelistEntry(r.Context(), user, services.AddWhitelistEntryInput{
		IdentityType:  req.IdentityType,
		IdentityValue: req.IdentityValue,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, entry)
	h.audit(r, user, "admin.alpha.whitelist.add", "alpha_whitelist", entry.IdentityValue, "add", &entry.ID, map[string]any{
		"identity_type":  entry.IdentityType,
		"identity_value": entry.IdentityValue,
	})
}

func (h *AlphaAccessHandler) DeleteAdminWhitelist(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.NotFound("alpha access service is not configured"))
		return
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	identityType := chi.URLParam(r, "identity_type")
	identityValue := chi.URLParam(r, "identity_value")
	if decodedType, err := url.PathUnescape(identityType); err == nil {
		identityType = decodedType
	}
	if decodedValue, err := url.PathUnescape(identityValue); err == nil {
		identityValue = decodedValue
	}
	canonicalType, canonicalValue, _, normalizeErr := services.NormalizeWhitelistIdentity(identityType, identityValue)
	if normalizeErr != nil {
		writeRouteError(w, r, normalizeErr)
		return
	}

	if err := h.Service.RemoveWhitelistEntry(r.Context(), services.RemoveWhitelistEntryInput{
		IdentityType:  canonicalType,
		IdentityValue: canonicalValue,
	}); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
	h.audit(r, user, "admin.alpha.whitelist.remove", "alpha_whitelist", canonicalValue, "remove", nil, map[string]any{
		"identity_type":  canonicalType,
		"identity_value": canonicalValue,
	})
}

func (h *AlphaAccessHandler) GetAdminWaitlist(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.NotFound("alpha access service is not configured"))
		return
	}

	cursor, limit, parseErr := parsePaginationWithLimits(r, 50, 100, "invalid limit value", false)
	if parseErr != nil {
		errors.WriteError(w, parseErr.(*errors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	result, err := h.Service.ListWaitlistEntries(r.Context(), services.ListWaitlistInput{
		Page:    page,
		PerPage: limit,
		Status:  r.URL.Query().Get("status"),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *AlphaAccessHandler) PostAdminWaitlistApprove(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		errors.WriteError(w, errors.NotFound("alpha access service is not configured"))
		return
	}

	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req postWaitlistApproveRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	entry, err := h.Service.ApproveWaitlistEntry(r.Context(), user, req.Email)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, entry)
	h.audit(r, user, "admin.alpha.waitlist.approve", "alpha_waitlist", entry.Email, "approve", &entry.ID, map[string]any{
		"email":  entry.Email,
		"status": entry.Status,
	})
}
