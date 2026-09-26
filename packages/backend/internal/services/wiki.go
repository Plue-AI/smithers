package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// maxWikiBodyBytes is the maximum allowed byte length for a wiki page body (1 MB).
const maxWikiBodyBytes = 1 << 20

type WikiAuthorSummary struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

type WikiPageResponse struct {
	Attachment    *WikiAttachment   `json:"attachment,omitempty"`
	Visibility    string            `json:"visibility"`
	Path          string            `json:"path"`
	ContentDigest string            `json:"content_digest"`
	Revision      int64             `json:"revision"`
	ID            int64             `json:"id"`
	Slug          string            `json:"slug"`
	Title         string            `json:"title"`
	Body          string            `json:"body,omitempty"`
	Author        WikiAuthorSummary `json:"author"`
	CreatedAt     time.Time         `json:"created_at"`
	UpdatedAt     time.Time         `json:"updated_at"`
}

// WikiRevisionResponse represents a single historical revision of a wiki page.
type WikiRevisionResponse struct {
	Attachment      *WikiAttachment   `json:"attachment,omitempty"`
	PageID          int64             `json:"page_id"`
	Visibility      string            `json:"visibility"`
	Path            string            `json:"path"`
	ContentDigest   string            `json:"content_digest"`
	Revision        int64             `json:"revision"`
	Body            string            `json:"body"`
	Deleted         bool              `json:"deleted"`
	HistoryCommitID string            `json:"history_commit_id"`
	ID              int64             `json:"id"`
	Slug            string            `json:"slug"`
	Title           string            `json:"title"`
	Author          WikiAuthorSummary `json:"author"`
	UpdatedAt       time.Time         `json:"updated_at"`
}

type ListWikiPagesInput struct {
	Query   string `json:"query"`
	Page    int    `json:"page"`
	PerPage int    `json:"per_page"`
}

type CreateWikiPageInput struct {
	Path  string `json:"path,omitempty"`
	Title string `json:"title"`
	Slug  string `json:"slug,omitempty"`
	Body  string `json:"body"`
}

type UpdateWikiPageInput struct {
	Path             *string `json:"path,omitempty"`
	ExpectedRevision *int64  `json:"expected_revision,omitempty"`
	Title            *string `json:"title,omitempty"`
	Slug             *string `json:"slug,omitempty"`
	Body             *string `json:"body,omitempty"`
}

type WikiQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)

	CountWikiPagesByRepo(ctx context.Context, arg db.CountWikiPagesByRepoParams) (int64, error)
	ListWikiPagesByRepo(ctx context.Context, arg db.ListWikiPagesByRepoParams) ([]db.ListWikiPagesByRepoRow, error)
	CountSearchWikiPagesByRepo(ctx context.Context, arg db.CountSearchWikiPagesByRepoParams) (int64, error)
	SearchWikiPagesByRepo(ctx context.Context, arg db.SearchWikiPagesByRepoParams) ([]db.SearchWikiPagesByRepoRow, error)
	GetWikiPageBySlug(ctx context.Context, arg db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error)
	CreateWikiPage(ctx context.Context, arg db.CreateWikiPageParams) (db.WikiPage, error)
	UpdateWikiPage(ctx context.Context, arg db.UpdateWikiPageParams) (db.WikiPage, error)
	DeleteWikiPage(ctx context.Context, arg db.DeleteWikiPageParams) (int64, error)
}

type WikiDispatcher interface {
	DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
}

type WikiService struct {
	content      blob.Store
	queries      WikiQuerier
	dispatcher   WikiDispatcher
	documents    WikiCollaborationStore
	documentHost WikiDocumentHost
}

func NewWikiService(querier WikiQuerier, dispatcher WikiDispatcher, options ...WikiServiceOption) *WikiService {
	service := &WikiService{
		queries:    querier,
		dispatcher: dispatcher,
	}
	for _, option := range options {
		option(service)
	}
	return service
}

