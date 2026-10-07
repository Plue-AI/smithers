package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// FlowsHandler serves the install's flow catalog (spec §6.3 GET /api/flows),
// the model the Flow card and the app agent's flow commands read. Any member's
// browser session reads it.
type FlowEditService interface {
	FileFlowEdit(context.Context, int64, int64, string, services.FlowEditInput, string) (services.MythicalItemView, error)
}

type FlowsHandler struct {
	Edits     FlowEditService
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
	name := chi.URLParam(r, "name")
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

func (h *FlowsHandler) Edit(w http.ResponseWriter, r *http.Request) {
	repository, user, ok := authorizeInstallRepository(w, r, h.Queries, "flow.edit")
	if !ok {
		return
	}
	if h.Edits == nil {
		todoRouteError(w, &services.TodoControlError{Status: 503, Class: "infra", Code: "confirmation_unavailable", Message: "Flow edit unavailable"})
		return
	}
	var input services.FlowEditInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_flow_edit", Message: "Invalid flow edit"})
		return
	}
	item, err := h.Edits.FileFlowEdit(r.Context(), repository, user, chi.URLParam(r, "name"), input, r.Header.Get("Idempotency-Key"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(item)
}
