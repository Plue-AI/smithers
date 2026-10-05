package routes

import (
	"encoding/json"
	"net/http"

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
// system flow.
func (h *FlowsHandler) List(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Queries == nil {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "flows_unavailable", Class: "infra", Message: "Flows unavailable"})
		return
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "flows.read"); err != nil {
		todoRouteError(w, err)
		return
	}
	cards, err := services.FlowCatalog()
	if err != nil {
		todoRouteError(w, &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "flows_unavailable", Class: "infra", Message: "Flows unavailable"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(cards)
}