func (s *WikiService) ListWikiPages(ctx context.Context, viewer *db.User, owner, repo string, input ListWikiPagesInput) ([]WikiPageResponse, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, 0, err
	}

	pageSize, pageOffset, _, _ := normalizePage(input.Page, input.PerPage)
	query := strings.TrimSpace(input.Query)
	if query == "" {
		total, err := s.queries.CountWikiPagesByRepo(ctx, db.CountWikiPagesByRepoParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx)})
		if err != nil {
			return nil, 0, pkgerrors.Internal("failed to count wiki pages").WithCause(err)
		}
		rows, err := s.queries.ListWikiPagesByRepo(ctx, db.ListWikiPagesByRepoParams{
			RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
			Limit:  pageSize,
			Offset: pageOffset,
		})
		if err != nil {
			return nil, 0, pkgerrors.Internal("failed to list wiki pages").WithCause(err)
		}
		return mapListedWikiPages(rows), total, nil
	}

	total, err := s.queries.CountSearchWikiPagesByRepo(ctx, db.CountSearchWikiPagesByRepoParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Query: query,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count wiki pages").WithCause(err)
	}
	rows, err := s.queries.SearchWikiPagesByRepo(ctx, db.SearchWikiPagesByRepoParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Query:      query,
		PageSize:   pageSize,
		PageOffset: pageOffset,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to search wiki pages").WithCause(err)
	}
	return mapSearchedWikiPages(rows), total, nil
}

func (s *WikiService) GetWikiPage(ctx context.Context, viewer *db.User, owner, repo, slug string) (WikiPageResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return WikiPageResponse{}, err
	}

	normalizedSlug, err := normalizeWikiSlug(slug)
	if err != nil {
		return WikiPageResponse{}, err
	}

	page, err := s.queries.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Slug: normalizedSlug,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return WikiPageResponse{}, pkgerrors.NotFound("wiki page not found")
		}
		return WikiPageResponse{}, pkgerrors.Internal("failed to load wiki page").WithCause(err)
	}
	if len(page.Attachment) == 0 {
		if err = s.materializeWikiMarkdown(ctx, repository.ID, page.Body, page.ContentDigest); err != nil {
			return WikiPageResponse{}, err
		}
	}
	if err = s.wikiReadStillAuthorized(ctx, viewer, owner, repo, repository.ID); err != nil {
		return WikiPageResponse{}, err
	}
	return mapWikiPage(page), nil
}

func (s *WikiService) CreateWikiPage(ctx context.Context, actor *db.User, owner, repo string, input CreateWikiPageInput) (WikiPageResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return WikiPageResponse{}, err
	}

	if len(input.Body) > maxWikiBodyBytes {
		return WikiPageResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WikiPage",
			Field:    "body",
			Code:     "too_large",
		})
	}

	title, err := normalizeWikiTitle(input.Title)
	if err != nil {
		return WikiPageResponse{}, err
	}
	slug := strings.TrimSpace(input.Slug)
	if slug == "" {
		slug = slugifyWikiTitle(title)
	}
	slug, err = normalizeWikiSlug(slug)
	if err != nil {
		return WikiPageResponse{}, err
	}

	pagePath, err := normalizeWikiPath(input.Path, slug)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if err = validWikiBody(input.Body); err != nil {
		return WikiPageResponse{}, err
	}
	if _, err = s.putWikiContent(ctx, repository.ID, []byte(input.Body)); err != nil {
		return WikiPageResponse{}, err
	}
	if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, repository.ID); err != nil {
		return WikiPageResponse{}, err
	}
	created, err := s.queries.CreateWikiPage(ctx, db.CreateWikiPageParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Slug:     slug,
		Title:    title,
		Body:     input.Body,
		AuthorID: actor.ID, Path: pagePath,
	})
	if err != nil {
		if isWikiPageConflict(err) {
			return WikiPageResponse{}, pkgerrors.Conflict("wiki page already exists")
		}
		return WikiPageResponse{}, pkgerrors.Internal("failed to create wiki page").WithCause(err)
	}

	response := mapWikiPageRecord(created, actor.Username)
	s.dispatchWikiEvent(ctx, repository, actor, "created", response)
	return response, nil
}

