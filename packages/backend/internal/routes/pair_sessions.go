package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// pairSessionClaimLease is how long an executor election claim is valid before
// the sweep may hand it to another eligible client (executor-election design).
const pairSessionClaimLease = 30 * time.Second

// PairSessionsService is the slice of *services.PairSessionService the handler
// depends on. Declaring it as an interface keeps the HTTP layer thin and lets
// the route tests drive every authz branch (viewer 403 vs editor 201, etc.)
// without a database.
type PairSessionsService interface {
	CreateSession(ctx context.Context, ownerID, repositoryID int64, sourceWorkspaceID string) (db.PairSession, error)
	PreviewSession(ctx context.Context, sessionID string, visitorID int64) (services.PairResolution, error)
	PreviewByLink(ctx context.Context, slug string, visitorID int64) (services.PairResolution, error)
	PreviewForSource(ctx context.Context, sourceWorkspaceID string, visitorID int64) (services.PairResolution, error)
	ResolveSession(ctx context.Context, sessionID string, visitorID int64) (services.PairResolution, error)
	ResolveByLink(ctx context.Context, slug string, visitorID int64) (services.PairResolution, error)
	EndSession(ctx context.Context, sessionID string, actorID int64) error

	ListMembers(ctx context.Context, sessionID string, actorID int64) ([]db.PairSessionMember, error)
	ListMemberProfiles(ctx context.Context, sessionID string, actorID int64) ([]db.ListLivePairSessionMemberProfilesRow, error)
	SetMemberRole(ctx context.Context, sessionID string, actorID, targetUserID int64, role string) (db.PairSessionMember, error)
	RevokeMember(ctx context.Context, sessionID string, actorID, targetUserID int64) error
	SetAccessMode(ctx context.Context, sessionID string, actorID int64, mode string) (db.PairSession, error)

	CreateInvite(ctx context.Context, sessionID string, actorID int64, rawEmail, role string) (services.InviteResult, error)
	CreateInviteByUsername(ctx context.Context, sessionID string, actorID int64, rawUsername, role string) (services.InviteResult, error)
	ListInvites(ctx context.Context, sessionID string, actorID int64) ([]db.PairSessionInvite, error)
	RevokeInvite(ctx context.Context, sessionID string, actorID int64, rawEmail string) error
	RevokeInviteByUsername(ctx context.Context, sessionID string, actorID int64, rawUsername string) error

	MintLink(ctx context.Context, sessionID string, actorID int64, role string) (db.PairSessionLink, error)
	ListLinks(ctx context.Context, sessionID string, actorID int64) ([]db.PairSessionLink, error)
	RevokeLink(ctx context.Context, sessionID string, actorID int64, linkID string) error

	Enqueue(ctx context.Context, sessionID string, actorID int64, source, body string) (db.PairPromptQueue, error)
	ListQueue(ctx context.Context, sessionID string, actorID int64) ([]db.PairPromptQueue, error)
	Claim(ctx context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error)
	Start(ctx context.Context, sessionID string, actorID int64, promptID, clientID, runID string) (db.PairPromptQueue, error)
	Renew(ctx context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error)
	Finish(ctx context.Context, sessionID string, actorID int64, promptID, clientID, status string) (db.PairPromptQueue, error)
	Cancel(ctx context.Context, sessionID string, actorID int64, promptID string) (db.PairPromptQueue, error)

	GetDraft(ctx context.Context, sessionID string, actorID int64) (db.PairSessionDraft, error)
	PutDraft(ctx context.Context, sessionID string, actorID int64, content string, version int64) (db.PairSessionDraft, error)
	SubmitDraft(ctx context.Context, sessionID string, actorID int64) (db.PairPromptQueue, error)

	Heartbeat(ctx context.Context, sessionID string, actorID int64, presence json.RawMessage) error
}

