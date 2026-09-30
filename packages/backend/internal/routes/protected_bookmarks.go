package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type ProtectedBookmarkRouteService interface {
	UpsertProtectedBookmark(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertProtectedBookmarkInput) (services.ProtectedBookmarkResponse, error)
	ListProtectedBookmarks(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]services.ProtectedBookmarkResponse, error)
	DeleteProtectedBookmark(ctx context.Context, actor *db.User, owner, repo, pattern string) error
}

type ProtectedBookmarkHandler struct {
	Service ProtectedBookmarkRouteService
}

type upsertProtectedBookmarkRequest struct {
	Pattern                string   `json:"pattern"`
	RequireReview          bool     `json:"require_review"`
	RequireHumanApprovals  int64    `json:"require_human_approvals"`
	RequireAgentLGTM       bool     `json:"require_agent_lgtm"`
	RequireStatusChecks    bool     `json:"require_status_checks"`
	RequiredStatusContexts []string `json:"required_status_contexts"`
}

func (h *ProtectedBookmarkHandler) UpsertProtectedBookmark(w http.ResponseWriter, r *http.Request) {
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

	var req upsertProtectedBookmarkRequest
	if err := decodeJSONBodyError(w, r, &req); err != nil {
		errors.WriteError(w, errors.BadRequest("invalid request body"))
		return
	}

	result, svcErr := h.Service.UpsertProtectedBookmark(r.Context(), actor, owner, repo, services.UpsertProtectedBookmarkInput{
		Pattern:                req.Pattern,
		RequireReview:          req.RequireReview,
		RequireHumanApprovals:  req.RequireHumanApprovals,
		RequireAgentLGTM:       req.RequireAgentLGTM,
		RequireStatusChecks:    req.RequireStatusChecks,
		RequiredStatusContexts: req.RequiredStatusContexts,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *ProtectedBookmarkHandler) ListProtectedBookmarks(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	items, svcErr := h.Service.ListProtectedBookmarks(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, page, perPage)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, items)
}

func (h *ProtectedBookmarkHandler) DeleteProtectedBookmark(w http.ResponseWriter, r *http.Request) {
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

	pattern, err := routeParam(r, "pattern", "pattern is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if svcErr := h.Service.DeleteProtectedBookmark(r.Context(), actor, owner, repo, pattern); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
