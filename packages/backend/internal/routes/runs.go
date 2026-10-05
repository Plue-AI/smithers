package routes

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type BackgroundRunRouteService interface {
	List(context.Context, int64) ([]db.BackgroundRun, error)
	Status(context.Context, int64, string) (db.BackgroundRunStatus, error)
	Control(context.Context, int64, int64, string, string) (services.BackgroundRunReceipt, error)
}
type RunsHandler struct {
	Queries *db.Queries
	Service BackgroundRunRouteService
}

func (h *RunsHandler) List(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := authorizeInstallRepository(w, r, h.Queries, "runs.read")
	if !ok {
		return
	}
	if h.Service == nil {
		todoRouteError(w, nil)
		return
	}
	rows, err := h.Service.List(r.Context(), repo)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(rows)
}
func (h *RunsHandler) Control(w http.ResponseWriter, r *http.Request) {
	// Route admission is a member read; authorize the requested operation again.
	var input struct {
		Op string `json:"op"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil || (input.Op != "retry" && input.Op != "dismiss") {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_run_action", Class: "user", Message: "Invalid run action"})
		return
	}
	repo, user, ok := authorizeInstallRepository(w, r, h.Queries, "background."+input.Op)
	if !ok {
		return
	}
	if h.Service == nil {
		todoRouteError(w, nil)
		return
	}
	receipt, err := h.Service.Control(r.Context(), repo, user, chi.URLParam(r, "id"), input.Op)
	if err != nil {
		if api, ok := err.(*pkgerrors.APIError); ok {
			pkgerrors.WriteError(w, api)
			return
		}
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(receipt)
}

func (h *RunsHandler) Get(w http.ResponseWriter, r *http.Request) {
	repo, _, ok := authorizeInstallRepository(w, r, h.Queries, "runs.read")
	if !ok {
		return
	}
	if h.Service == nil {
		todoRouteError(w, nil)
		return
	}
	status, err := h.Service.Status(r.Context(), repo, chi.URLParam(r, "id"))
	if errors.Is(err, pgx.ErrNoRows) {
		todoRouteError(w, &services.TodoControlError{Status: 404, Code: "run_not_found", Class: "user", Message: "Run not found"})
		return
	}
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}
