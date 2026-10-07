package routes

import (
	"bytes"
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

type FileRestoreInput struct {
	Action  string `json:"action"`
	Version string `json:"version"`
	Base    string `json:"base_digest"`
}

// DecodeFileRestore resolves the concrete command before admission. Both the
// install dispatcher and direct handler use this strict payload contract.
func DecodeFileRestore(body io.Reader) (FileRestoreInput, string, error) {
	var input FileRestoreInput
	d := json.NewDecoder(body)
	d.DisallowUnknownFields()
	if err := d.Decode(&input); err != nil {
		return input, "", pkgerrors.BadRequest("invalid restore request")
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		return input, "", pkgerrors.BadRequest("invalid restore request")
	}
	switch input.Action {
	case "restore":
		return input, "file.restore", nil
	case "restore-deleted":
		return input, "file.restore-deleted", nil
	default:
		return input, "", pkgerrors.BadRequest("invalid restore action")
	}
}

func (h *FileRestoreHandler) Restore(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid restore request"))
		return
	}
	input, command, err := DecodeFileRestore(bytes.NewReader(raw))
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil {
		writeRouteError(w, r, err)
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
