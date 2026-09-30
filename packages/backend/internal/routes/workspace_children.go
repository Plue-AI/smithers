package routes

import (
	"context"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// workspaceChildrenRouteService spawns, lists and stops a workspace's
// children (#2802).
type workspaceChildrenRouteService interface {
	SpawnWorkspaceChildren(ctx context.Context, input services.SpawnWorkspaceChildrenInput) (services.WorkspaceChildBatch, error)
	ListWorkspaceChildren(ctx context.Context, workspaceID string, repositoryID, userID int64) ([]services.WorkspaceChild, error)
	StopWorkspaceChild(ctx context.Context, parentWorkspaceID, childWorkspaceID string, repositoryID, userID int64) (services.WorkspaceChild, error)
}

type spawnWorkspaceChildrenRequest struct {
	Count   int    `json:"count"`
	Profile string `json:"profile"`
	TTLSecs int64  `json:"ttl_secs"`
}

// RegisterWorkspaceChildrenRoutes mounts the children routes. They take the
// workspace scope, never the repository scope, so the workspace's own
// children credential reaches them and nothing else.
func RegisterWorkspaceChildrenRoutes(r chi.Router, handler *WorkspaceHandler, read, write []func(http.Handler) http.Handler) {
	if r == nil || handler == nil {
		return
	}
	r.With(read...).Get("/workspaces/{id}/children", handler.ListWorkspaceChildren)
	r.With(write...).Post("/workspaces/{id}/children", handler.SpawnWorkspaceChildren)
	r.With(write...).Post("/workspaces/{id}/children/{child_id}/stop", handler.StopWorkspaceChild)
}

// workspaceChildrenRequest resolves the caller, repository, workspace and
// service shared by every children route. A workspace-bound credential
// addresses only its own workspace.
func (h *WorkspaceHandler) workspaceChildrenRequest(w http.ResponseWriter, r *http.Request) (svc workspaceChildrenRouteService, userID, repositoryID int64, workspaceID string, bound, ok bool) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return nil, 0, 0, "", false, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return nil, 0, 0, "", false, false
	}
	workspaceID, err = routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return nil, 0, 0, "", false, false
	}
	if restriction := middleware.AuthInfoFromContext(r.Context()).WorkspaceRestriction(); restriction != "" {
		if !strings.EqualFold(restriction, workspaceID) {
			pkgerrors.WriteError(w, pkgerrors.Forbidden("workspace credentials may only manage their own workspace's children"))
			return nil, 0, 0, "", false, false
		}
		bound = true
	}
	svc, ok = h.Service.(workspaceChildrenRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Conflict("child workspaces need the sandbox provider"))
		return nil, 0, 0, "", false, false
	}
	return svc, user.ID, repoCtx.Repository.ID, workspaceID, bound, true
}

// SpawnWorkspaceChildren handles POST /api/repos/{owner}/{repo}/workspaces/{id}/children.
func (h *WorkspaceHandler) SpawnWorkspaceChildren(w http.ResponseWriter, r *http.Request) {
	svc, userID, repositoryID, workspaceID, bound, ok := h.workspaceChildrenRequest(w, r)
	if !ok {
		return
	}
	var req spawnWorkspaceChildrenRequest
	if !decodeStrictJSONBody(w, r, &req) {
		return
	}
	if req.TTLSecs < 0 || req.TTLSecs > math.MaxInt64/int64(time.Second) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("ttl_secs is out of range"))
		return
	}
	batch, err := svc.SpawnWorkspaceChildren(r.Context(), services.SpawnWorkspaceChildrenInput{
		RepositoryID: repositoryID, UserID: userID, ParentWorkspaceID: workspaceID,
		Count: req.Count, Profile: req.Profile, TTL: time.Duration(req.TTLSecs) * time.Second,
		ViaWorkspaceCredential: bound,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, batch)
}

// ListWorkspaceChildren handles GET /api/repos/{owner}/{repo}/workspaces/{id}/children.
func (h *WorkspaceHandler) ListWorkspaceChildren(w http.ResponseWriter, r *http.Request) {
	svc, userID, repositoryID, workspaceID, _, ok := h.workspaceChildrenRequest(w, r)
	if !ok {
		return
	}
	children, err := svc.ListWorkspaceChildren(r.Context(), workspaceID, repositoryID, userID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, children)
}

// StopWorkspaceChild handles POST /api/repos/{owner}/{repo}/workspaces/{id}/children/{child_id}/stop.
func (h *WorkspaceHandler) StopWorkspaceChild(w http.ResponseWriter, r *http.Request) {
	svc, userID, repositoryID, workspaceID, _, ok := h.workspaceChildrenRequest(w, r)
	if !ok {
		return
	}
	childID, err := routeParam(r, "child_id", "child workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	child, err := svc.StopWorkspaceChild(r.Context(), workspaceID, childID, repositoryID, userID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, child)
}
