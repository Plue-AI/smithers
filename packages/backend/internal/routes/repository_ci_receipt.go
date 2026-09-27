package routes

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (h *RepositoryJobHandler) PutRepositoryCheckReceipt(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.RepositoryJobs == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository check receipts unavailable"))
		return
	}
	var input services.RepositoryCheckReceiptInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid repository check receipt"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("check receipt must contain one JSON object"))
		return
	}
	result, created, err := h.RepositoryJobs.CreateCheckReceipt(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), chi.URLParam(r, "requestID"), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	pkgerrors.WriteJSON(w, status, result)
}
