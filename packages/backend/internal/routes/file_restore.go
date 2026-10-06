package routes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type BranchFileRestorer interface {
	RestoreBranchFile(context.Context, string, int64, int64, string, string, string, bool) (*services.WorkspaceFileWriteResult, error)
}

type FileRestoreHandler struct {
	Service   BranchFileRestorer
	Authorize func(*http.Request, string) (int64, int64, error)
}

func (h *FileRestoreHandler) Restore(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Action  string `json:"action"`
		Version string `json:"version"`
		Base    string `json:"base_digest"`
	}
	d := json.NewDecoder(io.LimitReader(r.Body, 8193))
	d.DisallowUnknownFields()
	if err := d.Decode(&input); err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid restore request"))
		return
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid restore request"))
		return
	}
	command := "file.restore"
	if input.Action == "restore-deleted" {
		command = "file.restore-deleted"
	} else if input.Action != "restore" {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid restore action"))
		return
	}
	if h.Authorize == nil {
		writeRouteError(w, r, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file restore unavailable"))
		return
	}
	repository, member, err := h.Authorize(r, command)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.Service == nil {
		writeRouteError(w, r, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file restore unavailable"))
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid branch"))
		return
	}
	filePath, err := url.PathUnescape(chi.URLParam(r, "*"))
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid file path"))
		return
	}
	result, err := h.Service.RestoreBranchFile(r.Context(), branch, repository, member, filePath, input.Version, input.Base, input.Action == "restore-deleted")
	if err != nil {
		var stale *workspaceapi.StaleFileError
		if errors.As(err, &stale) {
			err = pkgerrors.Conflict("file changed since this version")
		}
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(result)
}
