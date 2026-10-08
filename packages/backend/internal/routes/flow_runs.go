package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (h *FlowsHandler) Run(w http.ResponseWriter, r *http.Request) {
	var repo, user int64
	if services.InstallExecutionCredential(r.Context()) {
		var err error
		repo, err = services.InstallRepositoryID(r.Context(), h.Queries)
		if err != nil {
			todoRouteError(w, err)
			return
		}
		user = middleware.UserFromContext(r.Context()).ID
	} else {
		var ok bool
		repo, user, ok = authorizeInstallRepository(w, r, h.Queries, "flow.run")
		if !ok {
			return
		}
	}
	var input services.InstallFlowRunInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_flow_run", Class: "user", Message: "Invalid flow input"})
		return
	}
	name, err := flowNameParam(r)
	if err != nil {
		todoRouteError(w, err)
		return
	}
	if name != "" {
		if input.Name != "" && input.Name != name {
			todoRouteError(w, &services.TodoControlError{Status: 400, Code: "invalid_flow_run", Class: "user", Message: "Flow name does not match"})
			return
		}
		input.Name = name
	}
	receipt, err := h.Runs.Request(r.Context(), repo, user, input, r.Header.Get("Idempotency-Key"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(receipt)
}

func (h *FlowsHandler) RunStatus(w http.ResponseWriter, r *http.Request) {
	repo, user, ok := authorizeInstallRepository(w, r, h.Queries, "flows.read")
	if !ok {
		return
	}
	receipt, err := h.Runs.Status(r.Context(), repo, user, chi.URLParam(r, "id"))
	if err != nil {
		todoRouteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(receipt)
}
