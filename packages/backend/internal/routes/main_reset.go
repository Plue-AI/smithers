package routes

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type MainResetRouteService interface {
	ResetMainAttention(context.Context, int64, string, string, string) error
}

type MainResetHandler struct {
	Queries *db.Queries
	Service MainResetRouteService
}

// Reset is the main.reset-to-github catalog door. Authorization precedes
// decoding and provider access, so delegated callers cannot ask for confirmation.
func (h *MainResetHandler) Reset(w http.ResponseWriter, r *http.Request) {
	if _, err := services.Authorize(r.Context(), h.Queries, "main.reset-to-github"); err != nil {
		writeRouteError(w, r, err)
		return
	}
	if err := services.MergeCredential(r.Context(), r.Header.Get("Smithers-Via")); err != nil {
		todoRouteError(w, err)
		return
	}
	var input struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if input.Old == "" || input.New == "" || input.Old == input.New {
		todoRouteError(w, &services.TodoControlError{Status: 409, Class: "conflict", Code: "stale_attention", Message: "Main changed"})
		return
	}
	repository, err := services.InstallRepositoryID(r.Context(), h.Queries)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	sync := &GitHubSyncHandler{}
	if h.Service == nil {
		sync.unavailable(w)
		return
	}
	if err := h.Service.ResetMainAttention(r.Context(), repository, chi.URLParam(r, "id"), input.Old, input.New); err != nil {
		sync.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		State string `json:"state"`
	}{"settled"})
}
