package routes

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
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
	ExportUser(ctx context.Context, username string, w io.Writer) (services.AccountExportManifest, error)
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
	cursor, limit, err := parseOffsetPagination(r)
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
	// UserID binds the erase to the account that asked; a retry passes the
	// user_id the first erase returned.
	UserID int64 `json:"user_id"`
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
	if req.UserID < 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("user_id must be positive"))
		return
	}
	result, err := h.Service.EraseUser(adminUserAuditContext(r), username, services.EraseUserRequest{RequestedAt: requestedAt, UserID: req.UserID})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

// ExportUser answers POST /api/admin/users/{username}/export with the
// account's archive. The archive is staged in full first, so a failure is an
// error response and never a truncated download.
func (h *AdminUserHandler) ExportUser(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(chi.URLParam(r, "username"))
	if username == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("username is required"))
		return
	}
	staged, err := os.CreateTemp("", "account-export-*.tar.gz")
	if err != nil {
		writeRouteError(w, r, pkgerrors.Internal("failed to stage export").WithCause(err))
		return
	}
	defer os.Remove(staged.Name())
	defer staged.Close()
	manifest, err := h.Service.ExportUser(adminUserAuditContext(r), username, staged)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	size, err := staged.Seek(0, io.SeekEnd)
	if err == nil {
		_, err = staged.Seek(0, io.SeekStart)
	}
	if err != nil {
		writeRouteError(w, r, pkgerrors.Internal("failed to read export").WithCause(err))
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", manifest.Username+"-export.tar.gz"))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, staged)
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
