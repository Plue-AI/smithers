package routes

import (
	"context"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type WikiContentService interface {
	PutWikiAttachment(context.Context, *db.User, string, string, string, services.PutWikiAttachmentInput) (services.WikiPageResponse, error)
	GetWikiRevisionContent(context.Context, *db.User, string, string, int64, int64) (services.WikiContent, error)
	ListWikiEvents(context.Context, *db.User, string, string, int64) ([]services.WikiEvent, error)
	ListWikiPageHistory(context.Context, *db.User, string, string, int64, int, int) ([]services.WikiRevisionResponse, int64, error)
}
type WikiContentHandler struct{ Service WikiContentService }

func (h *WikiContentHandler) PutAttachment(w http.ResponseWriter, r *http.Request) {
	r, ok := wikiScopeRequest(w, r)
	if !ok {
		return
	}
	actor, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	owner, repo, slug, err := wikiAddress(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	revision, err := strconv.ParseInt(r.URL.Query().Get("expected_revision"), 10, 64)
	if err != nil || revision < 0 {
		writeRouteError(w, r, pkgerrors.BadRequest("expected_revision is required"))
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("attachment exceeds 16 MiB or could not be read"))
		return
	}
	result, err := h.Service.PutWikiAttachment(r.Context(), actor, owner, repo, slug, services.PutWikiAttachmentInput{Path: r.URL.Query().Get("path"), MediaType: r.Header.Get("Content-Type"), ExpectedRevision: revision, Data: data})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
func (h *WikiContentHandler) Content(w http.ResponseWriter, r *http.Request) {
	r, ok := wikiScopeRequest(w, r)
	if !ok {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pageID, err := strconv.ParseInt(chi.URLParam(r, "pageID"), 10, 64)
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid page ID"))
		return
	}
	revision, err := strconv.ParseInt(chi.URLParam(r, "revision"), 10, 64)
	if err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid revision"))
		return
	}
	result, err := h.Service.GetWikiRevisionContent(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, pageID, revision)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", result.MediaType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("ETag", `"`+result.Digest+`"`)
	disposition := "attachment"
	switch result.MediaType {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif":
		disposition = "inline"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": path.Base(result.Path)}))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Data)
}
func (h *WikiContentHandler) Events(w http.ResponseWriter, r *http.Request) {
	r, ok := wikiScopeRequest(w, r)
	if !ok {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	var after int64
	if raw := r.URL.Query().Get("after"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeRouteError(w, r, pkgerrors.BadRequest("invalid event cursor"))
			return
		}
	}
	result, err := h.Service.ListWikiEvents(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, after)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
func (h *WikiContentHandler) History(w http.ResponseWriter, r *http.Request) {
	r, ok := wikiScopeRequest(w, r)
	if !ok {
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pageID, err := strconv.ParseInt(chi.URLParam(r, "pageID"), 10, 64)
	if err != nil || pageID <= 0 {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid page ID"))
		return
	}
	cursor, limit, err := parsePagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, total, err := h.Service.ListWikiPageHistory(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, pageID, cursorToPage(cursor, limit), limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	setPaginationHeaders(w, r, cursor, limit, len(result), total)
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}