// PairSessionHandler serves the server-authoritative Smithers Pair session API
// (/api/pair-sessions*). Every route is mounted behind a jjhub session
// (AuthLoader + RequireAuth), so identity is the real signed-in user end-to-end
// — no share-key/bearer, no anonymous access. Roles (viewer/editor/owner) and
// the paid-plan gate are enforced server-side inside PairSessionService; a
// viewer that reaches an editor-only route gets a 403 from the service.
type PairSessionHandler struct {
	Service PairSessionsService
}

// NewPairSessionHandler constructs the handler.
func NewPairSessionHandler(service PairSessionsService) *PairSessionHandler {
	return &PairSessionHandler{Service: service}
}

// Mount registers every pair-session subroute on r. The caller is responsible
// for wrapping r in AuthLoader + RequireAuth so UserFromContext is populated.
// Mount registers the pair-session routes. The caller mounts this under
// RequireScope(ScopeReadUser); this method additionally gates every MUTATING
// route behind RequireScope(ScopeWriteUser) so a fine-grained read:user token
// cannot fork a VM (Create), invite arbitrary emails, change
// roles/access/links, or drive the prompt
// queue. Writes imply reads, so a write:user token still satisfies the outer
// read group; session-authenticated requests bypass token-scope checks entirely.
func (h *PairSessionHandler) Mount(r chi.Router) {
	// Side-effect-free previews. Membership/invite/share materialization happens
	// only on the explicit POST join routes below. RequireCSRF remains on these
	// discovery endpoints as defense in depth for session-authenticated browsers.
	r.With(middleware.RequireCSRF).Get("/api/pair-sessions", h.LookupForSource)
	r.With(middleware.RequireCSRF).Get("/api/pair-sessions/by-link/{slug}", h.ResolveByLink)
	r.With(middleware.RequireCSRF).Get("/api/pair-sessions/{id}", h.Resolve)
	r.Get("/api/pair-sessions/{id}/members", h.ListMembers)
	r.Get("/api/pair-sessions/{id}/invites", h.ListInvites)
	r.Get("/api/pair-sessions/{id}/links", h.ListLinks)
	r.Get("/api/pair-sessions/{id}/queue", h.ListQueue)
	r.Get("/api/pair-sessions/{id}/draft", h.GetDraft)

	// Mutations require write scope.
	r.Group(func(r chi.Router) {
		r.Use(middleware.RequireScope(middleware.ScopeWriteUser))

		r.Post("/api/pair-sessions", h.Create)
		r.Post("/api/pair-sessions/by-link/{slug}/join", h.JoinByLink)
		r.Post("/api/pair-sessions/{id}/join", h.Join)
		r.Post("/api/pair-sessions/{id}/end", h.End)

		r.Patch("/api/pair-sessions/{id}/members/{userId}", h.SetMemberRole)
		r.Delete("/api/pair-sessions/{id}/members/{userId}", h.RevokeMember)

		r.Patch("/api/pair-sessions/{id}/access", h.SetAccessMode)

		r.Post("/api/pair-sessions/{id}/invites", h.CreateInvite)
		r.Delete("/api/pair-sessions/{id}/invites", h.RevokeInvite)

		r.Post("/api/pair-sessions/{id}/links", h.MintLink)
		r.Delete("/api/pair-sessions/{id}/links/{linkId}", h.RevokeLink)

		r.Post("/api/pair-sessions/{id}/queue", h.Enqueue)
		r.Post("/api/pair-sessions/{id}/queue/{promptId}/claim", h.Claim)
		r.Post("/api/pair-sessions/{id}/queue/{promptId}/start", h.Start)
		r.Post("/api/pair-sessions/{id}/queue/{promptId}/renew", h.Renew)
		r.Post("/api/pair-sessions/{id}/queue/{promptId}/finish", h.Finish)
		r.Post("/api/pair-sessions/{id}/queue/{promptId}/cancel", h.Cancel)

		r.Put("/api/pair-sessions/{id}/draft", h.PutDraft)
		r.Post("/api/pair-sessions/{id}/draft/submit", h.SubmitDraft)

		r.Post("/api/pair-sessions/{id}/presence", h.Presence)
	})
}

