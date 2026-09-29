package routes

import (
	"context"
	stdErrors "errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ChangesetRouteService is the service surface behind the org changeset routes.
type ChangesetRouteService interface {
	CreateChangeset(ctx context.Context, actor *db.User, orgName string, input services.CreateChangesetInput) (services.ChangesetResponse, error)
	GetChangeset(ctx context.Context, viewer *db.User, orgName string, id int64) (services.ChangesetResponse, error)
	ListChangesets(ctx context.Context, viewer *db.User, orgName string, page, perPage int) ([]services.ChangesetResponse, error)
	LandChangeset(ctx context.Context, actor *db.User, orgName string, id int64) (services.ChangesetResponse, error)
}

// ChangesetHandler serves /api/orgs/{org}/changesets.
type ChangesetHandler struct {
	Service ChangesetRouteService
}

func changesetOrg(r *http.Request) (string, error) {
	org := strings.TrimSpace(chi.URLParam(r, "org"))
	if org == "" {
		return "", errors.BadRequest("organization name is required")
	}
	return org, nil
}

func changesetID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(chi.URLParam(r, "id")), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.BadRequest("invalid changeset id")
	}
	return id, nil
}

// CreateChangeset handles POST /api/orgs/{org}/changesets.
func (h *ChangesetHandler) CreateChangeset(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	org, err := changesetOrg(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var input services.CreateChangesetInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	created, err := h.Service.CreateChangeset(r.Context(), user, org, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, created)
}

// GetChangeset handles GET /api/orgs/{org}/changesets/{id}.
func (h *ChangesetHandler) GetChangeset(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	org, err := changesetOrg(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := changesetID(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	cs, err := h.Service.GetChangeset(r.Context(), user, org, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, cs)
}

// ListChangesets handles GET /api/orgs/{org}/changesets.
func (h *ChangesetHandler) ListChangesets(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	org, err := changesetOrg(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	page, parseErr := strconv.Atoi(r.URL.Query().Get("page"))
	if stdErrors.Is(parseErr, strconv.ErrRange) {
		errors.WriteError(w, errors.BadRequest("invalid page value"))
		return
	}
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	if _, _, _, err := services.ChangesetPageOffset(page, perPage); err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	items, err := h.Service.ListChangesets(r.Context(), user, org, page, perPage)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if items == nil {
		items = []services.ChangesetResponse{}
	}
	errors.WriteJSON(w, http.StatusOK, items)
}

// LandChangeset handles POST /api/orgs/{org}/changesets/{id}/land.
func (h *ChangesetHandler) LandChangeset(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	org, err := changesetOrg(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	id, err := changesetID(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	landed, err := h.Service.LandChangeset(r.Context(), user, org, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, landed)
}
