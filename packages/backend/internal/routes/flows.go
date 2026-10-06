package routes

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// FlowsHandler serves the install's flow catalog (spec §6.3 GET /api/flows),
// the model the Flow card and the app agent's flow commands read. Any member's
// browser session reads it.
type FlowsHandler struct {
	Queries   *db.Queries
	Proposals services.FlowProposalReader
}

// List answers overridable flows and measured refusals of repository files
// with system names. Before setup binds a repository it lists the built-ins.
func (h *FlowsHandler) List(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Queries == nil {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "flows_unavailable", Class: "infra", Message: "Flows unavailable"})
		return
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "flows.read"); err != nil {
		todoRouteError(w, err)
		return
	}
	cards, err := h.catalog(r)
	if err != nil {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "flows_unavailable", Class: "infra", Message: "Flows unavailable"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(cards)
}

// catalog is the install repository's catalog (its loaded versions), or the
// built-in catalog while setup has bound no repository.
func (h *FlowsHandler) catalog(r *http.Request) ([]services.FlowCard, error) {
	repositoryID, err := h.Queries.InstallRepositoryID(r.Context())
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, db.ErrInstallRepositoryUnavailable) {
		return services.FlowCatalog()
	}
	if err != nil {
		return nil, err
	}
	return services.RepositoryFlowCatalog(r.Context(), h.Queries, repositoryID, h.Proposals)
}
