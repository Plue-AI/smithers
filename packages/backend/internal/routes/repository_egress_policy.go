package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// RepositoryEgressPolicyRouteService reads and replaces a repository's
// egress allowlist.
type RepositoryEgressPolicyRouteService interface {
	Get(ctx context.Context, repositoryID int64) (services.RepositoryEgressPolicy, error)
	Put(ctx context.Context, actor *db.User, repositoryID int64, domains []string) (services.RepositoryEgressPolicyUpdate, error)
}

// RepositoryEgressPolicyHandler serves /api/repos/{owner}/{repo}/egress-policy.
// The router admits only the repository's owner.
type RepositoryEgressPolicyHandler struct {
	Service RepositoryEgressPolicyRouteService
}

type putRepositoryEgressPolicyRequest struct {
	AllowDomains *[]string `json:"allow_domains"`
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

// PutEgressPolicy replaces the allowlist and reloads it into every running
// sandbox of the repository, answering each sandbox's outcome.
func (h *RepositoryEgressPolicyHandler) PutEgressPolicy(w http.ResponseWriter, r *http.Request) {
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
	var input putRepositoryEgressPolicyRequest
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	if input.AllowDomains == nil {
		errors.WriteError(w, errors.BadRequest("allow_domains is required"))
		return
	}
	update, err := h.Service.Put(r.Context(), actor, repository.ID, *input.AllowDomains)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, update)
}
