package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BranchDiffReader authorizes the live caller from context before reading the
// branch's accepted prefix and tree. Nil remains the install's production gate;
// existing landing diff routes do not have accepted TODO identity or authority.
type BranchDiffReader interface {
	TODOBranchDiff(context.Context, string) (services.BranchDiff, error)
}
type BranchDiffHandler struct{ Reader BranchDiffReader }

func (h *BranchDiffHandler) Diff(w http.ResponseWriter, r *http.Request) {
	if h.Reader == nil {
		writeBranchDiffUnavailable(w)
		return
	}
	result, err := h.Reader.TODOBranchDiff(r.Context(), chi.URLParam(r, "b"))
	if err != nil {
		// Publication and diff share the accepted-facts dependency gate.
		var unavailable *services.TODOPrUnavailable
		if errors.As(err, &unavailable) {
			writeBranchDiffUnavailable(w)
			return
		}
		writeRouteError(w, r, err)
		return
	}
	if result.Files == nil {
		result.Files = []services.BranchDiffModel{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
func writeBranchDiffUnavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(&services.TODOPrUnavailable{})
}
