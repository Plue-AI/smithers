package routes

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// BranchLanguageServers starts the File card's language server on a branch
// machine as a daemon exec session owned by the member who asked (spec
// §9.1.2). Nothing here wakes a sleeping branch (§8.4.4).
type BranchLanguageServers interface {
	Available() bool
	// Authorize resolves branch.join for the member and the branch machine.
	Authorize(ctx context.Context, branch string, member int64) (revocation.Principal, error)
	// Ready refuses a sleeping branch or an unadmitted daemon link.
	Ready(ctx context.Context, principal revocation.Principal) error
	// Open starts language as principal's member through the broker.
	Open(ctx context.Context, principal revocation.Principal, language string) (LSPProcess, error)
}

// lspGrantIdle forgets an unused code-intelligence session id.
const lspGrantIdle = time.Hour

// lspGrant binds one session id to its member, branch and language: the
// socket starts nothing for anyone else.
type lspGrant struct {
	id         string
	member     int64
	repository int64
	branch     string
	language   string
	used       time.Time
}

// BranchLSPHandler serves POST /api/branches/{b}/lsp, which admits one
// code-intelligence session per (member, branch, language), and its socket
// GET /api/branches/{b}/lsp/{id}, which relays JSON-RPC 2.0 to the language
// server with subprotocol `lsp`.
//
// Wire: one JSON-RPC message per text frame, 1 MiB per frame, larger
// messages as {seq,last,data} fragments; server pings every 30 s.
// Close codes: 1000 final (`language_server_exited: 0`, `language_server_idle`,
// `language_server_missing: <install line>`, client closed), 1001 reconnect
// (client too slow), 1008 revoked, 1011 retry once
// (`language_server_exited: <code>`), 1002/1003/1009 client protocol faults.
type BranchLSPHandler struct {
	Provider          BranchLanguageServers
	Authorize         func(*http.Request, string) (int64, int64, error)
	Metrics           *SmithersMetrics
	AllowedOrigins    []string
	SessionCookieName string
	ActiveConnections *middleware.ActiveCounter

	mu       sync.Mutex
	grants   map[string]*lspGrant
	sessions *LSPSessionManager
	now      func() time.Time

	beforeAttach func(*lspSession)
}

func (h *BranchLSPHandler) available() bool {
	return h != nil && h.Provider != nil && h.Authorize != nil && h.Provider.Available()
}

func lspUnavailable(w http.ResponseWriter) {
	pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "Code intelligence is unavailable"))
}

func (h *BranchLSPHandler) observe(result string) {
	if h.Metrics != nil {
		h.Metrics.ObserveWorkspaceLSPAttach(result)
	}
}

func (h *BranchLSPHandler) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

func (h *BranchLSPHandler) manager() *LSPSessionManager {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions == nil {
		h.sessions = NewLSPSessionManager()
		if source := currentRevocationSource(); source != nil {
			source.Subscribe(h.sessions.RevokeMatching)
		}
	}
	return h.sessions
}

// Close ends every relay and refuses later starts (server shutdown).
func (h *BranchLSPHandler) Close() { h.manager().Close() }

func lspBranchParam(r *http.Request) (string, error) {
	branch, err := url.PathUnescape(chi.URLParam(r, "b"))
	if err != nil || strings.TrimSpace(branch) == "" {
		return "", pkgerrors.BadRequest("invalid branch")
	}
	return branch, nil
}

