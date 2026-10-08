package routes

import (
	"context"
	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/url"
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
	runID := chi.URLParam(r, "runID")
	// Chi matches RawPath when present. Decode that spelling once; URL.Path
	// already contains decoded percent characters when RawPath is empty.
	if r.URL.RawPath != "" {
		decoded, err := url.PathUnescape(runID)
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid run"))
			return
		}
		runID = decoded
	}
	result, err := h.Service.ReadLearningEvidence(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), runID)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
