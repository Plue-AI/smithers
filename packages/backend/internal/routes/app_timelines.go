package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// AppTimelineRouteService is the slice of *services.AppTimelineService the
// handler depends on (interface so route tests drive authz branches without a
// database).
type AppTimelineRouteService interface {
	FindOrCreate(ctx context.Context, ownerUserID int64, clientKey string) (services.AppTimelineResolution, error)
	Get(ctx context.Context, userID int64, timelineID string) (services.AppTimelineResolution, error)
	AppendEvents(ctx context.Context, userID int64, timelineID string, events []services.AppTimelineEventWrite) error
	Rewrite(ctx context.Context, userID int64, timelineID string, dump services.AppTimelineDump) error
	PutSnapshot(ctx context.Context, userID int64, timelineID string, seq int64, state json.RawMessage) error
	Members(ctx context.Context, userID int64, timelineID string) ([]db.ListLiveAppTimelineMemberProfilesRow, error)
	AddMember(ctx context.Context, actorID int64, timelineID, username, role string) (db.AppTimelineMember, error)
	RemoveMember(ctx context.Context, actorID int64, timelineID string, memberUserID int64) error
}

// AppTimelineHandler serves the REST write path of the realtime-synchronized
// app-machine timelines (/api/app-timelines*). Every route is mounted behind
// AuthLoader + RequireAuth + RequireScope(ScopeReadUser) (cmd/server/router.go,
// same chain as pair sessions); mutations additionally require ScopeWriteUser.
// Reads use the same membership model as writes.
type AppTimelineHandler struct {
	Service AppTimelineRouteService
	// WriteRateLimit optionally wraps the mutating routes (per-user token
	// bucket; see middleware.AppTimelineWriteRateLimit). Nil means no limit
	// beyond the global API bucket.
	WriteRateLimit func(http.Handler) http.Handler
}

// NewAppTimelineHandler constructs the handler.
func NewAppTimelineHandler(service AppTimelineRouteService) *AppTimelineHandler {
	return &AppTimelineHandler{Service: service}
}

// Mount registers the app-timeline routes. The caller mounts this under
// RequireAuth + RequireScope(ScopeReadUser); mutating routes additionally
// require ScopeWriteUser so a fine-grained read:user token can sync but not
// rewrite history or manage members. Session-authenticated requests bypass
// token-scope checks entirely.
func (h *AppTimelineHandler) Mount(r chi.Router) {
	r.Get("/api/app-timelines/{id}", h.Get)
	r.Get("/api/app-timelines/{id}/members", h.ListMembers)

	r.Group(func(r chi.Router) {
		r.Use(middleware.RequireScope(middleware.ScopeWriteUser))
		if h.WriteRateLimit != nil {
			r.Use(h.WriteRateLimit)
		}

		r.Post("/api/app-timelines", h.FindOrCreate)
		r.Post("/api/app-timelines/{id}/events", h.AppendEvents)
		r.Put("/api/app-timelines/{id}/state", h.Rewrite)
		r.Put("/api/app-timelines/{id}/snapshots", h.PutSnapshot)
		r.Post("/api/app-timelines/{id}/members", h.AddMember)
		r.Delete("/api/app-timelines/{id}/members/{userId}", h.RemoveMember)
	})
}

// --- helpers ---------------------------------------------------------------

func appTimelineActor(w http.ResponseWriter, r *http.Request) (int64, bool) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return 0, false
	}
	return user.ID, true
}

func appTimelineIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid id: must be a UUID"))
		return "", false
	}
	return id, true
}

// appTimelineErr writes a service error as JSON. The app_timeline_* tables
// ship behind migration 20260719144500, which plue applies out-of-band
// (migrations are manual) — a missing table degrades honestly as 503 rather
// than a 500 leaking driver text (same contract as fileDraftErr).
func appTimelineErr(w http.ResponseWriter, err error) {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		pkgerrors.WriteError(w, apiErr)
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeFeatureNotEnabled,
			"timeline sync is not enabled on this deployment"))
		return
	}
	pkgerrors.WriteError(w, pkgerrors.Internal("timeline operation failed"))
}

func appTimelineDecode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := decodeSingleJSONDocument(json.NewDecoder(r.Body), v); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid body"))
		return false
	}
	return true
}

