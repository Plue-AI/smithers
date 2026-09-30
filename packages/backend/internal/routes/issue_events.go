package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// IssueEventRouteService is the subset of IssueEventService consumed by the route layer.
type IssueEventRouteService interface {
	ListIssueEvents(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]services.IssueEventResponse, error)
}

// IssueEventHandler handles HTTP routes for issue event timelines.
type IssueEventHandler struct {
	Service IssueEventRouteService
	Broker  *sse.Broker
}

// ListIssueEvents handles GET /repos/{owner}/{repo}/issues/{number}/events
func (h *IssueEventHandler) ListIssueEvents(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number is required", "invalid issue number")
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
	items, err := h.Service.ListIssueEvents(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number, page, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, items)
}
