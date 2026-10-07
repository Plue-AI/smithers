package routes

import (
	"context"
	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
)

type LearningEvidenceReader interface {
	ReadLearningEvidence(context.Context, string, string, string) (services.LearningEvidence, error)
}
type LearningEvidenceHandler struct{ Service LearningEvidenceReader }

func (h *LearningEvidenceHandler) Read(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Learning unavailable"))
		return
	}
	result, err := h.Service.ReadLearningEvidence(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), chi.URLParam(r, "runID"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
