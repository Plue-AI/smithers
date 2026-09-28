package routes

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AdminUserRouteService interface {
	SetSynthetic(context.Context, string, bool) (services.AdminSyntheticUserProfile, error)
	ListUsers(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error)
	CreateUser(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error)
	DeleteUser(ctx context.Context, username string) error
	SetUserAdmin(ctx context.Context, username string, isAdmin bool) (services.UserProfile, error)
	CreateTokenForUser(ctx context.Context, username string, req services.CreateTokenRequest) (services.CreateTokenResult, error)
	SetSuspended(ctx context.Context, username string, suspended bool) (services.UserProfile, error)
	RevokeToken(ctx context.Context, username string, tokenID int64) error
	EraseUser(ctx context.Context, username string, req services.EraseUserRequest) (services.EraseUserResult, error)
}

type AdminUserHandler struct {
	Service AdminUserRouteService
}

func adminUserAuditContext(r *http.Request) context.Context {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		return r.Context()
	}
	return services.ContextWithAdminAuditActor(r.Context(), services.AdminAuditActor{
		UserID:    user.ID,
		Username:  user.Username,
		IPAddress: r.RemoteAddr,
	})
}

func (h *AdminUserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	users, total, err := h.Service.ListUsers(r.Context(), services.AdminUserListInput{
		Page:    page,
		PerPage: limit,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(users), total)
	pkgerrors.WriteJSON(w, http.StatusOK, users)
}

// adminCreateUserRequest is the JSON body for POST /api/admin/users.
type adminCreateUserRequest struct {
	Username    string `json:"username"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
}

func (h *AdminUserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req adminCreateUserRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	profile, err := h.Service.CreateUser(adminUserAuditContext(r), services.AdminCreateUserInput{
		Username:    strings.TrimSpace(req.Username),
		Email:       strings.TrimSpace(req.Email),
		DisplayName: strings.TrimSpace(req.DisplayName),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, profile)
}

func (h *AdminUserHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if strings.TrimSpace(username) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}

	if err := h.Service.DeleteUser(adminUserAuditContext(r), username); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// adminEraseUserRequest is the JSON body for POST /api/admin/users/{username}/erase.
type adminEraseUserRequest struct {
	// RequestDate is the YYYY-MM-DD date the account holder asked for deletion.
	RequestDate string `json:"request_date"`
}

func (h *AdminUserHandler) EraseUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if strings.TrimSpace(username) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}
	var req adminEraseUserRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	requestedAt, err := time.Parse(time.DateOnly, strings.TrimSpace(req.RequestDate))
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("request_date must be YYYY-MM-DD"))
		return
	}
	result, err := h.Service.EraseUser(adminUserAuditContext(r), username, services.EraseUserRequest{RequestedAt: requestedAt})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

type patchUserAdminRequest struct {
	IsAdmin bool `json:"is_admin"`
}

func (h *AdminUserHandler) PatchUserAdmin(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if strings.TrimSpace(username) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}

	var req patchUserAdminRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	profile, err := h.Service.SetUserAdmin(adminUserAuditContext(r), username, req.IsAdmin)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, profile)
}

type postUserTokenRequest struct {
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
}

func (h *AdminUserHandler) PostUserToken(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if strings.TrimSpace(username) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}

	var req postUserTokenRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	result, err := h.Service.CreateTokenForUser(adminUserAuditContext(r), username, services.CreateTokenRequest{
		Name:   req.Name,
		Scopes: req.Scopes,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, result)
}

// adminPatchUserRequest is the JSON body for PATCH /api/admin/users/{username}.
// Supports suspension or synthetic classification, one field per request.
type adminPatchUserRequest struct {
	Suspended *bool `json:"suspended"`
	Synthetic *bool `json:"synthetic"`
}

// PatchUser handles PATCH /api/admin/users/{username}.
// Supports {"suspended": bool} or {"synthetic": bool}.
func (h *AdminUserHandler) PatchUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if strings.TrimSpace(username) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}

	var req adminPatchUserRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.Suspended == nil && req.Synthetic == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("suspended field is required unless synthetic is provided"))
		return
	}

	if req.Synthetic != nil {
		if req.Suspended != nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("provide only one of suspended or synthetic"))
			return
		}
		profile, err := h.Service.SetSynthetic(adminUserAuditContext(r), username, *req.Synthetic)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		pkgerrors.WriteJSON(w, http.StatusOK, profile)
		return
	}
	profile, err := h.Service.SetSuspended(adminUserAuditContext(r), username, *req.Suspended)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, profile)
}

// DeleteUserToken handles DELETE /api/admin/users/{username}/tokens/{token_id}.
// Revokes the specified access token for the given user.
func (h *AdminUserHandler) DeleteUserToken(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if strings.TrimSpace(username) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}

	tokenIDStr := chi.URLParam(r, "token_id")
	tokenID, err := strconv.ParseInt(tokenIDStr, 10, 64)
	if err != nil || tokenID <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("token_id must be a positive integer"))
		return
	}

	if err := h.Service.RevokeToken(adminUserAuditContext(r), username, tokenID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
