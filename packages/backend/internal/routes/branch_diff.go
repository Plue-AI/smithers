package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BranchDiffReader authorizes the live caller from context before reading the
// branch's accepted prefix and tree. Nil remains the install's production gate;
// existing landing diff routes do not have accepted TODO identity or authority.
type BranchDiffReader interface {
	TODOBranchDiff(context.Context, string) (services.BranchDiff, error)
}
type BurstDiffReader interface {
	BurstBranchDiff(context.Context, string, int64, int64, string) (services.BranchDiff, error)
}
type BranchDiffHandler struct {
	Reader    BranchDiffReader
	Bursts    BurstDiffReader
	Authorize func(*http.Request, string) (int64, int64, error)
	Actor     func(context.Context, json.RawMessage) (json.RawMessage, error)
}

func (h *BranchDiffHandler) Diff(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Has("entry") {
		query := r.URL.Query()
		_, invalidEntry := uuid.Parse(query.Get("entry"))
		if len(query) != 1 || len(query["entry"]) != 1 || invalidEntry != nil {
			writeBranchError(w, r, pkgerrors.BadRequest("Unsupported diff selector"))
			return
		}
		if h.Authorize == nil || h.Bursts == nil || h.Actor == nil {
			writeBranchDiffUnavailable(w)
			return
		}
		repository, member, err := h.Authorize(r, "branch.read")
		if err != nil {
			writeBranchError(w, r, err)
			return
		}
		result, err := h.Bursts.BurstBranchDiff(r.Context(), chi.URLParam(r, "b"), repository, member, query.Get("entry"))
		if err != nil {
			writeBranchError(w, r, err)
			return
		}
		for i := range result.Files {
			actor, err := h.Actor(r.Context(), result.Files[i].Against.Actor)
			if err != nil {
				writeBranchError(w, r, err)
				return
			}
			result.Files[i].Against.Actor = actor
			result.Files[i].LastWriter = actor
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
		return
	}
	// This reader compares the item base only. Never silently substitute that
	// comparison for a selected activity burst or caller-supplied snapshots.
	if r.URL.RawQuery != "" {
		writeBranchError(w, r, pkgerrors.BadRequest("Unsupported diff selector"))
		return
	}
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
		writeBranchError(w, r, err)
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
