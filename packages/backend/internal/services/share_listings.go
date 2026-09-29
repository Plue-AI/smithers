package services

import (
	"context"
	stdErrors "errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/credentialscan"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ShareListingService is the public-sharing surface: a user selectively
// publishes one workflow or connector DEFINITION to the public catalog, the
// catalog is readable without authentication, and installs/runs of a listing
// feed its usage stats.
//
// Three product invariants live here, not in the handler:
//
//   - Publishing is always an explicit act. There is no implicit or default
//     share path; the only way a row reaches share_listings is this service's
//     Publish, called from an authenticated POST.
//   - A listing never carries credentials. Publish runs the snapshot through
//     credentialscan.ScanForCredentialMaterial and refuses anything that looks like key
//     material. Sharing a connector shares its definition; the consumer
//     supplies their own credentials through their own setup flow.
//   - Unpublishing is not a recall. It removes the listing from the public
//     catalog; copies a consumer already installed are theirs and keep working.
type ShareListingService struct {
	store ShareListingStore
	now   func() time.Time
}

// ShareListingStore is the sqlc query surface the service consumes;
// *db.Queries satisfies it implicitly.
type ShareListingStore interface {
	CreateShareListing(ctx context.Context, arg db.CreateShareListingParams) (db.ShareListing, error)
	GetLiveShareListing(ctx context.Context, id string) (db.ShareListing, error)
	GetShareListingAnyState(ctx context.Context, id string) (db.ShareListing, error)
	ListLiveShareListings(ctx context.Context, arg db.ListLiveShareListingsParams) ([]db.ShareListing, error)
	CountLiveShareListings(ctx context.Context, arg db.CountLiveShareListingsParams) (int64, error)
	ListShareListingsForOwner(ctx context.Context, arg db.ListShareListingsForOwnerParams) ([]db.ShareListing, error)
	CountShareListingsForOwner(ctx context.Context, ownerUserID int64) (int64, error)
	UnpublishShareListing(ctx context.Context, arg db.UnpublishShareListingParams) (db.ShareListing, error)
	RecordShareListingEvent(ctx context.Context, arg db.RecordShareListingEventParams) (db.RecordShareListingEventRow, error)
}

// ShareListingServiceOption customizes a ShareListingService.
type ShareListingServiceOption func(*ShareListingService)

// WithShareListingClock swaps the time source (tests drive the event
// cooldown deterministically).
func WithShareListingClock(now func() time.Time) ShareListingServiceOption {
	return func(s *ShareListingService) {
		if now != nil {
			s.now = now
		}
	}
}

// NewShareListingService constructs the service.
func NewShareListingService(store ShareListingStore, opts ...ShareListingServiceOption) *ShareListingService {
	s := &ShareListingService{store: store, now: func() time.Time { return time.Now().UTC() }}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Listing kinds. A listing is either a shared workflow (a flow file) or a
// shared connector (a connector manifest).
const (
	ShareListingKindWorkflow  = "workflow"
	ShareListingKindConnector = "connector"
)

// Listing event types. install feeds installCount, run feeds useCount.
const (
	ShareListingEventInstall = "install"
	ShareListingEventRun     = "run"
)

// Bounds on a publish request. The snapshot cap is generous for a flow file
// and small enough that the catalog stays a catalog, not a blob store.
const (
	shareListingMaxNameLen        = 128
	shareListingMaxDescriptionLen = 4000
	shareListingMaxRepoPartLen    = 255
	shareListingMaxSourcePathLen  = 512
	// ShareListingMaxSnapshotBytes bounds content_snapshot. Callers should
	// also bound the HTTP body; this is the last word.
	ShareListingMaxSnapshotBytes = 256 * 1024
	shareListingMaxSlugLen       = 160
)

// Event cooldowns: the per-(listing, user, type) window inside which a repeat
// event is accepted but not counted again. This is the floor under the
// per-user rate limit — it makes the published numbers mean something even if
// a client loops. An install is a once-a-day-per-user act; a run is bursty, so
// its window is short enough that real repeated use still registers.
const (
	shareListingInstallCooldown = 24 * time.Hour
	shareListingRunCooldown     = time.Minute
)

// Catalog paging. The catalog is browsed, not scraped.
const (
	ShareListingDefaultPageSize = 25
	ShareListingMaxPageSize     = 100
)

// PublishShareListingInput is a validated publish request.
type PublishShareListingInput struct {
	Kind            string
	Name            string
	Description     string
	SourceRepoOwner string
	SourceRepoName  string
	SourcePath      string
	ContentSnapshot string
}

// ShareListingQuery is one page of a catalog read.
type ShareListingQuery struct {
	// Kind filters to "workflow" or "connector"; empty means both.
	Kind string
	// Q is a free-text needle matched against name, slug and description.
	Q string
	// Page is 1-indexed. Zero or negative is treated as page 1.
	Page int
	// PerPage is clamped to [1, ShareListingMaxPageSize].
	PerPage int
}

// ShareListingPage is a page of listings plus the total behind it.
type ShareListingPage struct {
	Listings []db.ShareListing
	Total    int64
	Page     int
	PerPage  int
}

// HasMore reports whether another page exists after this one.
func (p ShareListingPage) HasMore() bool {
	if p.Page < 1 || p.PerPage < 1 || p.Total <= 0 {
		return false
	}
	offset, err := CheckedPageOffset(p.Page, p.PerPage, math.MaxInt64)
	return err == nil && offset < p.Total && int64(p.PerPage) < p.Total-offset
}

// ShareListingEventResult reports what an install/run ping did. Accepted is
// always true for a live listing; Counted is false when the caller's cooldown
// for that (listing, type) had not elapsed, in which case the counters are
// returned unchanged.
type ShareListingEventResult struct {
	Counted      bool
	InstallCount int64
	UseCount     int64
}

// Publish creates a listing owned by ownerUserID. It is the ONLY write path
// into the public catalog.
func (s *ShareListingService) Publish(ctx context.Context, ownerUserID int64, in PublishShareListingInput) (db.ShareListing, error) {
	if ownerUserID <= 0 {
		return db.ShareListing{}, pkgerrors.Unauthorized("authentication required")
	}
	normalized, err := validatePublishInput(in)
	if err != nil {
		return db.ShareListing{}, err
	}

	params := db.CreateShareListingParams{
		Kind:            normalized.Kind,
		Name:            normalized.Name,
		Slug:            shareListingSlug(normalized.Name),
		Description:     normalized.Description,
		OwnerUserID:     ownerUserID,
		SourceRepoOwner: normalized.SourceRepoOwner,
		SourceRepoName:  normalized.SourceRepoName,
		SourcePath:      normalized.SourcePath,
		ContentSnapshot: normalized.ContentSnapshot,
	}

	listing, err := s.store.CreateShareListing(ctx, params)
	if err == nil {
		return listing, nil
	}
	if !isShareListingUniqueViolation(err) {
		return db.ShareListing{}, err
	}

	// The live-slug index rejected the natural slug: another live listing of
	// the same kind already owns it. Disambiguate with a short time-derived
	// suffix rather than probing in a loop — the catalog is browsed by name,
	// and the slug only has to be unique and stable.
	params.Slug = appendSlugSuffix(params.Slug, s.now())
	listing, err = s.store.CreateShareListing(ctx, params)
	if err != nil {
		if isShareListingUniqueViolation(err) {
			return db.ShareListing{}, pkgerrors.Conflict("a listing with this name already exists; rename it and publish again")
		}
		return db.ShareListing{}, err
	}
	return listing, nil
}

// Unpublish removes a listing from the public catalog. Owner only. It is
// idempotent: unpublishing an already-unpublished listing you own succeeds.
// Copies consumers already installed are unaffected.
func (s *ShareListingService) Unpublish(ctx context.Context, actorUserID int64, listingID string) error {
	if actorUserID <= 0 {
		return pkgerrors.Unauthorized("authentication required")
	}
	existing, err := s.store.GetShareListingAnyState(ctx, listingID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("listing not found")
		}
		return err
	}
	// A published listing is public, so its existence is not a secret: a
	// stranger gets an honest 403 rather than a misleading 404.
	if existing.OwnerUserID != actorUserID {
		return pkgerrors.Forbidden("only the listing owner can unpublish it")
	}
	if existing.UnpublishedAt.Valid {
		return nil
	}
	if _, err := s.store.UnpublishShareListing(ctx, db.UnpublishShareListingParams{
		ID:          listingID,
		OwnerUserID: actorUserID,
	}); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// Raced with a concurrent unpublish; the desired state holds.
			return nil
		}
		return err
	}
	return nil
}