func (s *WikiService) UpdateWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string, input UpdateWikiPageInput) (WikiPageResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return WikiPageResponse{}, err
	}

	currentSlug, err := normalizeWikiSlug(slug)
	if err != nil {
		return WikiPageResponse{}, err
	}

	existing, err := s.queries.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Slug: currentSlug,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return WikiPageResponse{}, pkgerrors.NotFound("wiki page not found")
		}
		return WikiPageResponse{}, pkgerrors.Internal("failed to load wiki page").WithCause(err)
	}

	if input.ExpectedRevision != nil && *input.ExpectedRevision != existing.Revision {
		return WikiPageResponse{}, pkgerrors.Conflict("wiki changed; expected_revision does not match")
	}
	if input.Title == nil && input.Slug == nil && input.Body == nil && input.Path == nil {
		return WikiPageResponse{}, pkgerrors.BadRequest("at least one field must be provided")
	}

	nextTitle := existing.Title
	if input.Title != nil {
		nextTitle, err = normalizeWikiTitle(*input.Title)
		if err != nil {
			return WikiPageResponse{}, err
		}
	}

	nextSlug := existing.Slug
	if input.Slug != nil {
		nextSlug, err = normalizeWikiSlug(*input.Slug)
		if err != nil {
			return WikiPageResponse{}, err
		}
	}

	nextPath := existing.Path
	if input.Path != nil {
		if len(existing.Attachment) > 0 {
			nextPath, err = normalizeWikiAttachmentPath(*input.Path)
		} else {
			nextPath, err = normalizeWikiPath(*input.Path, nextSlug)
		}
		if err != nil {
			return WikiPageResponse{}, err
		}
	}
	nextBody := existing.Body
	if input.Body != nil {
		if len(*input.Body) > maxWikiBodyBytes {
			return WikiPageResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "WikiPage",
				Field:    "body",
				Code:     "too_large",
			})
		}
		if len(existing.Attachment) > 0 {
			return WikiPageResponse{}, pkgerrors.BadRequest("replace attachment bytes through the attachment endpoint")
		}
		if err = validWikiBody(*input.Body); err != nil {
			return WikiPageResponse{}, err
		}
		nextBody = *input.Body
	}

	if s.documents != nil {
		response, handled, err := s.replaceCollaborativeWikiPage(ctx, actor, owner, repo, existing.ID, repository.ID, currentSlug, nextSlug, nextTitle, nextPath, input)
		if handled || err != nil {
			if err == nil {
				s.dispatchWikiEvent(ctx, repository, actor, "updated", response)
			}
			return response, err
		}
	}
	if len(existing.Attachment) == 0 {
		if _, err = s.putWikiContent(ctx, repository.ID, []byte(nextBody)); err != nil {
			return WikiPageResponse{}, err
		}
	}
	if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, repository.ID); err != nil {
		return WikiPageResponse{}, err
	}
	updated, err := s.queries.UpdateWikiPage(ctx, db.UpdateWikiPageParams{
		ID:               existing.ID,
		ExpectedRevision: existing.Revision, Path: nextPath,
		Slug:     nextSlug,
		Title:    nextTitle,
		Body:     nextBody,
		AuthorID: actor.ID,
	})
	if err != nil {
		if isWikiPageConflict(err) {
			return WikiPageResponse{}, pkgerrors.Conflict("wiki page already exists")
		}
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return WikiPageResponse{}, pkgerrors.Conflict("wiki changed; reopen it before replacing content")
		}
		return WikiPageResponse{}, pkgerrors.Internal("failed to update wiki page").WithCause(err)
	}

	response := mapWikiPageRecord(updated, actor.Username)
	s.dispatchWikiEvent(ctx, repository, actor, "updated", response)
	return response, nil
}

func (s *WikiService) DeleteWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string) error {
	return s.deleteWikiPage(ctx, actor, owner, repo, slug, nil)
}

// DeleteWikiPageAtRevision deletes the page only while it is still at
// revision, atomically in storage; a page saved since is kept and the call
// returns Conflict.
func (s *WikiService) DeleteWikiPageAtRevision(ctx context.Context, actor *db.User, owner, repo, slug string, revision int64) error {
	return s.deleteWikiPage(ctx, actor, owner, repo, slug, &revision)
}

