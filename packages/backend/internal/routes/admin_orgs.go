package routes

import (
	"context"
	"net/http"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// AdminOrgRouteService is the service interface required by AdminOrgHandler.
type AdminOrgRouteService interface {
	ListAllOrgs(ctx context.Context, input services.AdminOrgListInput) ([]services.OrgResponse, int64, error)
}

// AdminOrgHandler handles admin-level org listing endpoints.
type AdminOrgHandler struct {
	Service AdminOrgRouteService
}

// ListOrgs handles GET /api/admin/orgs.
func (h *AdminOrgHandler) ListOrgs(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parseOffsetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	page := cursorToPage(cursor, limit)
	orgs, total, err := h.Service.ListAllOrgs(r.Context(), services.AdminOrgListInput{
		Page:    page,
		PerPage: limit,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(orgs), total)
	pkgerrors.WriteJSON(w, http.StatusOK, orgs)
}