// Get returns one live listing, including its content snapshot. Public.
func (s *ShareListingService) Get(ctx context.Context, listingID string) (db.ShareListing, error) {
	listing, err := s.store.GetLiveShareListing(ctx, listingID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.ShareListing{}, pkgerrors.NotFound("listing not found")
		}
		return db.ShareListing{}, err
	}
	return listing, nil
}

// List returns a page of the public catalog. Public.
func (s *ShareListingService) List(ctx context.Context, query ShareListingQuery) (ShareListingPage, error) {
	page, perPage, offset, err := ShareListingPageOffset(query.Page, query.PerPage)
	if err != nil {
		return ShareListingPage{}, err
	}

	kind := pgtype.Text{}
	if query.Kind != "" {
		normalizedKind := strings.ToLower(strings.TrimSpace(query.Kind))
		if !isShareListingKind(normalizedKind) {
			return ShareListingPage{}, pkgerrors.BadRequest(`kind must be "workflow" or "connector"`)
		}
		kind = pgtype.Text{String: normalizedKind, Valid: true}
	}

	needle := pgtype.Text{}
	if trimmed := strings.TrimSpace(query.Q); trimmed != "" {
		needle = pgtype.Text{String: escapeLikeNeedle(trimmed), Valid: true}
	}

	total, err := s.store.CountLiveShareListings(ctx, db.CountLiveShareListingsParams{Kind: kind, Q: needle})
	if err != nil {
		return ShareListingPage{}, err
	}
	listings, err := s.store.ListLiveShareListings(ctx, db.ListLiveShareListingsParams{
		Kind:         kind,
		Q:            needle,
		ResultLimit:  int64(perPage),
		ResultOffset: offset,
	})
	if err != nil {
		return ShareListingPage{}, err
	}
	return ShareListingPage{Listings: listings, Total: total, Page: page, PerPage: perPage}, nil
}

