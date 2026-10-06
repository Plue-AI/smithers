package routes

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BranchFileHandler reads only through the existing Source-ready mirror reader.
// It has no launcher or working-copy transport.
type BranchFileHandler struct {
	Source   services.InstallSource
	Branches BranchReadService
}

func (h *BranchFileHandler) Read(w http.ResponseWriter, r *http.Request) {
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil {
		writeRouteError(w, r, pkgerrors.Unauthorized("authentication required"))
		return
	}
	filePath, err := url.PathUnescape(chi.URLParam(r, "*"))
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid file path"))
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid branch"))
		return
	}
	if err := services.ValidateRepositoryPath(filePath); err != nil {
		writeRouteError(w, r, err)
		return
	}
	if strings.ContainsAny(filePath, "\\%") {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid file path"))
		return
	}
	content, commit, err := h.Source.ReadBranchFile(r.Context(), middleware.CredentialOf(info), info.User.ID, branch, filePath, r.URL.Query().Get("at"), h.Branches)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrSourceNotReady):
			err = pkgerrors.New(pkgerrors.CodeServiceUnavailable, "source unavailable")
		case errors.Is(err, services.ErrSourceForbidden):
			err = pkgerrors.Forbidden("repository read authority required")
		case errors.Is(err, services.ErrSourcePathRefused):
			err = pkgerrors.BadRequest("invalid file path")
		}
		writeRouteError(w, r, err)
		return
	}
	if content.TooLarge {
		writeRouteError(w, r, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "file exceeds read limit"))
		return
	}
	bytes := []byte(content.Content)
	if content.Encoding == "base64" {
		bytes, err = base64.StdEncoding.DecodeString(content.Content)
		if err != nil {
			writeRouteError(w, r, pkgerrors.Internal("invalid file encoding"))
			return
		}
	}
	w.Header().Set("X-Contents-Commit", commit)
	projection := map[string]any{"kind": "text", "text": content.Content}
	if content.Encoding == "base64" || !utf8.Valid(bytes) || strings.ContainsRune(content.Content, '\x00') {
		projection = map[string]any{"kind": "binary", "bytes": len(bytes)}
	} else if len(bytes) > 1048576 {
		projection = map[string]any{"kind": "too_large", "text": content.Content, "bytes": len(bytes)}
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"path": filePath, "branch": branch, "language": "", "digest": fmt.Sprintf("sha256:%x", sha256.Sum256(bytes)),
		"content": projection, "mode": "read_only", "diagnostics": []any{}, "authors": []any{}, "editors": []any{},
	})
}

type BranchFileReadService interface {
	ListBranchFiles(context.Context, string, int64, int64, string) ([]services.WorkspaceFileEntry, error)
}

func (h *BranchHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	repository, user, err := h.authorize(r, "branch.read", h.Files != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("invalid branch name"))
		return
	}
	entries, err := h.Files.ListBranchFiles(r.Context(), branch, repository, user, r.URL.Query().Get("path"))
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, entries)
}
