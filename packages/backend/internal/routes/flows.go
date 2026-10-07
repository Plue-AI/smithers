package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
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
	Runs      *services.InstallFlowRuns
}

func flowNameParam(r *http.Request) (string, error) {
	name := chi.URLParam(r, "name")
	// Chi routes RawPath when present; otherwise its parameter already came
	// from Go's decoded Path. A literal percent must never be decoded twice.
	if r.URL.RawPath == "" {
		return name, nil
	}
	name, err := url.PathUnescape(name)
	if err != nil {
		return "", &services.TodoControlError{Status: 400, Code: "invalid_flow_name", Class: "user", Message: "Invalid flow name"}
	}
	return name, nil
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

// Show resolves system names without putting them in the overridable list.
func (h *FlowsHandler) Show(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Queries == nil {
		todoRouteError(w, &services.TodoControlError{Status: 503, Class: "infra", Code: "flows_unavailable", Message: "Flows unavailable"})
		return
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "flows.read"); err != nil {
		todoRouteError(w, err)
		return
	}
	cards, err := h.catalog(r)
	if err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 503, Class: "infra", Code: "flows_unavailable", Message: "Flows unavailable"})
		return
	}
	name, err := flowNameParam(r)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	var selected *services.FlowCard
	for i := range cards {
		if cards[i].Name == name {
			selected = &cards[i]
			break
		}
	}
	if selected == nil && !services.Overridable(name) {
		selected = &services.FlowCard{Name: name, System: true, Source: services.FlowSource{Builtin: true}, Versions: []services.FlowVersion{}}
	}
	if selected == nil {
		todoRouteError(w, &services.TodoControlError{Status: 404, Class: "user", Code: "flow_not_found", Message: "No flow " + name})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(selected)
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
