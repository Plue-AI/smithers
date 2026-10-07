package routes

import (
	"context"
	"encoding/json"
	"net/http"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type BranchTerminalService interface {
	BranchTerminalAvailable() bool
	OpenBranchTerminal(context.Context, string, int64, int64, string) (services.WorkspaceSessionResponse, error)
}

func (h *WorkspaceTerminalHandler) OpenTerminal(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.Service.(BranchTerminalService)
	if !ok || h.AuthorizeTerminal == nil || !svc.BranchTerminalAvailable() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "terminal_unavailable", "class": "infra", "message": "Terminal is unavailable"})
		return
	}
	repository, member, err := h.AuthorizeTerminal(r, "branch.join")
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	var body struct {
		Branch string `json:"branch"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err = decodeSingleJSONDocument(decoder, &body); err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("Invalid terminal"))
		return
	}
	session, err := svc.OpenBranchTerminal(r.Context(), body.Branch, repository, member, r.Header.Get("Idempotency-Key"))
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, session)
}