// --- helpers ---------------------------------------------------------------

func pairSessionActor(w http.ResponseWriter, r *http.Request) (int64, bool) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return 0, false
	}
	return user.ID, true
}

// pairSessionErr writes a service error as JSON. The service always returns
// *APIError; anything else is surfaced as a 500 rather than leaked verbatim.
func pairSessionErr(w http.ResponseWriter, err error) {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		pkgerrors.WriteError(w, apiErr)
		return
	}
	pkgerrors.WriteError(w, pkgerrors.Internal("pair session error"))
}

func pairSessionDecode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid body"))
		return false
	}
	return true
}

func pairSessionUserIDParam(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
	if err != nil || id <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid user id"))
		return 0, false
	}
	return id, true
}

func pairSessionUUIDParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := chi.URLParam(r, name)
	if _, err := uuid.Parse(id); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid "+name+": must be a UUID"))
		return "", false
	}
	return id, true
}

// pairInviteJSON is the wire shape for an invite. Never the raw db row: that
// would leak token_hash (the invite credential's digest) and, for invites the
// service keyed to an account, the invitee's stored email. lower_email is
// echoed only when the invite has NO username key — i.e. the owner supplied
// that email themselves on the email path — so the API can never resolve a
// GitHub username into someone's private address.
func pairInviteJSON(invite db.PairSessionInvite) map[string]any {
	out := map[string]any{
		"id":         invite.ID,
		"role":       invite.Role,
		"expires_at": invite.ExpiresAt,
		"created_at": invite.CreatedAt,
	}
	if invite.LowerGithubUsername.Valid {
		out["lower_github_username"] = invite.LowerGithubUsername.String
	} else if invite.LowerEmail.Valid {
		out["lower_email"] = invite.LowerEmail.String
	}
	return out
}

func pairInvitesJSON(invites []db.PairSessionInvite) []map[string]any {
	out := make([]map[string]any, 0, len(invites))
	for _, invite := range invites {
		out = append(out, pairInviteJSON(invite))
	}
	return out
}

// --- session lifecycle -----------------------------------------------------

