package routes

import (
	"encoding/json"
	"errors"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type HomeBackgroundHandler struct {
	Queries *db.Queries
	Service *services.HomeBackground
}

func (h *HomeBackgroundHandler) Control(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Op string `json:"op"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decodeSingleJSONDocument(decoder, &input) != nil || (input.Op != "retry" && input.Op != "dismiss") {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_run_action", Class: "user", Message: "Invalid run action"})
		return
	}
	repo, user, ok := authorizeInstallRepository(w, r, h.Queries, "background."+input.Op)
	if !ok {
		return
	}
	raw := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != raw {
		todoRouteError(w, &services.TodoControlError{Status: 404, Code: "run_not_found", Class: "user", Message: "Run unavailable"})
		return
	}
	receipt, err := h.Service.Control(r.Context(), repo, user, id, input.Op, r.Header.Get("Idempotency-Key"))
	if err != nil {
		homeBackgroundError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if input.Op == "retry" {
		w.WriteHeader(http.StatusAccepted)
	}
	_ = json.NewEncoder(w).Encode(receipt)
}

func (h *HomeBackgroundHandler) Status(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := authorizeInstallRepository(w, r, h.Queries, "flows.read")
	if !ok {
		return
	}
	raw := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != raw {
		todoRouteError(w, &services.TodoControlError{Status: 404, Code: "run_not_found", Class: "user", Message: "Run unavailable"})
		return
	}
	receipt, err := h.Service.Status(r.Context(), repo, id)
	if err != nil {
		homeBackgroundError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(receipt)
}

func homeBackgroundError(w http.ResponseWriter, err error) {
	var typed *services.TodoControlError
	if errors.As(err, &typed) {
		todoRouteError(w, typed)
		return
	}
	var api *pkgerrors.APIError
	if errors.As(err, &api) {
		pkgerrors.WriteError(w, api)
		return
	}
	todoRouteError(w, &services.TodoControlError{Status: 503, Code: "background_unavailable", Class: "infra", Message: "Background runs unavailable"})
}
