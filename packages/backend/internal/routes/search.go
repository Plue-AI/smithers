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

type SearchRouteService interface {
	SearchRepositories(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error)
	SearchIssues(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error)
	SearchUsers(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error)
	SearchCode(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error)
}

type SearchHandler struct {
	Service SearchRouteService
}

func (h *SearchHandler) SearchRepositories(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parseSearchPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.Service.SearchRepositories(r.Context(), middleware.UserFromContext(r.Context()), services.SearchRepositoriesInput{
		Query:   r.URL.Query().Get("q"),
		Page:    page,
		PerPage: perPage,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *SearchHandler) SearchIssues(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parseSearchPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.Service.SearchIssues(r.Context(), middleware.UserFromContext(r.Context()), services.SearchIssuesInput{
		Query:     r.URL.Query().Get("q"),
		State:     strings.TrimSpace(r.URL.Query().Get("state")),
		Label:     strings.TrimSpace(r.URL.Query().Get("label")),
		Assignee:  strings.TrimSpace(r.URL.Query().Get("assignee")),
		Milestone: strings.TrimSpace(r.URL.Query().Get("milestone")),
		Page:      page,
		PerPage:   perPage,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *SearchHandler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parseSearchPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.Service.SearchUsers(r.Context(), services.SearchUsersInput{
		Query:   r.URL.Query().Get("q"),
		Page:    page,
		PerPage: perPage,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *SearchHandler) SearchCode(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parseSearchPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.Service.SearchCode(r.Context(), middleware.UserFromContext(r.Context()), services.SearchCodeInput{
		Query:   r.URL.Query().Get("q"),
		Page:    page,
		PerPage: perPage,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result)
}

func parseSearchPagination(r *http.Request) (cursor string, limit int, err error) {
	return parseOffsetPaginationWithLimits(r, 30, 100, "invalid limit value", false)
}
