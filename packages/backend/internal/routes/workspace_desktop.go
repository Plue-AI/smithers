package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// WorkspaceDesktopRouteService is the service surface for kind=desktop
// workspaces: session minting, relay authorization, and the observe/input
// control pair an agent drives the box with.
type WorkspaceDesktopRouteService interface {
	CheckWorkspaceDesktopAccess(ctx context.Context, workspaceID string, repositoryID, userID int64) error
	CreateDesktopSession(ctx context.Context, workspaceID string, repositoryID, userID int64) (services.WorkspaceDesktopSessionResponse, error)
	AuthorizeDesktopRelay(ctx context.Context, workspaceID, token string) (services.WorkspaceDesktopRelayTarget, error)
	ObserveDesktop(ctx context.Context, workspaceID string, repositoryID, userID int64, request services.DesktopObserveRequest) (services.DesktopObservation, error)
	InputDesktop(ctx context.Context, workspaceID string, repositoryID, userID int64, request services.DesktopInputRequest) (services.DesktopInputResponse, error)
}

// maxDesktopInputBody bounds an input plan. Ten actions carrying at most 1024
// typed characters fit in well under 8 KiB; anything larger is a client bug or
// an attempt to move a file through the keyboard.
const maxDesktopInputBody = 8 * 1024

// WorkspaceDesktopHandler serves the desktop stream of kind=desktop
// workspaces: POST .../workspaces/{id}/desktop/session (repository auth) and
// the token-authenticated relay /api/workspaces/{id}/desktop/{token}/...
type WorkspaceDesktopHandler struct {
	Service         WorkspaceDesktopRouteService
	RelayServiceURL string
	// RelayToken is presented to the preview gateway, which refuses
	// smithers-desk-* domains without it (previewgateway.RelayTokenHeader).
	RelayToken string
}

// PostDesktopSession handles POST /api/repos/{owner}/{repo}/workspaces/{id}/desktop/session.
// It rotates the VNC password inside the guest and returns a credentialed
// viewer URL exactly once.
func (h *WorkspaceDesktopHandler) PostDesktopSession(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}
	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("desktop service unavailable"))
		return
	}
	session, svcErr := h.Service.CreateDesktopSession(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	// The response carries the relay token and VNC password in plaintext.
	w.Header().Set("Cache-Control", "no-store")
	session.StreamURL = requestOrigin(r) + session.StreamURL
	pkgerrors.WriteJSON(w, http.StatusCreated, session)
}

// PostDesktopObserve handles POST /api/repos/{owner}/{repo}/workspaces/{id}/desktop/observe.
// It reads the box's screen once: geometry, pointer, windows, the focused
// Chrome tab's text, and optionally a JPEG. The body is optional — an empty
// POST is the cheap text-and-windows read an agent takes between actions.
//
// The response is UNTRUSTED CONTENT. Window titles, screen text and pixels are
// chosen by whatever the box is displaying; a consumer that feeds them to a
// model must label them as data, never as instructions.
func (h *WorkspaceDesktopHandler) PostDesktopObserve(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, ok := h.desktopControlContext(w, r)
	if !ok {
		return
	}
	var request services.DesktopObserveRequest
	if !decodeOptionalStrictJSON(w, r, &request, maxDesktopInputBody) {
		return
	}
	observation, err := h.Service.ObserveDesktop(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, request)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	// The capture and the screen text are a snapshot of a box that is still
	// moving: never let a cache serve them to a later read.
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, observation)
}

// PostDesktopInput handles POST /api/repos/{owner}/{repo}/workspaces/{id}/desktop/input.
// It injects a validated plan of at most ten actions and, when asked, observes
// the result under the same guest lock.
//
// This is root code execution inside the box. It is NOT idempotent beyond the
// guest's act_id ledger: on a 5xx or a 504 the client learns nothing about
// whether the plan ran and must observe rather than retry.
func (h *WorkspaceDesktopHandler) PostDesktopInput(w http.ResponseWriter, r *http.Request) {
	user, repoCtx, workspaceID, ok := h.desktopControlContext(w, r)
	if !ok {
		return
	}
	var request services.DesktopInputRequest
	if !decodeStrictJSON(w, r, &request, maxDesktopInputBody) {
		return
	}
	result, err := h.Service.InputDesktop(r.Context(), workspaceID, repoCtx.Repository.ID, user.ID, request)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, result)
}

