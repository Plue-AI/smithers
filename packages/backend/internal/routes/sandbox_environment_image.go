package routes

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// SandboxEnvironmentImageRouteService is the registry surface for NixOS
// environment images (kind=vm / kind=desktop workspace images).
type SandboxEnvironmentImageRouteService interface {
	Register(ctx context.Context, input services.RegisterSandboxEnvironmentImageInput) (services.SandboxEnvironmentImageResponse, error)
	List(ctx context.Context, repositoryID int64) ([]services.SandboxEnvironmentImageResponse, error)
	Retire(ctx context.Context, repositoryID int64, id string) (services.SandboxEnvironmentImageResponse, error)
}

// SandboxEnvironmentImageHandler serves the image registry:
// per-repository under /api/repos/{owner}/{repo}/environment-images and the
// platform base images under /api/admin/sandbox/environment-images.
type SandboxEnvironmentImageHandler struct {
	Service SandboxEnvironmentImageRouteService
}

type registerEnvironmentImageRequest struct {
	Kind           string `json:"kind"`
	Source         string `json:"source"`
	SourceRevision string `json:"source_revision"`
	ClosureHash    string `json:"closure_hash"`
	Image          string `json:"image"`
}

func (h *SandboxEnvironmentImageHandler) register(w http.ResponseWriter, r *http.Request, repositoryID int64) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("environment image service unavailable"))
		return
	}
	var req registerEnvironmentImageRequest
	if err := decodeSingleJSONDocument(json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)), &req); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid JSON body"))
		return
	}
	resp, svcErr := h.Service.Register(r.Context(), services.RegisterSandboxEnvironmentImageInput{
		RepositoryID:   repositoryID,
		Kind:           req.Kind,
		Source:         req.Source,
		SourceRevision: req.SourceRevision,
		ClosureHash:    req.ClosureHash,
		Image:          req.Image,
		CreatedBy:      user.ID,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, resp)
}

func (h *SandboxEnvironmentImageHandler) list(w http.ResponseWriter, r *http.Request, repositoryID int64) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("environment image service unavailable"))
		return
	}
	items, svcErr := h.Service.List(r.Context(), repositoryID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, items)
}

func repoIDFromRoute(w http.ResponseWriter, r *http.Request) (int64, bool) {
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return 0, false
	}
	return repoCtx.Repository.ID, true
}

// RegisterRepoImage handles POST /api/repos/{owner}/{repo}/environment-images.
func (h *SandboxEnvironmentImageHandler) RegisterRepoImage(w http.ResponseWriter, r *http.Request) {
	repositoryID, ok := repoIDFromRoute(w, r)
	if !ok {
		return
	}
	h.register(w, r, repositoryID)
}

// ListRepoImages handles GET /api/repos/{owner}/{repo}/environment-images.
func (h *SandboxEnvironmentImageHandler) ListRepoImages(w http.ResponseWriter, r *http.Request) {
	repositoryID, ok := repoIDFromRoute(w, r)
	if !ok {
		return
	}
	h.list(w, r, repositoryID)
}

// RetireRepoImage handles DELETE /api/repos/{owner}/{repo}/environment-images/{id}.
func (h *SandboxEnvironmentImageHandler) RetireRepoImage(w http.ResponseWriter, r *http.Request) {
	repositoryID, ok := repoIDFromRoute(w, r)
	if !ok {
		return
	}
	id, err := routeParam(r, "id", "environment image id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("environment image service unavailable"))
		return
	}
	resp, svcErr := h.Service.Retire(r.Context(), repositoryID, id)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

// RegisterBaseImage handles POST /api/admin/sandbox/environment-images
// (platform base images, repository_id NULL).
func (h *SandboxEnvironmentImageHandler) RegisterBaseImage(w http.ResponseWriter, r *http.Request) {
	h.register(w, r, 0)
}

// ListBaseImages handles GET /api/admin/sandbox/environment-images.
func (h *SandboxEnvironmentImageHandler) ListBaseImages(w http.ResponseWriter, r *http.Request) {
	h.list(w, r, 0)
}