func (h *PairSessionHandler) Create(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		RepositoryID      int64  `json:"repositoryId"`
		SourceWorkspaceID string `json:"sourceWorkspaceId"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	session, err := h.Service.CreateSession(r.Context(), actor, body.RepositoryID, body.SourceWorkspaceID)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, map[string]any{"session": session, "sessionId": session.ID})
}

// LookupForSource resolves the live session forked from ?sourceWorkspaceId=
// through the normal ACL ladder — the share modal's open-time "is there already
// a session for this workspace?" lookup. 404 when none is live.
func (h *PairSessionHandler) LookupForSource(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	sourceWorkspaceID := strings.TrimSpace(r.URL.Query().Get("sourceWorkspaceId"))
	// A malformed (non-UUID) sourceWorkspaceId must be a client 400, not a 500:
	// the source-lookup query casts the value to uuid, so Postgres raises
	// SQLSTATE 22P02 and leaks its raw error text (column types + SQLSTATE) to
	// the caller. Empty is left to the service (it already answers 400); guard
	// the non-empty malformed case here.
	if sourceWorkspaceID != "" {
		if _, err := uuid.Parse(sourceWorkspaceID); err != nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid sourceWorkspaceId: must be a UUID"))
			return
		}
	}
	res, err := h.Service.PreviewForSource(r.Context(), sourceWorkspaceID, actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"session":      res.Session,
		"role":         res.Role,
		"materialized": res.Materialized,
		"userId":       actor,
	})
}

func (h *PairSessionHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	res, err := h.Service.PreviewSession(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"session":      res.Session,
		"role":         res.Role,
		"materialized": res.Materialized,
		"userId":       actor,
	})
}

func (h *PairSessionHandler) ResolveByLink(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	res, err := h.Service.PreviewByLink(r.Context(), chi.URLParam(r, "slug"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"session":      res.Session,
		"role":         res.Role,
		"materialized": res.Materialized,
		"userId":       actor,
	})
}

// Join accepts a matching invite and materializes the caller's membership and
// workspace share. It is POST-only so the global CSRF middleware protects
// cookie-authenticated browsers.
func (h *PairSessionHandler) Join(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	res, err := h.Service.ResolveSession(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"session":      res.Session,
		"role":         res.Role,
		"materialized": res.Materialized,
		"userId":       actor,
	})
}

// JoinByLink materializes a link-authorized member and workspace share. Like
// Join, it is deliberately POST-only and therefore covered by normal CSRF.
func (h *PairSessionHandler) JoinByLink(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	res, err := h.Service.ResolveByLink(r.Context(), chi.URLParam(r, "slug"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"session":      res.Session,
		"role":         res.Role,
		"materialized": res.Materialized,
		"userId":       actor,
	})
}

func (h *PairSessionHandler) End(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	if err := h.Service.EndSession(r.Context(), chi.URLParam(r, "id"), actor); err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"ended": true})
}

// --- members + roles -------------------------------------------------------

func (h *PairSessionHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	members, err := h.Service.ListMemberProfiles(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (h *PairSessionHandler) SetMemberRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	target, ok := pairSessionUserIDParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	member, err := h.Service.SetMemberRole(r.Context(), chi.URLParam(r, "id"), actor, target, body.Role)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, member)
}

func (h *PairSessionHandler) RevokeMember(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	target, ok := pairSessionUserIDParam(w, r)
	if !ok {
		return
	}
	if err := h.Service.RevokeMember(r.Context(), chi.URLParam(r, "id"), actor, target); err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

func (h *PairSessionHandler) SetAccessMode(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	session, err := h.Service.SetAccessMode(r.Context(), chi.URLParam(r, "id"), actor, body.Mode)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, session)
}

// --- invites ---------------------------------------------------------------

func (h *PairSessionHandler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		Email    string `json:"email"`
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	hasEmail := strings.TrimSpace(body.Email) != ""
	hasUsername := strings.TrimSpace(body.Username) != ""
	if hasEmail == hasUsername {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("provide exactly one of email or username"))
		return
	}
	var result services.InviteResult
	var err error
	if hasEmail {
		result, err = h.Service.CreateInvite(r.Context(), chi.URLParam(r, "id"), actor, body.Email, body.Role)
	} else {
		result, err = h.Service.CreateInviteByUsername(r.Context(), chi.URLParam(r, "id"), actor, body.Username, body.Role)
	}
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	// The raw token is returned to the owner so a copyable link can be shown when
	// email delivery is unavailable — never a fake "sent" state.
	pkgerrors.WriteJSON(w, http.StatusCreated, map[string]any{
		"invite":         pairInviteJSON(result.Invite),
		"token":          result.Token,
		"delivered":      result.Delivered,
		"deliveryDetail": result.DeliveryDetail,
	})
}

func (h *PairSessionHandler) ListInvites(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	invites, err := h.Service.ListInvites(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"invites": pairInvitesJSON(invites)})
}

func (h *PairSessionHandler) RevokeInvite(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if email == "" && username == "" {
		var body struct {
			Email    string `json:"email"`
			Username string `json:"username"`
		}
		if !pairSessionDecode(w, r, &body) {
			return
		}
		email = strings.TrimSpace(body.Email)
		username = strings.TrimSpace(body.Username)
	}
	if (email == "") == (username == "") {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("provide exactly one of email or username"))
		return
	}
	var err error
	if email != "" {
		err = h.Service.RevokeInvite(r.Context(), chi.URLParam(r, "id"), actor, email)
	} else {
		err = h.Service.RevokeInviteByUsername(r.Context(), chi.URLParam(r, "id"), actor, username)
	}
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

// --- links (amendment A) ---------------------------------------------------

func (h *PairSessionHandler) MintLink(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	link, err := h.Service.MintLink(r.Context(), chi.URLParam(r, "id"), actor, body.Role)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, link)
}

func (h *PairSessionHandler) ListLinks(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	links, err := h.Service.ListLinks(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"links": links})
}

func (h *PairSessionHandler) RevokeLink(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	linkID, ok := pairSessionUUIDParam(w, r, "linkId")
	if !ok {
		return
	}
	if err := h.Service.RevokeLink(r.Context(), chi.URLParam(r, "id"), actor, linkID); err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

// --- prompt queue ----------------------------------------------------------

func (h *PairSessionHandler) ListQueue(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	rows, err := h.Service.ListQueue(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"queue": rows})
}

func (h *PairSessionHandler) Enqueue(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		Source string `json:"source"`
		Body   string `json:"body"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	prompt, err := h.Service.Enqueue(r.Context(), chi.URLParam(r, "id"), actor, body.Source, body.Body)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, prompt)
}