func (s *WikiService) deleteWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string, expectedRevision *int64) error {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}

	normalizedSlug, err := normalizeWikiSlug(slug)
	if err != nil {
		return err
	}

	existing, err := s.queries.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Slug: normalizedSlug,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("wiki page not found")
		}
		return pkgerrors.Internal("failed to load wiki page").WithCause(err)
	}

	var expected pgtype.Int8
	if expectedRevision != nil {
		if *expectedRevision != existing.Revision {
			return pkgerrors.Conflict("wiki changed; expected_revision does not match")
		}
		expected = pgtype.Int8{Int64: *expectedRevision, Valid: true}
	}
	var deleted int64
	if s.documents != nil {
		deleted, err = s.documents.DeleteWikiPageAsActor(ctx, db.DeleteWikiPageAsActorParams{PageID: existing.ID, ExpectedRevision: expected, ActorID: actor.ID})
	} else {
		deleted, err = s.queries.DeleteWikiPage(ctx, db.DeleteWikiPageParams{ID: existing.ID, ExpectedRevision: expected})
	}
	if err != nil {
		return pkgerrors.Internal("failed to delete wiki page").WithCause(err)
	}
	if deleted == 0 {
		if expectedRevision != nil {
			return pkgerrors.Conflict("wiki changed; expected_revision does not match")
		}
		return pkgerrors.NotFound("wiki page not found")
	}

	s.dispatchWikiEvent(ctx, repository, actor, "deleted", mapWikiPage(existing))
	return nil
}

func mapListedWikiPages(rows []db.ListWikiPagesByRepoRow) []WikiPageResponse {
	items := make([]WikiPageResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, WikiPageResponse{
			ID: row.ID, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Attachment: wikiAttachment(row.Attachment),
			Revision: row.Revision,
			Slug:     row.Slug,
			Title:    row.Title,
			Author: WikiAuthorSummary{
				ID:    row.AuthorID,
				Login: row.AuthorUsername,
			},
			CreatedAt: row.CreatedAt,
			UpdatedAt: row.UpdatedAt,
		})
	}
	return items
}

func mapSearchedWikiPages(rows []db.SearchWikiPagesByRepoRow) []WikiPageResponse {
	items := make([]WikiPageResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, WikiPageResponse{
			ID: row.ID, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Attachment: wikiAttachment(row.Attachment),
			Revision: row.Revision,
			Slug:     row.Slug,
			Title:    row.Title,
			Author: WikiAuthorSummary{
				ID:    row.AuthorID,
				Login: row.AuthorUsername,
			},
			CreatedAt: row.CreatedAt,
			UpdatedAt: row.UpdatedAt,
		})
	}
	return items
}

func mapWikiPage(row db.GetWikiPageBySlugRow) WikiPageResponse {
	return WikiPageResponse{
		ID: row.ID, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Attachment: wikiAttachment(row.Attachment),
		Revision: row.Revision,
		Slug:     row.Slug,
		Title:    row.Title,
		Body:     row.Body,
		Author: WikiAuthorSummary{
			ID:    row.AuthorID,
			Login: row.AuthorUsername,
		},
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}

func mapWikiPageRecord(page db.WikiPage, authorUsername string) WikiPageResponse {
	return WikiPageResponse{
		ID: page.ID, Visibility: page.Visibility, Path: page.Path, ContentDigest: page.ContentDigest, Attachment: wikiAttachment(page.Attachment),
		Revision: page.Revision,
		Slug:     page.Slug,
		Title:    page.Title,
		Body:     page.Body,
		Author: WikiAuthorSummary{
			ID:    page.AuthorID,
			Login: authorUsername,
		},
		CreatedAt: page.CreatedAt,
		UpdatedAt: page.UpdatedAt,
	}
}

func (s *WikiService) dispatchWikiEvent(ctx context.Context, repository db.Repository, actor *db.User, action string, page WikiPageResponse) {
	if s.dispatcher == nil || wikiVisibility(ctx) == "private" {
		return
	}

	payload := webhooks.WikiEventPayload{
		Action: action,
		Page: webhooks.WikiPayload{
			Slug:      page.Slug,
			Title:     page.Title,
			CreatedAt: page.CreatedAt,
			UpdatedAt: page.UpdatedAt,
		},
		Repository: webhooks.RepositoryPayload{
			ID:   repository.ID,
			Name: repository.Name,
		},
		Sender: webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		},
	}
	if err := s.dispatcher.DispatchEvent(ctx, repository.ID, webhooks.EventWiki, payload); err != nil {
		slog.Warn("wiki webhook dispatch failed", "repo_id", repository.ID, "slug", page.Slug, "action", action, "err", err)
	}
}

