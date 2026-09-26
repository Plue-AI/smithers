package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type WikiService interface {
	ListWikiPages(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error)
	GetWikiPage(ctx context.Context, viewer *db.User, owner, repo, slug string) (services.WikiPageResponse, error)
	CreateWikiPage(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWikiPageInput) (services.WikiPageResponse, error)
	UpdateWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string, req services.UpdateWikiPageInput) (services.WikiPageResponse, error)
	DeleteWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string) error
	ListWikiRevisions(ctx context.Context, viewer *db.User, owner, repo, slug string, page, perPage int) ([]services.WikiRevisionResponse, int64, error)
}

type WikiHandler struct {
	Service WikiService
}

type createWikiPageRequest struct {
	Path  string `json:"path,omitempty"`
	Title string `json:"title"`
	Slug  string `json:"slug,omitempty"`
	Body  string `json:"body"`
}

type patchWikiPageRequest struct {
	Path             *string `json:"path,omitempty"`
	ExpectedRevision *int64  `json:"expected_revision,omitempty"`
	Title            *string `json:"title,omitempty"`
	Slug             *string `json:"slug,omitempty"`
	Body             *string `json:"body,omitempty"`
}

func ListWikiPages(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).ListWikiPages
}

func GetWikiPage(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).GetWikiPage
}

func CreateWikiPage(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).CreateWikiPage
}

func UpdateWikiPage(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).PatchWikiPage
}

func DeleteWikiPage(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).DeleteWikiPage
}

func SearchWikiPages(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).SearchWikiPages
}

func ListWikiRevisions(svc WikiService) http.HandlerFunc {
	return (&WikiHandler{Service: svc}).ListWikiRevisions
}

func (h *WikiHandler) ListWikiPages(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	items, total, svcErr := h.Service.ListWikiPages(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, services.ListWikiPagesInput{
		Query:   strings.TrimSpace(r.URL.Query().Get("q")),
		Page:    cursorToPage(cursor, limit),
		PerPage: limit,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(items), total)
	pkgerrors.WriteJSON(w, http.StatusOK, items)
}

func (h *WikiHandler) GetWikiPage(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	slug, err := routeParam(r, "slug", "wiki slug is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page, svcErr := h.Service.GetWikiPage(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, slug)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, page)
}

func (h *WikiHandler) CreateWikiPage(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req createWikiPageRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, svcErr := h.Service.CreateWikiPage(r.Context(), actor, owner, repo, services.CreateWikiPageInput{
		Title: req.Title, Path: req.Path,
		Slug: req.Slug,
		Body: req.Body,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, created)
}

func (h *WikiHandler) PatchWikiPage(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	slug, err := routeParam(r, "slug", "wiki slug is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req patchWikiPageRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, svcErr := h.Service.UpdateWikiPage(r.Context(), actor, owner, repo, slug, services.UpdateWikiPageInput{
		ExpectedRevision: req.ExpectedRevision, Path: req.Path,
		Title: req.Title,
		Slug:  req.Slug,
		Body:  req.Body,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, updated)
}

func (h *WikiHandler) DeleteWikiPage(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	slug, err := routeParam(r, "slug", "wiki slug is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	if svcErr := h.Service.DeleteWikiPage(r.Context(), actor, owner, repo, slug); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// SearchWikiPages handles GET /repos/{owner}/{repo}/wiki/search?q=...
// It requires a non-empty query parameter and returns matching pages with
// pagination headers.
func (h *WikiHandler) SearchWikiPages(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("search query is required"))
		return
	}
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	items, total, svcErr := h.Service.ListWikiPages(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, services.ListWikiPagesInput{
		Query:   q,
		Page:    cursorToPage(cursor, limit),
		PerPage: limit,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(items), total)
	pkgerrors.WriteJSON(w, http.StatusOK, items)
}

// ListWikiRevisions handles GET /repos/{owner}/{repo}/wiki/{slug}/revisions
func (h *WikiHandler) ListWikiRevisions(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	slug, err := routeParam(r, "slug", "wiki slug is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	revisions, total, svcErr := h.Service.ListWikiRevisions(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, slug, cursorToPage(cursor, limit), limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(revisions), total)
	pkgerrors.WriteJSON(w, http.StatusOK, revisions)
}
