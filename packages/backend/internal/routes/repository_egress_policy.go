package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// RepositoryEgressPolicyRouteService reads and changes a repository's
// egress allowlist.
type RepositoryEgressPolicyRouteService interface {
	Get(ctx context.Context, repositoryID int64) (services.RepositoryEgressPolicy, error)
	Patch(ctx context.Context, actor *db.User, repositoryID int64, add, remove []string) (services.RepositoryEgressPolicyUpdate, error)
}

// RepositoryEgressPolicyHandler serves /api/repos/{owner}/{repo}/egress-policy.
// The router admits only the repository's owner.
type RepositoryEgressPolicyHandler struct {
	Service RepositoryEgressPolicyRouteService
}

type patchRepositoryEgressPolicyRequest struct {
	Add    []string `json:"add"`
	Remove []string `json:"remove"`
}

// GetEgressPolicy answers the repository's allowlist.
func (h *RepositoryEgressPolicyHandler) GetEgressPolicy(w http.ResponseWriter, r *http.Request) {
	repository := middleware.RepoFromContext(r.Context())
	if repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}
	policy, err := h.Service.Get(r.Context(), repository.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, policy)
}

// PatchEgressPolicy adds and removes hosts atomically and reloads the result
// into every running sandbox of the repository, answering each sandbox's
// outcome. There is no whole-list write: a client never sends back a list it
// read, so overlapping writers cannot undo each other.
func (h *RepositoryEgressPolicyHandler) PatchEgressPolicy(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	repository := middleware.RepoFromContext(r.Context())
	if repository == nil {
		errors.WriteError(w, errors.Internal("repository context not loaded"))
		return
	}
	var input patchRepositoryEgressPolicyRequest
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	update, err := h.Service.Patch(r.Context(), actor, repository.ID, input.Add, input.Remove)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, update)
}