func (s *WikiService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))
	if lowerOwner == "" {
		return db.Repository{}, pkgerrors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, pkgerrors.BadRequest("repository name is required")
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     lowerOwner,
		LowerName: lowerRepo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func (s *WikiService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
	if repository.IsPublic && wikiVisibility(ctx) == "public" {
		return nil
	}
	if viewer == nil {
		return pkgerrors.Forbidden("permission denied")
	}
	repository.IsPublic = false // Private scope requires explicit membership, never incidental public read.
	allowed, err := s.canReadRepo(ctx, repository, viewer.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *WikiService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	allowed, err := s.canWriteRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *WikiService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *WikiService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

// validateWikiName rejects names containing path traversal sequences (../),
// consecutive slashes (//), null bytes, or invalid UTF-8.
func validateWikiName(name, field string) error {
	// Reject null bytes and invalid UTF-8 in one pass.
	for i := 0; i < len(name); i++ {
		if name[i] == 0 {
			return pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "WikiPage",
				Field:    field,
				Code:     "invalid",
			})
		}
	}
	// strings.ToValidUTF8 returns unchanged input when all bytes are valid.
	if strings.ToValidUTF8(name, "") != name {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WikiPage",
			Field:    field,
			Code:     "invalid",
		})
	}
	if strings.Contains(name, "../") || strings.HasSuffix(name, "..") {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WikiPage",
			Field:    field,
			Code:     "invalid",
		})
	}
	if strings.Contains(name, "//") {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WikiPage",
			Field:    field,
			Code:     "invalid",
		})
	}
	return nil
}

func normalizeWikiTitle(raw string) (string, error) {
	title := strings.TrimSpace(raw)
	if title == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WikiPage",
			Field:    "title",
			Code:     "missing_field",
		})
	}
	if err := validateWikiName(title, "title"); err != nil {
		return "", err
	}
	return title, nil
}

func normalizeWikiSlug(raw string) (string, error) {
	// slugifyWikiTitle strips everything down to [a-z0-9-], so dangerous
	// characters are gone before the name check runs.
	slug := slugifyWikiTitle(strings.TrimSpace(raw))
	if slug == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WikiPage",
			Field:    "slug",
			Code:     "invalid",
		})
	}
	return slug, nil
}

// ListWikiRevisions returns the revision history for a wiki page ordered newest-first.
// Each entry is an immutable stored revision; pagination never fabricates the
// current page as a substitute for its history.
func (s *WikiService) ListWikiRevisions(ctx context.Context, viewer *db.User, owner, repo, slug string, page, perPage int) ([]WikiRevisionResponse, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, 0, err
	}

	normalizedSlug, err := normalizeWikiSlug(slug)
	if err != nil {
		return nil, 0, err
	}

	current, err := s.queries.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{
		RepositoryID: repository.ID, Visibility: wikiVisibility(ctx),
		Slug: normalizedSlug,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, 0, pkgerrors.NotFound("wiki page not found")
		}
		return nil, 0, pkgerrors.Internal("failed to load wiki page").WithCause(err)
	}

	if s.documents == nil {
		return nil, 0, wikiUnavailable("wiki history is unavailable")
	}
	return s.wikiHistory(ctx, repository.ID, current.ID, page, perPage)
}

func slugifyWikiTitle(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastWasDash := false
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
			lastWasDash = false
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
			lastWasDash = false
		default:
			if !lastWasDash && builder.Len() > 0 {
				builder.WriteByte('-')
				lastWasDash = true
			}
		}
	}
	return strings.Trim(builder.String(), "-")
}

func isWikiPageConflict(err error) bool {
	var pgErr *pgconn.PgError
	return stdErrors.As(err, &pgErr) && pgErr.Code == "23505"
}