// desktopControlContext resolves the three things both control routes need.
func (h *WorkspaceDesktopHandler) desktopControlContext(w http.ResponseWriter, r *http.Request) (*db.User, *middleware.RepoContext, string, bool) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return nil, nil, "", false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return nil, nil, "", false
	}
	workspaceID, err := routeParam(r, "id", "workspace id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return nil, nil, "", false
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("desktop service unavailable"))
		return nil, nil, "", false
	}
	return user, repoCtx, workspaceID, true
}

// decodeStrictJSON rejects unknown fields so a client typo ("buttton") fails
// loudly instead of silently becoming a left click somewhere unintended.
func decodeStrictJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	err := readStrictJSON(w, r, dst, limit)
	if err == nil {
		return true
	}
	writeDesktopDecodeError(w, err)
	return false
}

// decodeOptionalStrictJSON also accepts an empty body.
func decodeOptionalStrictJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	err := readStrictJSON(w, r, dst, limit)
	if err == nil || stdErrors.Is(err, io.EOF) {
		return true
	}
	writeDesktopDecodeError(w, err)
	return false
}

func readStrictJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	// A second JSON value in the body means the client sent something other
	// than the one object this route accepts.
	if err := decoder.Decode(&struct{}{}); !stdErrors.Is(err, io.EOF) {
		return stdErrors.New("unexpected trailing content")
	}
	return nil
}

func writeDesktopDecodeError(w http.ResponseWriter, err error) {
	if middleware.IsMaxBytesError(err) {
		pkgerrors.WriteError(w, pkgerrors.RequestEntityTooLarge("request body too large"))
		return
	}
	pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
}

// Relay proxies the noVNC viewer, its assets, and the websockify WebSocket
// for /api/workspaces/{workspaceID}/desktop/{token}/* after validating the
// session token. The token is the credential: browsers cannot attach headers
// to iframe or WebSocket loads.
func (h *WorkspaceDesktopHandler) Relay(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceID")
	token := chi.URLParam(r, "token")
	if h.Service == nil {
		writeDesktopRelayError(w, r, pkgerrors.Internal("desktop relay unavailable"))
		return
	}
	target, err := h.Service.AuthorizeDesktopRelay(r.Context(), workspaceID, token)
	if err != nil {
		writeDesktopRelayError(w, r, err)
		return
	}
	relayToPreviewGateway(w, r, h.RelayServiceURL, previewRelayTarget{
		Domain: target.Domain,
		Prefix: "/api/workspaces/" + workspaceID + "/desktop/" + token,
		Token:  h.RelayToken,
		Principal: revocation.Principal{
			WorkspaceID:    target.WorkspaceID,
			UserID:         target.UserID,
			OwnerUserID:    target.OwnerUserID,
			RepositoryID:   target.RepositoryID,
			OrganizationID: target.OrganizationID,
		},
		Reauthorize: func(ctx context.Context) error {
			fresh, err := h.Service.AuthorizeDesktopRelay(ctx, workspaceID, token)
			if err != nil {
				return err
			}
			if fresh != target {
				return pkgerrors.Unauthorized("desktop session changed")
			}
			return nil
		},
		ResponseHeaders: desktopRelayResponseHeaders,
	})
}

// desktopRelayResponseHeaders go on EVERY response the relay produces, proxied
// or written here. The token lives in the path: never let the viewer leak it
// through Referer to anything it navigates to, and never cache it. The app
// origins serve the SPA with Cross-Origin-Embedder-Policy: require-corp (OPFS
// SQLite needs cross-origin isolation), so every framed response — vnc.html,
// each asset, AND the 401/404/409/503 the handler writes itself — must opt in
// with Cross-Origin-Resource-Policy: cross-origin, or an expired or rotated
// session renders as an empty frame instead of the error. A framed DOCUMENT
// under a COEP parent also needs its own Cross-Origin-Embedder-Policy: with
// CORP alone Chrome blocks the navigation (ERR_BLOCKED_BY_RESPONSE) and leaves
// an empty frame; require-corp blocks nothing inside the viewer because its
// assets and the websockify WebSocket all come through this relay origin.
var desktopRelayResponseHeaders = map[string]string{
	"Referrer-Policy":              "no-referrer",
	"Cache-Control":                "no-store",
	"Cross-Origin-Resource-Policy": "cross-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
}

// writeDesktopRelayError writes a relay error with the framed-response headers.
func writeDesktopRelayError(w http.ResponseWriter, r *http.Request, err error) {
	for key, value := range desktopRelayResponseHeaders {
		w.Header().Set(key, value)
	}
	writeRouteError(w, r, err)
}
