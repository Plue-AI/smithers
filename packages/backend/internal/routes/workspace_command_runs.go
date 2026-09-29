package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type workspaceCommandRouteService interface {
	AdmitWorkspaceCommand(context.Context, string, int64, int64, services.WorkspaceCommandInput) (jobs.RequestReceipt, error)
	GetWorkspaceCommandRun(context.Context, string, int64, int64, string) (services.WorkspaceCommandRun, error)
	CancelWorkspaceCommandRun(context.Context, string, int64, int64, string) (services.WorkspaceCommandRun, error)
}

func (h *WorkspaceHandler) AdmitWorkspaceCommand(w http.ResponseWriter, r *http.Request) {
	user, repo, workspaceID, routeErr := workspaceFacetRouteContext(r)
	if routeErr != nil {
		pkgerrors.WriteError(w, routeErr)
		return
	}
	service, ok := h.Service.(workspaceCommandRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace execution unavailable"))
		return
	}
	var input services.WorkspaceCommandInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return
	}
	receipt, err := service.AdmitWorkspaceCommand(r.Context(), workspaceID, repo.Repository.ID, user.ID, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, receipt)
}

func (h *WorkspaceHandler) GetWorkspaceCommandRun(w http.ResponseWriter, r *http.Request) {
	h.workspaceCommandRun(w, r, false)
}
func (h *WorkspaceHandler) CancelWorkspaceCommandRun(w http.ResponseWriter, r *http.Request) {
	h.workspaceCommandRun(w, r, true)
}
func (h *WorkspaceHandler) workspaceCommandRun(w http.ResponseWriter, r *http.Request, cancel bool) {
	user, repo, workspaceID, routeErr := workspaceFacetRouteContext(r)
	if routeErr != nil {
		pkgerrors.WriteError(w, routeErr)
		return
	}
	service, ok := h.Service.(workspaceCommandRouteService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace execution unavailable"))
		return
	}
	operationID := chi.URLParam(r, "operationID")
	var receipt services.WorkspaceCommandRun
	var err error
	if cancel {
		receipt, err = service.CancelWorkspaceCommandRun(r.Context(), workspaceID, repo.Repository.ID, user.ID, operationID)
	} else {
		receipt, err = service.GetWorkspaceCommandRun(r.Context(), workspaceID, repo.Repository.ID, user.ID, operationID)
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	status := http.StatusOK
	if cancel && !receipt.State.Terminal() {
		status = http.StatusAccepted
	}
	pkgerrors.WriteJSON(w, status, receipt)
}
