package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BranchReadService is the workspace service's branch projection.
type BranchReadService interface {
	ListBranches(context.Context, int64, int64, int, int) ([]services.BranchMachineResponse, int64, error)
	GetBranch(context.Context, string, int64, int64) (services.BranchMachineResponse, error)
}

// BranchForkService is the stack service's Fork.
type BranchForkService interface {
	ForkBranch(context.Context, int64, int64, services.BranchForkInput) (services.BranchMachineResponse, error)
}

// BranchHandler serves the install's branches (spec §6.3 /api/branches):
// reads of the workspace projection and Fork, which the stack service
// performs. Authorize decides the command for the request's person and
// resolves the install's repository; a caller never names either.
type BranchHandler struct {
	Authorize func(r *http.Request, command string) (repositoryID, userID int64, err error)
	Reads     BranchReadService
	Forks     BranchForkService
}

// RegisterBranchRoutes mounts /branches under the install's /api router;
// the legacy hosted composition never calls it. A route whose service the
// composition lacks answers 503.
func RegisterBranchRoutes(r chi.Router, h *BranchHandler) {
	if h == nil {
		return
	}
	r.Get("/branches", h.ListBranches)
	r.Get("/branches/{b}", h.GetBranch)
	r.Post("/branches", h.Fork)
}

// authorize decides command once the route's service is composed.
func (h *BranchHandler) authorize(r *http.Request, command string, composed bool) (int64, int64, error) {
	if h.Authorize == nil || !composed {
		return 0, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branches unavailable")
	}
	return h.Authorize(r, command)
}

// InstallBranchAuthorizer decides a branch command for the request's person
// (services.Authorize, by roster role) and resolves the install's repository.
func InstallBranchAuthorizer(queries *db.Queries) func(*http.Request, string) (int64, int64, error) {
	return func(r *http.Request, command string) (int64, int64, error) {
		if queries == nil {
			return 0, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branches unavailable")
		}
		decision, err := services.Authorize(r.Context(), queries, command)
		if err != nil {
			return 0, 0, err
		}
		repository, err := services.InstallRepositoryID(r.Context(), queries)
		if err != nil {
			return 0, 0, err
		}
		return repository, decision.UserID, nil
	}
}

func (h *BranchHandler) ListBranches(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branches.read", h.Reads != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	rows, total, err := h.Reads.ListBranches(r.Context(), repository, user, page, limit)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	setOffsetCursorPaginationHeaders(w, r, page, limit, len(rows), total)
	pkgerrors.WriteJSON(w, http.StatusOK, rows)
}

func (h *BranchHandler) GetBranch(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branches.read", h.Reads != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("invalid branch name"))
		return
	}
	row, err := h.Reads.GetBranch(r.Context(), branch, repository, user)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, row)
}

// Fork is POST /api/branches fork{from, name?}: 201 with the new scratch
// branch, forked_from and its head.
func (h *BranchHandler) Fork(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branch.fork", h.Forks != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	var input services.BranchForkInput
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("invalid fork request"))
		return
	}
	branch, err := h.Forks.ForkBranch(r.Context(), repository, user, input)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, branch)
}

// writeBranchError keeps the resource's errors on the §6.2.3 wire contract
// while the legacy workspace endpoints retain their existing error decoder.
func writeBranchError(w http.ResponseWriter, r *http.Request, err error) {
	var refused *services.BranchError
	if errors.As(err, &refused) {
		pkgerrors.WriteJSON(w, refused.Status, refused)
		return
	}
	var access *services.AccessError
	if errors.As(err, &access) {
		pkgerrors.WriteJSON(w, access.Status, access)
		return
	}
	status, code, class, message := 503, "branch_machine_unavailable", "infra", "Branch unavailable"
	var e *pkgerrors.APIError
	if errors.As(err, &e) {
		switch e.Status {
		case 401:
			status, code, class, message = 401, "unauthenticated", "permission", middleware.UnauthenticatedMessage(r.Context())
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
