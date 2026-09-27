package routes

import (
	"encoding/json"
	"io"
	"net/http"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (h *RepositoryJobHandler) RetainRepositorySource(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := h.repositoryJobScope(w, r)
	if !ok {
		return
	}
	if h.SourceRetention == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Source retention is unavailable"))
		return
	}
	var input services.RepositorySourceRetentionInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid source retention request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Source retention requires one JSON object"))
		return
	}
	result, err := h.SourceRetention.Retain(r.Context(), repo, user, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
