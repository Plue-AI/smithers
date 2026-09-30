package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type WikiCollaborationService interface {
	GetWikiDocument(context.Context, *db.User, string, string, string) (services.WikiDocumentResponse, error)
	ApplyWikiUpdate(context.Context, *db.User, string, string, string, services.WikiUpdateInput) (services.WikiUpdateResponse, error)
	ListWikiUpdates(context.Context, *db.User, string, string, string, int64, int64) ([]services.WikiUpdateEvent, error)
}

type WikiCollaborationHandler struct {
	Service WikiCollaborationService
	Broker  *sse.Broker
}

func wikiAddress(r *http.Request) (string, string, string, error) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		return "", "", "", err
	}
	slug, err := routeParam(r, "slug", "wiki slug is required")
	return owner, repo, slug, err
}

func (h *WikiCollaborationHandler) Document(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, slug, err := wikiAddress(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	doc, err := h.Service.GetWikiDocument(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, slug)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, doc)
}

func (h *WikiCollaborationHandler) Apply(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
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
	// A 1 MiB binary update becomes at most 1.4 MiB JSON after base64.
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	var input services.WikiUpdateInput
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSONDecodeError(w, "invalid wiki update", err)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeRouteError(w, r, pkgerrors.BadRequest("one wiki update is required"))
		return
	}
	result, err := h.Service.ApplyWikiUpdate(r.Context(), actor, owner, repo, slug, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

func wikiCursor(r *http.Request) (int64, int64, error) {
	page, err := strconv.ParseInt(r.URL.Query().Get("page_id"), 10, 64)
	if err != nil || page <= 0 {
		return 0, 0, pkgerrors.BadRequest("positive page_id is required")
	}
	raw := strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	if raw == "" {
		raw = r.URL.Query().Get("after")
	}
	if raw == "" {
		return page, 0, nil
	}
	after, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || after < 0 {
		return 0, 0, pkgerrors.BadRequest("invalid wiki revision cursor")
	}
	return page, after, nil
}

func (h *WikiCollaborationHandler) Updates(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, slug, err := wikiAddress(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page, after, err := wikiCursor(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	events, err := h.Service.ListWikiUpdates(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, slug, page, after)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, events)
}

// wikiSubscribeError names the failure behind a refused wiki subscription.
// The per-user live-stream cap is a budget the caller blew, not a component
// that is down, so it carries the budget code rather than inheriting one from
// its 429.
func wikiSubscribeError(err error) *pkgerrors.APIError {
	var capped *sse.ErrTooManyStreams
	if errors.As(err, &capped) {
		return pkgerrors.New(pkgerrors.CodeRateLimitExceeded, "too many SSE streams")
	}
	return pkgerrors.Internal("wiki subscription unavailable")
}

// Stream serves a wiki page's committed updates as SSE. It subscribes before
// replay; notifications are only wakeups. Every emitted event is read from the
// committed per-page revision stream, so reconnect/replay cannot skip an
// in-flight transaction or regress its cursor with a buffered duplicate.
func (h *WikiCollaborationHandler) Stream(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
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
	page, after, err := wikiCursor(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	repository := middleware.RepoFromContext(r.Context())
	// Watch before authorization and broker admission. The child context also
	// releases the watcher when admission fails before streaming starts.
	watchCtx, stopWatching := context.WithCancel(r.Context())
	defer stopWatching()
	principal := requestPrincipal(r, revocation.Principal{UserID: actor.ID})
	if repository != nil {
		principal.RepositoryID = repository.ID
	}
	var revoked <-chan revocation.Event
	if source := currentRevocationSource(); source != nil {
		revoked = source.Watch(watchCtx, principal)
	}
	refuseRevoked := func() bool {
		select {
		case <-revoked:
			writeRouteError(w, r, pkgerrors.Forbidden("stream authorization revoked"))
			return true
		default:
			return false
		}
	}
	if refuseRevoked() {
		return
	}
	// The same read authorizes the caller and proves the resume cursor: its
	// revision must still exist, or events after it may have been lost.
	probe := after
	if probe > 0 {
		probe--
	}
	known, err := h.Service.ListWikiUpdates(r.Context(), actor, owner, repo, slug, page, probe)
	if refuseRevoked() {
		return
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if after > 0 && (len(known) == 0 || known[0].Revision != after) {
		writeRouteError(w, r, pkgerrors.UnknownCursor("wiki revision cursor is not a revision of this page"))
		return
	}
	if repository == nil || h.Broker == nil {
		writeRouteError(w, r, pkgerrors.Internal("wiki streaming unavailable"))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeRouteError(w, r, pkgerrors.Internal("streaming unsupported"))
		return
	}
	sub, err := h.Broker.Subscribe(r.Context(), fmt.Sprintf("wiki_page_%d", page), actor.ID)
	if err != nil {
		writeRouteError(w, r, wikiSubscribeError(err))
		return
	}
	defer h.Broker.Unsubscribe(sub)
	if refuseRevoked() {
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	emit := func(event sse.Event) bool {
		_, err := fmt.Fprint(w, sse.FormatEvent(event))
		flusher.Flush()
		return err == nil
	}
	drain := func() bool {
		for {
			rows, err := h.Service.ListWikiUpdates(r.Context(), actor, owner, repo, slug, page, after)
			if err != nil {
				middleware.LoggerFromContext(r.Context()).Error("wiki update replay failed",
					"page_id", page, "after", after, "error", err)
				emit(sse.Event{Type: "error", Data: `{"message":"wiki replay unavailable; reconnect"}`})
				return false
			}
			for _, row := range rows {
				select {
				case ev := <-revoked:
					data, _ := json.Marshal(ev)
					emit(sse.Event{Type: "revoked", Data: string(data)})
					return false
				default:
				}
				data, _ := json.Marshal(row)
				if !emit(sse.Event{ID: strconv.FormatInt(row.Revision, 10), Type: "wiki.update", Data: string(data)}) {
					return false
				}
				after = row.Revision
				if row.Deleted {
					return false
				}
			}
			if len(rows) < services.WikiUpdatePageSize {
				return true
			}
		}
	}
	if !drain() {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case ev := <-revoked:
			data, _ := json.Marshal(ev)
			emit(sse.Event{Type: "revoked", Data: string(data)})
			return
		case _, ok := <-sub.Events():
			if !ok || !drain() {
				return
			}
		case <-ticker.C:
			if !drain() {
				return
			}
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