// Open admits a code-intelligence session: 201 {id, kind: "exec", language}.
// It starts no process, so a refusal here costs no session start or wake.
func (h *BranchLSPHandler) Open(w http.ResponseWriter, r *http.Request) {
	if !h.available() {
		lspUnavailable(w)
		return
	}
	repository, member, err := h.Authorize(r, "code.hover")
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	var body struct {
		Language string `json:"language"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err = decodeSingleJSONDocument(decoder, &body); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid code intelligence request"))
		return
	}
	spec, ok := services.LanguageServerFor(body.Language)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("language must be one of: "+strings.Join(services.LSPLanguages(), ", ")))
		return
	}
	branch, err := lspBranchParam(r)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	principal, err := h.Provider.Authorize(r.Context(), branch, member)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	if principal.RepositoryID != repository || principal.UserID != member || principal.WorkspaceID == "" {
		writeBranchError(w, r, pkgerrors.NotFound("branch not found"))
		return
	}
	if err = h.Provider.Ready(r.Context(), principal); err != nil {
		writeBranchError(w, r, err)
		return
	}
	now := h.clock()
	h.mu.Lock()
	if h.grants == nil {
		h.grants = map[string]*lspGrant{}
	}
	var grant *lspGrant
	for id, existing := range h.grants {
		if now.Sub(existing.used) > lspGrantIdle {
			delete(h.grants, id)
			continue
		}
		if existing.member == member && existing.branch == principal.WorkspaceID && existing.language == spec.Language {
			grant = existing
		}
	}
	if grant == nil {
		grant = &lspGrant{id: uuid.NewString(), member: member, repository: repository, branch: principal.WorkspaceID, language: spec.Language}
		h.grants[grant.id] = grant
	}
	grant.used = now
	id := grant.id
	h.mu.Unlock()
	pkgerrors.WriteJSON(w, http.StatusCreated, map[string]string{"id": id, "kind": "exec", "language": spec.Language, "branch": principal.WorkspaceID})
}

func (h *BranchLSPHandler) grant(id string) *lspGrant {
	h.mu.Lock()
	defer h.mu.Unlock()
	grant := h.grants[id]
	if grant == nil {
		return nil
	}
	copy := *grant
	grant.used = h.clock()
	return &copy
}

// originAllowed exempts only a bearer token sent without a cookie or ticket;
// a browser credential must come from an allowed origin.
func (h *BranchLSPHandler) originAllowed(r *http.Request) bool {
	info := middleware.AuthInfoFromContext(r.Context())
	name := strings.TrimSpace(h.SessionCookieName)
	if name == "" {
		name = "smithers_session"
	}
	cookie, err := r.Cookie(name)
	hasCookie := err == nil && cookie.Value != ""
	if info != nil && info.IsTokenAuth && !hasCookie && r.URL.Query().Get("ticket") == "" {
		return true
	}
	return socketOriginAllowed(h.AllowedOrigins, r.Header.Get("Origin"), r)
}

// Socket relays one admitted session. Authorization, branch.join and the
// awake check all run before the upgrade; the process starts after it, so
// the browser reads a missing language server or a crash as a typed close.
func (h *BranchLSPHandler) Socket(w http.ResponseWriter, r *http.Request) {
	requestCtx := r.Context()
	guard := watchWorkspaceSocket(r)
	defer guard.close()
	r = r.WithContext(guard.ctx)
	if guard.reject(w) {
		return
	}
	if !h.available() {
		h.observe("unavailable")
		lspUnavailable(w)
		return
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		h.observe("unauthenticated")
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return
	}
	// The same command decision as the admission POST: role, credential
	// scope and actor policy are current at every socket.
	if _, member, err := h.Authorize(r, "code.hover"); err != nil || member != user.ID {
		h.observe("forbidden")
		if err == nil {
			err = pkgerrors.NotFound("code intelligence session not found")
		}
		writeBranchError(w, r, err)
		return
	}
	if !h.originAllowed(r) {
		h.observe("origin")
		pkgerrors.WriteError(w, pkgerrors.Forbidden("Origin not allowed"))
		return
	}
	id, err := routeParam(r, "id", "session required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	grant := h.grant(id)
	if grant == nil || grant.member != user.ID {
		h.observe("not_found")
		pkgerrors.WriteError(w, pkgerrors.NotFound("code intelligence session not found"))
		return
	}
	if want := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("language"))); want != "" && want != grant.language {
		h.observe("language_mismatch")
		pkgerrors.WriteError(w, pkgerrors.BadRequest("language "+want+" does not match the session's language "+grant.language))
		return
	}
	branch, err := lspBranchParam(r)
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	principal, err := h.Provider.Authorize(r.Context(), branch, user.ID)
	if guard.reject(w) {
		return
	}
	if err != nil {
		h.observe("forbidden")
		writeBranchError(w, r, err)
		return
	}
	if principal.UserID != user.ID || principal.RepositoryID != grant.repository || principal.WorkspaceID != grant.branch {
		h.observe("not_found")
		pkgerrors.WriteError(w, pkgerrors.NotFound("code intelligence session not found"))
		return
	}
	if err = h.Provider.Ready(r.Context(), principal); err != nil {
		h.observe("asleep")
		writeBranchError(w, r, err)
		return
	}
	principal = guard.scope(principal.WorkspaceID, principal.SandboxID, true)
	if guard.reject(w) {
		return
	}
	if h.ActiveConnections != nil {
		if !h.ActiveConnections.Acquire(user.ID) {
			h.observe("active_cap")
			w.Header().Set("Retry-After", "1")
			pkgerrors.WriteError(w, &pkgerrors.APIError{Status: http.StatusTooManyRequests, Code: pkgerrors.CodeRateLimitExceeded, Message: "too many active terminal and language-server connections"})
			return
		}
		defer h.ActiveConnections.Release(user.ID)
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, Subprotocols: []string{"lsp"}})
	if err != nil {
		h.observe("accept_error")
		return
	}
	defer func() { _ = ws.CloseNow() }()
	if !guard.bind(ws) {
		return
	}
	ws.SetReadLimit(lspMaxMessageBytes)

	language := grant.language
	lspSess, err := h.manager().start(guard.ctx, grant.id, language, func(ctx context.Context) (LSPProcess, error) {
		return h.Provider.Open(ctx, principal, language)
	}, principal)
	if err != nil {
		guard.mu.Lock()
		if guard.revoked {
			// The guard already sends this close; say the same thing.
			err = errWorkspaceSocketRevoked
		}
		guard.mu.Unlock()
		code, reason := lspStartClose(err, language)
		h.observe(lspStartResult(err))
		slog.Info("language server start refused", "session_id", grant.id, "language", language, "error", err)
		_ = ws.Close(code, reason)
		return
	}
	guard.onRevoke(func() { lspSess.destroy(websocket.StatusPolicyViolation, "access revoked") })

	ctx, cancel := context.WithCancel(requestCtx)
	defer cancel()
	if h.beforeAttach != nil {
		h.beforeAttach(lspSess)
	}
	if err := lspSess.attach(ws, func() {}); err != nil {
		if errors.Is(err, errWorkspaceSocketRevoked) {
			_ = ws.Close(websocket.StatusPolicyViolation, "access revoked")
			return
		}
		h.observe("attach_error")
		_ = ws.Close(websocket.StatusInternalError, "failed to attach language server")
		return
	}
	h.observe("success")

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(terminalKeepAliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := ws.Ping(ctx); err != nil {
					return
				}
			}
		}
	}()
	lspSess.run(ctx)
	cancel()
	wg.Wait()
	code, reason := lspSess.closeStatus()
	slog.Info("language server socket closed", "session_id", grant.id, "user_id", user.ID, "language", language, "close_code", int(code), "close_reason", reason)
}

// lspStartClose is the typed close for a start that never reached ready.
func lspStartClose(err error, language string) (websocket.StatusCode, string) {
	var startErr *lspStartError
	switch {
	case errors.Is(err, errWorkspaceSocketRevoked):
		return websocket.StatusPolicyViolation, "access revoked"
	case errors.Is(err, errLanguageServerMissing):
		spec, _ := services.LanguageServerFor(language)
		return websocket.StatusNormalClosure, string(pkgerrors.CodeLanguageServerMissing) + ": " + spec.Install
	case errors.Is(err, services.ErrBranchAsleep):
		return websocket.StatusNormalClosure, "The branch is asleep."
	case errors.As(err, &startErr):
		return websocket.StatusInternalError, lspCloseReasonExited + ": " + strconv.Itoa(startErr.code)
	case errors.Is(err, errLSPManagerClosed):
		return websocket.StatusGoingAway, "server shutting down"
	default:
		return websocket.StatusInternalError, "language server failed to start"
	}
}

func lspStartResult(err error) string {
	var startErr *lspStartError
	switch {
	case errors.Is(err, errWorkspaceSocketRevoked):
		return "revoked"
	case errors.Is(err, errLanguageServerMissing):
		return "language_server_missing"
	case errors.As(err, &startErr):
		return "start_error"
	default:
		return "backend_error"
	}
}