// appTimelineJSON is the wire shape for a timeline (plus the caller's role).
type appTimelineJSON struct {
	ID          string    `json:"id"`
	OwnerUserID int64     `json:"owner_user_id"`
	ClientKey   string    `json:"client_key"`
	Version     int32     `json:"version"`
	HeadSeq     int64     `json:"head_seq"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func appTimelineToJSON(res services.AppTimelineResolution) appTimelineJSON {
	return appTimelineJSON{
		ID:          res.Timeline.ID,
		OwnerUserID: res.Timeline.OwnerUserID,
		ClientKey:   res.Timeline.ClientKey,
		Version:     res.Timeline.Version,
		HeadSeq:     res.Timeline.HeadSeq,
		Role:        res.Role,
		CreatedAt:   res.Timeline.CreatedAt,
		UpdatedAt:   res.Timeline.UpdatedAt,
	}
}

// appTimelineEventWire is one sequence-numbered event on the wire.
type appTimelineEventWire struct {
	Seq     int64           `json:"seq"`
	Payload json.RawMessage `json:"payload"`
}

// appTimelineBranchWire is one sealed fork branch on the wire (multi's
// TimelineBranch: {fromSeq, events} — snake_cased per plue conventions).
type appTimelineBranchWire struct {
	FromSeq int64             `json:"from_seq"`
	Events  []json.RawMessage `json:"events"`
}

// --- handlers --------------------------------------------------------------

// FindOrCreate — POST /api/app-timelines
// Body: {client_key?}. Returns the caller's timeline for the key (default
// "default"), minting it on first use: 201 when created, 200 when found.
func (h *AppTimelineHandler) FindOrCreate(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	var body struct {
		ClientKey string `json:"client_key"`
	}
	// An empty body means the default client key.
	if r.ContentLength != 0 && !appTimelineDecode(w, r, &body) {
		return
	}
	res, err := h.Service.FindOrCreate(r.Context(), actorID, body.ClientKey)
	if err != nil {
		appTimelineErr(w, err)
		return
	}
	status := http.StatusOK
	if res.Created {
		status = http.StatusCreated
	}
	pkgerrors.WriteJSON(w, status, appTimelineToJSON(res))
}

// Get — GET /api/app-timelines/{id}
func (h *AppTimelineHandler) Get(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	res, err := h.Service.Get(r.Context(), actorID, id)
	if err != nil {
		appTimelineErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, appTimelineToJSON(res))
}

// AppendEvents — POST /api/app-timelines/{id}/events
// Body: {events: [{seq, payload}, ...]} — one contiguous batch appended at
// its first seq (which truncates any existing tail from that seq). 204 on
// success; 409 when the first seq is ahead of the head (client must resync).
func (h *AppTimelineHandler) AppendEvents(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Events []appTimelineEventWire `json:"events"`
	}
	if !appTimelineDecode(w, r, &body) {
		return
	}
	events := make([]services.AppTimelineEventWrite, len(body.Events))
	for i, ev := range body.Events {
		events[i] = services.AppTimelineEventWrite{Seq: ev.Seq, Payload: ev.Payload}
	}
	if err := h.Service.AppendEvents(r.Context(), actorID, id, events); err != nil {
		appTimelineErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Rewrite — PUT /api/app-timelines/{id}/state
// Body: {version, events: [payload, ...], branches: [{from_seq, events}, ...]}
// — the whole-dump rewrite behind multi's fork/restore path (which rewrites
// whole tables instead of diffing). Empty events + branches = clear. 204.
func (h *AppTimelineHandler) Rewrite(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Version  int                     `json:"version"`
		Events   []json.RawMessage       `json:"events"`
		Branches []appTimelineBranchWire `json:"branches"`
	}
	if !appTimelineDecode(w, r, &body) {
		return
	}
	dump := services.AppTimelineDump{Version: body.Version, Events: body.Events}
	for _, branch := range body.Branches {
		dump.Branches = append(dump.Branches, services.AppTimelineBranchWrite{
			FromSeq: branch.FromSeq,
			Events:  branch.Events,
		})
	}
	if err := h.Service.Rewrite(r.Context(), actorID, id, dump); err != nil {
		appTimelineErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PutSnapshot — PUT /api/app-timelines/{id}/snapshots
// Body: {seq, state} — a serialized machine snapshot at seq (state after
// replaying events [0, seq)). 204; 409 when seq is ahead of the head.
func (h *AppTimelineHandler) PutSnapshot(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Seq   int64           `json:"seq"`
		State json.RawMessage `json:"state"`
	}
	if !appTimelineDecode(w, r, &body) {
		return
	}
	if err := h.Service.PutSnapshot(r.Context(), actorID, id, body.Seq, body.State); err != nil {
		appTimelineErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListMembers — GET /api/app-timelines/{id}/members
func (h *AppTimelineHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	members, err := h.Service.Members(r.Context(), actorID, id)
	if err != nil {
		appTimelineErr(w, err)
		return
	}
	out := make([]map[string]any, 0, len(members))
	for _, m := range members {
		out = append(out, map[string]any{
			"user_id":      m.UserID,
			"username":     m.Username,
			"display_name": m.DisplayName,
			"avatar_url":   m.AvatarUrl,
			"role":         m.Role,
			"joined_at":    m.JoinedAt,
		})
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"members": out})
}

// AddMember — POST /api/app-timelines/{id}/members
// Body: {username, role} (role: editor|viewer). Owner only. 201.
func (h *AppTimelineHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if !appTimelineDecode(w, r, &body) {
		return
	}
	member, err := h.Service.AddMember(r.Context(), actorID, id, body.Username, body.Role)
	if err != nil {
		appTimelineErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, map[string]any{
		"user_id":   member.UserID,
		"role":      member.Role,
		"joined_at": member.JoinedAt,
	})
}

// RemoveMember — DELETE /api/app-timelines/{id}/members/{userId}
// Owner only; the owner row is irrevocable. 204.
func (h *AppTimelineHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	actorID, ok := appTimelineActor(w, r)
	if !ok {
		return
	}
	id, ok := appTimelineIDParam(w, r)
	if !ok {
		return
	}
	memberID, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
	if err != nil || memberID <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid user id"))
		return
	}
	if err := h.Service.RemoveMember(r.Context(), actorID, id, memberID); err != nil {
		appTimelineErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