// ListForOwner returns a page of the caller's own live listings with stats.
func (s *ShareListingService) ListForOwner(ctx context.Context, ownerUserID int64, query ShareListingQuery) (ShareListingPage, error) {
	if ownerUserID <= 0 {
		return ShareListingPage{}, pkgerrors.Unauthorized("authentication required")
	}
	page, perPage, offset, err := ShareListingPageOffset(query.Page, query.PerPage)
	if err != nil {
		return ShareListingPage{}, err
	}

	total, err := s.store.CountShareListingsForOwner(ctx, ownerUserID)
	if err != nil {
		return ShareListingPage{}, err
	}
	listings, err := s.store.ListShareListingsForOwner(ctx, db.ListShareListingsForOwnerParams{
		OwnerUserID:  ownerUserID,
		ResultLimit:  int64(perPage),
		ResultOffset: offset,
	})
	if err != nil {
		return ShareListingPage{}, err
	}
	return ShareListingPage{Listings: listings, Total: total, Page: page, PerPage: perPage}, nil
}

// RecordEvent applies one install/run ping from actorUserID to a live
// listing. The route in front of this is per-user rate limited; the cooldown
// applied here is the second layer that keeps the published counts honest.
func (s *ShareListingService) RecordEvent(ctx context.Context, actorUserID int64, listingID, eventType string) (ShareListingEventResult, error) {
	if actorUserID <= 0 {
		return ShareListingEventResult{}, pkgerrors.Unauthorized("authentication required")
	}
	normalizedType := strings.ToLower(strings.TrimSpace(eventType))
	cooldown, ok := shareListingEventCooldown(normalizedType)
	if !ok {
		return ShareListingEventResult{}, pkgerrors.BadRequest(`type must be "install" or "run"`)
	}

	now := s.now()
	row, err := s.store.RecordShareListingEvent(ctx, db.RecordShareListingEventParams{
		ListingID:    listingID,
		UserID:       actorUserID,
		EventType:    normalizedType,
		CountedAt:    now,
		DedupeCutoff: now.Add(-cooldown),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ShareListingEventResult{}, pkgerrors.NotFound("listing not found")
		}
		return ShareListingEventResult{}, err
	}
	if !row.ListingFound {
		return ShareListingEventResult{}, pkgerrors.NotFound("listing not found")
	}
	return ShareListingEventResult{
		Counted:      row.Counted,
		InstallCount: row.InstallCount,
		UseCount:     row.UseCount,
	}, nil
}

// --- validation + helpers ---------------------------------------------------

