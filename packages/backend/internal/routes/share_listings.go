package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ShareListingRouteService is the slice of *services.ShareListingService the
// handler depends on (interface so route tests drive authz and wire shape
// without a database).
type ShareListingRouteService interface {
	Publish(ctx context.Context, ownerUserID int64, in services.PublishShareListingInput) (db.ShareListing, error)
	Unpublish(ctx context.Context, actorUserID int64, listingID string) error
	Get(ctx context.Context, listingID string) (db.ShareListing, error)
	List(ctx context.Context, query services.ShareListingQuery) (services.ShareListingPage, error)
	ListForOwner(ctx context.Context, ownerUserID int64, query services.ShareListingQuery) (services.ShareListingPage, error)
	RecordEvent(ctx context.Context, actorUserID int64, listingID, eventType string) (services.ShareListingEventResult, error)
}

// ShareListingHandler serves the public sharing surface (/api/share/*):
// selective publishing of workflow and connector definitions, an
// unauthenticated public catalog, and usage stats.
//
// Auth shape, which the Mount below encodes:
//
//	GET  /api/share/listings           public, no auth
//	GET  /api/share/listings/{id}      public, no auth
//	POST /api/share/listings           auth + write:user
//	DEL  /api/share/listings/{id}      auth + write:user, owner only
//	POST /api/share/listings/{id}/events  auth + write:user, per-user rate limited
//	GET  /api/share/my/listings        auth + read:user
//
// The JSON on this surface is camelCase, NOT the snake_case the rest of plue
// emits. That is deliberate: /api/share is the cross-surface sharing contract
// the Smithers Cloud UI is built against, and it is specified in camelCase.
// Do not "fix" it to match neighboring route modules.
type ShareListingHandler struct {
	Service ShareListingRouteService
}

// NewShareListingHandler constructs the handler.
func NewShareListingHandler(service ShareListingRouteService) *ShareListingHandler {
	return &ShareListingHandler{Service: service}
}

// Mount registers the sharing routes. The caller must NOT wrap this in
// RequireAuth — the catalog reads are deliberately public — and should pass
// the durable per-user events limiter (middleware.ShareListingEventRateLimit).
func (h *ShareListingHandler) Mount(r chi.Router, eventRateLimit func(http.Handler) http.Handler) {
	// Public catalog. No auth, no credential material, ever.
	r.Get("/api/share/listings", h.List)
	r.Get("/api/share/listings/{listingId}", h.Get)

	r.Group(func(r chi.Router) {
		r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser))
		r.Get("/api/share/my/listings", h.ListMine)

		r.Group(func(r chi.Router) {
			// Publishing, unpublishing and usage pings mutate the caller's
			// account state, so a read-only token must not be able to do them.
			r.Use(middleware.RequireScope(middleware.ScopeWriteUser))
			r.Post("/api/share/listings", h.Publish)
			r.Delete("/api/share/listings/{listingId}", h.Unpublish)
			if eventRateLimit != nil {
				r.With(eventRateLimit).Post("/api/share/listings/{listingId}/events", h.RecordEvent)
			} else {
				r.Post("/api/share/listings/{listingId}/events", h.RecordEvent)
			}
		})
	})
}

// --- wire shapes -------------------------------------------------------------

type shareSourceRepoJSON struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

// shareListingJSON is the exact listing contract on the wire. Every listing
// response carries the publish-time definition snapshot; it never carries
// credentials because the publish path rejects obvious credential material.
type shareListingJSON struct {
	ListingID       string              `json:"listingId"`
	Kind            string              `json:"kind"`
	Name            string              `json:"name"`
	Slug            string              `json:"slug"`
	Description     string              `json:"description"`
	OwnerUserID     int64               `json:"ownerUserId"`
	SourceRepo      shareSourceRepoJSON `json:"sourceRepo"`
	SourcePath      string              `json:"sourcePath"`
	ContentSnapshot string              `json:"contentSnapshot"`
	PublishedAt     string              `json:"publishedAt"`
	UpdatedAt       string              `json:"updatedAt"`
	UseCount        int64               `json:"useCount"`
	InstallCount    int64               `json:"installCount"`
}

func shareListingToJSON(row db.ShareListing) shareListingJSON {
	return shareListingJSON{
		ListingID:   row.ID,
		Kind:        row.Kind,
		Name:        row.Name,
		Slug:        row.Slug,
		Description: row.Description,
		OwnerUserID: row.OwnerUserID,
		SourceRepo: shareSourceRepoJSON{
			Owner: row.SourceRepoOwner,
			Name:  row.SourceRepoName,
		},
		SourcePath:      row.SourcePath,
		ContentSnapshot: row.ContentSnapshot,
		PublishedAt:     row.PublishedAt.UTC().Format(shareListingTimeFormat),
		UpdatedAt:       row.UpdatedAt.UTC().Format(shareListingTimeFormat),
		UseCount:        row.UseCount,
		InstallCount:    row.InstallCount,
	}
}

// shareListingTimeFormat is RFC3339 with milliseconds — the format the
// browser's Date parser round-trips without surprises.
const shareListingTimeFormat = "2006-01-02T15:04:05.000Z"

func shareListingPageToJSON(page services.ShareListingPage) map[string]any {
	listings := make([]shareListingJSON, 0, len(page.Listings))
	for _, row := range page.Listings {
		listings = append(listings, shareListingToJSON(row))
	}
	return map[string]any{
		"listings": listings,
		"page":     page.Page,
		"perPage":  page.PerPage,
		"total":    page.Total,
		"hasMore":  page.HasMore(),
	}
}

// --- helpers -----------------------------------------------------------------

func shareListingActor(w http.ResponseWriter, r *http.Request) (int64, bool) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return 0, false
	}
	return user.ID, true
}

func shareListingIDParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "listingId")
	if _, err := uuid.Parse(id); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid listingId: must be a UUID"))
		return "", false
	}
	return id, true
}

// shareListingErr mirrors appTimelineErr: typed APIErrors pass through, a
// missing share_listings table (migration 20260805120000 is applied
// out-of-band) degrades honestly as 503 instead of a 500 leaking driver text,
// and anything else is an opaque 500.
func shareListingErr(w http.ResponseWriter, err error) {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		pkgerrors.WriteError(w, apiErr)
		return
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeFeatureNotEnabled,
			"sharing is not enabled on this deployment"))
		return
	}
	pkgerrors.WriteError(w, pkgerrors.Internal("listing operation failed"))
}

func shareListingQueryFromRequest(r *http.Request) (services.ShareListingQuery, error) {
	q := r.URL.Query()
	query := services.ShareListingQuery{
		Kind: q.Get("kind"),
		Q:    q.Get("q"),
	}
	if page, err := strconv.Atoi(q.Get("page")); err == nil {
		query.Page = page
	} else if errors.Is(err, strconv.ErrRange) {
		return query, pkgerrors.BadRequest("invalid page value")
	}
	if perPage, err := strconv.Atoi(q.Get("perPage")); err == nil {
		query.PerPage = perPage
	}
	return query, nil
}

// --- handlers ----------------------------------------------------------------

// publishShareListingRequest is the publish body. Publishing is always an
// explicit act: there is no other route into the public catalog.
type publishShareListingRequest struct {
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Description string `json:"description"`
	SourceRepo  struct {
		Owner string `json:"owner"`
		Name  string `json:"name"`
	} `json:"sourceRepo"`
	SourcePath      string `json:"sourcePath"`
	ContentSnapshot string `json:"contentSnapshot"`
}

// Publish — POST /api/share/listings
// Auth + write:user. Body: {kind, name, description, sourceRepo, sourcePath,
// contentSnapshot}. 201 with the listing. 400 when the snapshot carries
// credential material.
func (h *ShareListingHandler) Publish(w http.ResponseWriter, r *http.Request) {
	actorID, ok := shareListingActor(w, r)
	if !ok {
		return
	}
	var body publishShareListingRequest
	if err := decodeSingleJSONDocument(json.NewDecoder(r.Body), &body); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid body"))
		return
	}
	listing, err := h.Service.Publish(r.Context(), actorID, services.PublishShareListingInput{
		Kind:            body.Kind,
		Name:            body.Name,
		Description:     body.Description,
		SourceRepoOwner: body.SourceRepo.Owner,
		SourceRepoName:  body.SourceRepo.Name,
		SourcePath:      body.SourcePath,
		ContentSnapshot: body.ContentSnapshot,
	})
	if err != nil {
		shareListingErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, shareListingToJSON(listing))
}

// Unpublish — DELETE /api/share/listings/{listingId}
// Auth + write:user, owner only (403 for a stranger). 204. The listing leaves
// the public catalog; copies consumers already installed keep working.
func (h *ShareListingHandler) Unpublish(w http.ResponseWriter, r *http.Request) {
	actorID, ok := shareListingActor(w, r)
	if !ok {
		return
	}
	listingID, ok := shareListingIDParam(w, r)
	if !ok {
		return
	}
	if err := h.Service.Unpublish(r.Context(), actorID, listingID); err != nil {
		shareListingErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// List — GET /api/share/listings?kind=&q=&page=&perPage=
// PUBLIC. A page of exact listing models with usage stats and safe snapshots.
func (h *ShareListingHandler) List(w http.ResponseWriter, r *http.Request) {
	query, err := shareListingQueryFromRequest(r)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	_, _, _, err = services.ShareListingPageOffset(query.Page, query.PerPage)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	page, err := h.Service.List(r.Context(), query)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, shareListingPageToJSON(page))
}

// Get — GET /api/share/listings/{listingId}
// PUBLIC. Full detail including the content snapshot.
func (h *ShareListingHandler) Get(w http.ResponseWriter, r *http.Request) {
	listingID, ok := shareListingIDParam(w, r)
	if !ok {
		return
	}
	listing, err := h.Service.Get(r.Context(), listingID)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, shareListingToJSON(listing))
}

// ListMine — GET /api/share/my/listings
// Auth + read:user. The caller's own live listings with their stats.
func (h *ShareListingHandler) ListMine(w http.ResponseWriter, r *http.Request) {
	actorID, ok := shareListingActor(w, r)
	if !ok {
		return
	}
	query, err := shareListingQueryFromRequest(r)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	_, _, _, err = services.ShareListingPageOffset(query.Page, query.PerPage)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	page, err := h.Service.ListForOwner(r.Context(), actorID, query)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, shareListingPageToJSON(page))
}

// RecordEvent — POST /api/share/listings/{listingId}/events
// Auth + write:user, per-user rate limited. Body: {type: "install"|"run"}.
// 202 with the current counters. `counted` is false when the caller's
// cooldown for that event type had not elapsed — the ping is accepted, the
// numbers just do not move.
func (h *ShareListingHandler) RecordEvent(w http.ResponseWriter, r *http.Request) {
	actorID, ok := shareListingActor(w, r)
	if !ok {
		return
	}
	listingID, ok := shareListingIDParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Type string `json:"type"`
	}
	if err := decodeSingleJSONDocument(json.NewDecoder(r.Body), &body); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid body"))
		return
	}
	result, err := h.Service.RecordEvent(r.Context(), actorID, listingID, body.Type)
	if err != nil {
		shareListingErr(w, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, map[string]any{
		"counted":      result.Counted,
		"installCount": result.InstallCount,
		"useCount":     result.UseCount,
	})
}
