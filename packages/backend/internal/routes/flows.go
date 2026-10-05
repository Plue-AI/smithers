package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// FlowsHandler serves the install's flow catalog (spec §6.3 GET /api/flows),
// the model the Flow card and the app agent's flow commands read. Any member's
// browser session reads it.
type FlowsHandler struct {
	Queries *db.Queries
}

// List answers the catalog: each overridable flow with its versions, and no
// system flow. Before setup binds a repository it lists the built-ins.
func (h *FlowsHandler) List(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Queries == nil {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "flows_unavailable", Class: "infra", Message: "Flows unavailable"})
		return
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "flows.read"); err != nil {
		todoRouteError(w, err)
		return
	}
	if name := r.URL.Query().Get("name"); name != "" && !services.Overridable(name) {
		title := strings.ToUpper(name[:1]) + name[1:]
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "system_flow", Class: "user", Message: title + " flow is built in"})
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
	setting, err := h.Queries.GetInstallSetting(r.Context(), "github.repository")
	if errors.Is(err, pgx.ErrNoRows) {
		return services.FlowCatalog()
	}
	if err != nil {
		return nil, err
	}
	var binding struct {
		Owner string `json:"owner_login"`
		Name  string `json:"repository_name"`
	}
	if err = json.Unmarshal(setting.Value, &binding); err != nil || binding.Owner == "" || binding.Name == "" {
		return services.FlowCatalog()
	}
	repo, err := h.Queries.GetRepoByOwnerAndName(r.Context(), db.GetRepoByOwnerAndNameParams{Owner: binding.Owner, Name: binding.Name})
	if errors.Is(err, pgx.ErrNoRows) {
		return services.FlowCatalog()
	}
	if err != nil {
		return nil, err
	}
	return services.RepositoryFlowCatalog(r.Context(), h.Queries, repo.ID)
}