func (h *PairSessionHandler) Claim(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	promptID, ok := pairSessionUUIDParam(w, r, "promptId")
	if !ok {
		return
	}
	var body struct {
		ClientID string `json:"clientId"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.ClientID) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("clientId is required"))
		return
	}
	prompt, err := h.Service.Claim(r.Context(), chi.URLParam(r, "id"), actor, promptID, body.ClientID, pairSessionClaimLease)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PairSessionHandler) Start(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	promptID, ok := pairSessionUUIDParam(w, r, "promptId")
	if !ok {
		return
	}
	var body struct {
		ClientID string `json:"clientId"`
		RunID    string `json:"runId"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	prompt, err := h.Service.Start(r.Context(), chi.URLParam(r, "id"), actor, promptID, body.ClientID, body.RunID)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PairSessionHandler) Renew(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	promptID, ok := pairSessionUUIDParam(w, r, "promptId")
	if !ok {
		return
	}
	var body struct {
		ClientID string `json:"clientId"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.ClientID) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("clientId is required"))
		return
	}
	prompt, err := h.Service.Renew(r.Context(), chi.URLParam(r, "id"), actor, promptID, body.ClientID, pairSessionClaimLease)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PairSessionHandler) Finish(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	promptID, ok := pairSessionUUIDParam(w, r, "promptId")
	if !ok {
		return
	}
	var body struct {
		ClientID string `json:"clientId"`
		Status   string `json:"status"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.ClientID) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("clientId is required"))
		return
	}
	prompt, err := h.Service.Finish(r.Context(), chi.URLParam(r, "id"), actor, promptID, body.ClientID, body.Status)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, prompt)
}

func (h *PairSessionHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	promptID, ok := pairSessionUUIDParam(w, r, "promptId")
	if !ok {
		return
	}
	prompt, err := h.Service.Cancel(r.Context(), chi.URLParam(r, "id"), actor, promptID)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, prompt)
}

// --- co-compose draft ------------------------------------------------------

func (h *PairSessionHandler) GetDraft(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	draft, err := h.Service.GetDraft(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, draft)
}

func (h *PairSessionHandler) PutDraft(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		Content string `json:"content"`
		Version int64  `json:"version"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	draft, err := h.Service.PutDraft(r.Context(), chi.URLParam(r, "id"), actor, body.Content, body.Version)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, draft)
}

func (h *PairSessionHandler) SubmitDraft(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	prompt, err := h.Service.SubmitDraft(r.Context(), chi.URLParam(r, "id"), actor)
	if err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, prompt)
}

// --- presence --------------------------------------------------------------

func (h *PairSessionHandler) Presence(w http.ResponseWriter, r *http.Request) {
	actor, ok := pairSessionActor(w, r)
	if !ok {
		return
	}
	var body struct {
		Presence json.RawMessage `json:"presence"`
	}
	if !pairSessionDecode(w, r, &body) {
		return
	}
	if err := h.Service.Heartbeat(r.Context(), chi.URLParam(r, "id"), actor, body.Presence); err != nil {
		pairSessionErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
