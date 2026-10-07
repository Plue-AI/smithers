package routes

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type BranchFileContentService interface {
	ReadBranchFile(context.Context, string, int64, int64, string, string) (services.WorkspaceFileContent, error)
	CompareBranchFile(context.Context, string, int64, int64, string, string) (services.WorkspaceFileContent, error)
	BranchFileFact(context.Context, string, int64, int64, string) (*services.BranchFileFact, error)
}

// BranchFileHandler selects immutable mirror bytes or the existing confined reader.
type BranchFileHandler struct {
	Source    services.InstallSource
	Branches  BranchReadService
	Live      BranchFileContentService
	Authorize func(*http.Request, string) (int64, int64, error)
	Actor     func(context.Context, json.RawMessage) (json.RawMessage, error)
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
	// Selectors are handled only by their authoritative provider. Never
	// silently drop a digest and answer unrelated mirror bytes.
	query := r.URL.Query()

	if query.Has("compare") && h.Live != nil && h.Authorize != nil {
		if query.Has("digest") {
			writeRouteError(w, r, pkgerrors.BadRequest("conflicting file selectors"))
			return
		}
		repository, member, err := h.Authorize(r, "branch.read")
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		content, err := h.Live.CompareBranchFile(r.Context(), branch, repository, member, filePath, query.Get("compare"))
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		if content.Encoding == "base64" {
			writeRouteError(w, r, pkgerrors.BadRequest("binary file cannot be compared"))
			return
		}
		pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"text": content.Content})
		return
	}
	if branch != "main" && query.Get("at") == "" && !query.Has("compare") && h.Live != nil && h.Authorize != nil {
		repository, member, authErr := h.Authorize(r, "branch.read")
		if authErr != nil {
			writeRouteError(w, r, authErr)
			return
		}

		fact, err := h.Live.BranchFileFact(r.Context(), branch, repository, member, filePath)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		content, readErr := h.Live.ReadBranchFile(r.Context(), branch, repository, member, filePath, query.Get("digest"))
		var apiErr *pkgerrors.APIError
		gone := fact != nil && (fact.Change == "deleted" || fact.Change == "renamed") && errors.As(readErr, &apiErr) && apiErr.Status == 404
		if readErr != nil && !gone {
			writeRouteError(w, r, readErr)
			return
		}
		projection := map[string]any{"kind": "text", "text": content.Content}
		if content.Encoding == "base64" {
			projection = map[string]any{"kind": "binary", "bytes": content.Size}
		}
		model := map[string]any{"path": filePath, "branch": branch, "language": "", "digest": content.Digest, "content": projection, "mode": "read_only", "diagnostics": []any{}, "authors": []any{}, "editors": []any{}}
		if gone {
			model["digest"] = "absent"
		}
		if fact != nil && (gone || content.Digest == fact.Digest) && h.Actor != nil && string(fact.Actor) != "null" {
			actor, err := h.Actor(r.Context(), fact.Actor)
			if err != nil {
				writeRouteError(w, r, err)
				return
			}
			model["last_writer"] = actor
			if gone {
				state := map[string]any{"kind": "deleted", "by": actor}
				if fact.Change == "renamed" {
					state["kind"] = "renamed"
					state["to"] = fact.RenamedTo
				}
				model["gone"] = state
			}
			if fact.Version != "" {
				model["outside"] = map[string]any{"version": fact.Version, "post_digest": fact.Digest, "at": fact.At.Format(time.RFC3339Nano)}
			}
		}
		pkgerrors.WriteJSON(w, http.StatusOK, model)
		return
	}
	if query.Has("digest") || query.Has("compare") {
		writeRouteError(w, r, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "live file provider unavailable"))
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
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil {
		writeBranchError(w, r, pkgerrors.BadRequest("invalid branch name"))
		return
	}
	mirroredMain := branch == "main" && h.Source != nil
	repository, user, err := h.authorize(r, "branch.read", mirroredMain || h.Files != nil)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	if mirroredMain {
		if r.URL.Query().Has("at") {
			writeBranchError(w, r, pkgerrors.BadRequest("directory revision selector unavailable"))
			return
		}
		info := middleware.AuthInfoFromContext(r.Context())
		if info == nil || info.User == nil {
			writeBranchError(w, r, pkgerrors.Unauthorized("authentication required"))
			return
		}
		path := r.URL.Query().Get("path")
		directory, readErr := h.Source.ListSource(r.Context(), middleware.CredentialOf(info), user, repository, path)
		if readErr != nil {
			switch {
			case errors.Is(readErr, services.ErrSourceNotReady):
				readErr = pkgerrors.New(pkgerrors.CodeServiceUnavailable, "source unavailable")
			case errors.Is(readErr, services.ErrSourceForbidden):
				readErr = pkgerrors.Forbidden("repository read authority required")
			case errors.Is(readErr, services.ErrSourcePathRefused):
				readErr = pkgerrors.BadRequest("invalid directory path")
			case errors.Is(readErr, services.ErrSourceNotFound):
				readErr = pkgerrors.NotFound("directory not found")
			}
			writeBranchError(w, r, readErr)
			return
		}
		if directory.Truncated {
			writeBranchError(w, r, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "directory exceeds source read limit"))
			return
		}
		entries := make([]services.WorkspaceFileEntry, 0, len(directory.Entries))
		for _, entry := range directory.Entries {
			filePath := entry.Name
			if path != "" {
				filePath = strings.TrimSuffix(path, "/") + "/" + entry.Name
			}
			entries = append(entries, services.WorkspaceFileEntry{Name: entry.Name, Path: filePath, Type: entry.Kind})
		}
		w.Header().Set("X-Contents-Commit", directory.Commit)
		pkgerrors.WriteJSON(w, http.StatusOK, entries)
		return
	}
	entries, err := h.Files.ListBranchFiles(r.Context(), branch, repository, user, r.URL.Query().Get("path"))
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, entries)
}
