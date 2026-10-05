package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mythicalLearningReader interface {
	LearningSnapshot(context.Context, int64, int64, string) (services.LearningSnapshot, error)
}

// Learning supplies data only to the stored learning machine/run. The service
// verifies its workspace credential; this route never starts or writes a run.
func (h *MythicalHandler) Learning(w http.ResponseWriter, r *http.Request) {
	repo, ok := h.repository(w, r)
	if !ok {
		return
	}
	reader, ok := h.Service.(mythicalLearningReader)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Learning is unavailable"))
		return
	}
	todo, err := strconv.ParseInt(chi.URLParam(r, "todo"), 10, 64)
	values := r.URL.Query()["run"]
	if err != nil || todo <= 0 || len(values) != 1 || values[0] == "" || len(values[0]) > 512 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid learning read"))
		return
	}
	snapshot, err := reader.LearningSnapshot(r.Context(), repo.Repository.ID, todo, values[0])
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, snapshot)
}
