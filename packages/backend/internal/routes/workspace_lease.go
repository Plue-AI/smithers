package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type workspaceLeaseRenewer interface {
	RenewWorkspaceLease(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceResponse, error)
}

// RenewWorkspaceLease handles POST /api/repos/{owner}/{repo}/workspaces/{id}/lease:
// a leased workspace's client extends its lease by the lease length (#2457).
func (h *WorkspaceHandler) RenewWorkspaceLease(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}
	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	renewer, ok := h.Service.(workspaceLeaseRenewer)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace lease renewal unavailable"))
		return
	}
	updated, svcErr := renewer.RenewWorkspaceLease(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, updated)
}
