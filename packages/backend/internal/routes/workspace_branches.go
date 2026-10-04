package routes

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type branchReadService interface {
	ListBranches(context.Context, int64, int64, int, int) ([]services.BranchMachineResponse, int64, error)
	GetBranch(context.Context, string, int64, int64) (services.BranchMachineResponse, error)
}

// RegisterBranchReadRoutes is intentionally not called by the legacy hosted
// composition. Install mounts it only with its trusted repository and the
// catalog/membership middleware, after the activation checks pass.
func RegisterBranchReadRoutes(r chi.Router, h *WorkspaceHandler, read []func(http.Handler) http.Handler) {
	if h == nil || h.BranchRepositoryID <= 0 {
		return
	}
	r.With(read...).Get("/api/branches", h.ListBranches)
	r.With(read...).Get("/api/branches/{b}", h.GetBranch)
}

func (h *WorkspaceHandler) ListBranches(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeBranchReadError(w, err)
		return
	}
	svc, ok := h.Service.(branchReadService)
	if !ok || h.BranchRepositoryID <= 0 {
		writeBranchReadError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch reads unavailable"))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		writeBranchReadError(w, err)
		return
	}
	page := cursorToPage(cursor, limit)
	rows, total, err := svc.ListBranches(r.Context(), h.BranchRepositoryID, user.ID, page, limit)
	if err != nil {
		writeBranchReadError(w, err)
		return
	}
	setOffsetCursorPaginationHeaders(w, r, page, limit, len(rows), total)
	pkgerrors.WriteJSON(w, http.StatusOK, rows)
}

func (h *WorkspaceHandler) GetBranch(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeBranchReadError(w, err)
		return
	}
	svc, ok := h.Service.(branchReadService)
	if !ok || h.BranchRepositoryID <= 0 {
		writeBranchReadError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch reads unavailable"))
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchReadError(w, pkgerrors.BadRequest("invalid branch name"))
		return
	}
	row, err := svc.GetBranch(r.Context(), branch, h.BranchRepositoryID, user.ID)
	if err != nil {
		writeBranchReadError(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, row)
}

// Keep the new resource's errors on the §6.2.3 wire contract while the legacy
// workspace endpoints retain their existing error decoder.
func writeBranchReadError(w http.ResponseWriter, err error) {
	status, code, class, message := 503, "branch_machine_unavailable", "infra", "Branch unavailable"
	var e *pkgerrors.APIError
	if errors.As(err, &e) {
		switch e.Status {
		case 401:
			status, code, class, message = 401, "unauthenticated", "permission", "Sign in"
		case 403:
			status, code, class, message = 403, "permission", "permission", "Access denied"
		case 400, 404:
			status, code, class, message = e.Status, string(e.Code), "user", e.Message
		case 409:
			status, code, class, message = 409, string(e.Code), "conflict", e.Message
		}
	}
	pkgerrors.WriteJSON(w, status, map[string]string{"code": code, "class": class, "message": message})
}