func validatePublishInput(in PublishShareListingInput) (PublishShareListingInput, error) {
	out := PublishShareListingInput{
		Kind:            strings.ToLower(strings.TrimSpace(in.Kind)),
		Name:            strings.TrimSpace(in.Name),
		Description:     strings.TrimSpace(in.Description),
		SourceRepoOwner: strings.TrimSpace(in.SourceRepoOwner),
		SourceRepoName:  strings.TrimSpace(in.SourceRepoName),
		SourcePath:      strings.TrimSpace(in.SourcePath),
		ContentSnapshot: in.ContentSnapshot,
	}

	if !isShareListingKind(out.Kind) {
		return out, pkgerrors.BadRequest(`kind must be "workflow" or "connector"`)
	}
	if out.Name == "" || len([]rune(out.Name)) > shareListingMaxNameLen {
		return out, pkgerrors.BadRequest("name is required and must be at most 128 characters")
	}
	if shareListingSlug(out.Name) == "" {
		return out, pkgerrors.BadRequest("name must contain at least one letter or digit")
	}
	if len([]rune(out.Description)) > shareListingMaxDescriptionLen {
		return out, pkgerrors.BadRequest("description must be at most 4000 characters")
	}
	if out.SourceRepoOwner == "" || len(out.SourceRepoOwner) > shareListingMaxRepoPartLen {
		return out, pkgerrors.BadRequest("sourceRepo.owner is required")
	}
	if out.SourceRepoName == "" || len(out.SourceRepoName) > shareListingMaxRepoPartLen {
		return out, pkgerrors.BadRequest("sourceRepo.name is required")
	}
	if out.SourcePath == "" || len(out.SourcePath) > shareListingMaxSourcePathLen {
		return out, pkgerrors.BadRequest("sourcePath is required and must be at most 512 characters")
	}
	if strings.TrimSpace(out.ContentSnapshot) == "" {
		return out, pkgerrors.BadRequest("contentSnapshot is required")
	}
	if len(out.ContentSnapshot) > ShareListingMaxSnapshotBytes {
		return out, pkgerrors.BadRequest("contentSnapshot must be at most 256 KiB")
	}
	if finding := credentialscan.ScanForCredentialMaterial(out.ContentSnapshot); finding != nil {
		return out, &pkgerrors.APIError{
			Status: http.StatusBadRequest,
			Code:   ShareListingSecretDetectedCode,
			Message: "contentSnapshot looks like it contains " + finding.Hint +
				" — a listing shares the definition only; consumers supply their own credentials",
			Details: finding,
		}
	}
	return out, nil
}

// ShareListingSecretDetectedCode is the machine-readable code on the 400 a
// publish gets when its snapshot carries credential material. Clients branch
// on this to point the user at the offending line.
const ShareListingSecretDetectedCode = pkgerrors.CodeListingSecretDetected

func isShareListingKind(kind string) bool {
	return kind == ShareListingKindWorkflow || kind == ShareListingKindConnector
}

func shareListingEventCooldown(eventType string) (time.Duration, bool) {
	switch eventType {
	case ShareListingEventInstall:
		return shareListingInstallCooldown, true
	case ShareListingEventRun:
		return shareListingRunCooldown, true
	default:
		return 0, false
	}
}

// ShareListingPageOffset normalizes catalog paging within the SQL int64 offset.
func ShareListingPageOffset(page, perPage int) (int, int, int64, error) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = ShareListingDefaultPageSize
	}
	if perPage > ShareListingMaxPageSize {
		perPage = ShareListingMaxPageSize
	}
	offset, err := CheckedPageOffset(page, perPage, math.MaxInt64)
	return page, perPage, offset, err
}

// shareListingSlug folds a display name into a URL-safe handle. Non
// alphanumerics collapse to single dashes; the result is lowercase and
// trimmed to the column bound.
func shareListingSlug(name string) string {
	var b strings.Builder
	lastDash := true // leading dashes are suppressed
	for _, r := range strings.ToLower(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > shareListingMaxSlugLen-8 {
		slug = strings.Trim(slug[:shareListingMaxSlugLen-8], "-")
	}
	return slug
}

// appendSlugSuffix disambiguates a colliding slug with a short base-36 stamp.
func appendSlugSuffix(slug string, at time.Time) string {
	suffix := strconv.FormatInt(at.UnixNano()%1_000_000_000, 36)
	if slug == "" {
		return suffix
	}
	return slug + "-" + suffix
}

// escapeLikeNeedle neutralizes ILIKE wildcards so a `q=%` search is a literal
// search for a percent sign, not a full-table scan pattern.
func escapeLikeNeedle(q string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(q)
}

func isShareListingUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return stdErrors.As(err, &pgErr) && pgErr.Code == "23505"
}
