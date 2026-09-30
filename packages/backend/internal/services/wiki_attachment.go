package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type WikiAttachment struct {
	Digest    string `json:"digest"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
}
type PutWikiAttachmentInput struct {
	Path             string
	MediaType        string
	ExpectedRevision int64
	Data             []byte
}
type WikiContent struct {
	Data      []byte
	Path      string
	MediaType string
	Digest    string
}
type wikiAttachmentStore interface {
	CreateWikiAttachment(context.Context, db.CreateWikiAttachmentParams) (db.WikiPage, error)
	UpdateWikiAttachment(context.Context, db.UpdateWikiAttachmentParams) (db.WikiPage, error)
	GetWikiRevisionByNumber(context.Context, db.GetWikiRevisionByNumberParams) (db.WikiPageRevision, error)
}

func wikiAttachment(data []byte) *WikiAttachment {
	if len(data) == 0 {
		return nil
	}
	var value WikiAttachment
	if json.Unmarshal(data, &value) != nil {
		return nil
	}
	return &value
}
func normalizeWikiAttachmentPath(value string) (string, error) {
	if value == "" || len(value) > 1024 || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00\r\n") || strings.HasPrefix(value, "/") || path.Clean(value) != value || isWikiMarkdownPath(value) {
		return "", pkgerrors.BadRequest("attachment path must be a relative non-Markdown filename")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == "." || strings.TrimSpace(part) == "" {
			return "", pkgerrors.BadRequest("invalid attachment path")
		}
	}
	return value, nil
}

// WikiAttachmentSlug is the one slug a new attachment may take: its path's
// slug (lowercase ASCII letters and digits; every other run is one "-"), then
// "-" and the first 12 hex digits of its bytes' SHA-256. A client derives it
// before writing; a new file at a renamed attachment's old path gets its own.
// Later writes address the attachment's existing slug, which a rename keeps.
func WikiAttachmentSlug(filename, digest string) string {
	base := slugifyWikiTitle(filename)
	if base == "" {
		base = "attachment"
	}
	return base + "-" + digest[:12]
}

func (s *WikiService) PutWikiAttachment(ctx context.Context, actor *db.User, owner, repo, slug string, input PutWikiAttachmentInput) (WikiPageResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if err = s.requireWriteAccess(ctx, repository, actor); err != nil {
		return WikiPageResponse{}, err
	}
	slug, err = normalizeWikiSlug(slug)
	if err != nil {
		return WikiPageResponse{}, err
	}
	filename, err := normalizeWikiAttachmentPath(input.Path)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if len(input.Data) > maxWikiAttachmentBytes || input.ExpectedRevision < 0 {
		return WikiPageResponse{}, pkgerrors.BadRequest("invalid attachment size or revision")
	}
	media, _, err := mime.ParseMediaType(input.MediaType)
	if err != nil {
		return WikiPageResponse{}, pkgerrors.BadRequest("invalid attachment media type")
	}
	store, ok := s.queries.(wikiAttachmentStore)
	if !ok {
		return WikiPageResponse{}, wikiUnavailable("wiki attachments are unavailable")
	}
	current, err := s.queries.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), Slug: slug})
	missing := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !missing {
		return WikiPageResponse{}, pkgerrors.Internal("failed to read attachment").WithCause(err)
	}
	if derived := WikiAttachmentSlug(filename, wikiDigest(input.Data)); missing && slug != derived {
		return WikiPageResponse{}, pkgerrors.BadRequest(fmt.Sprintf("a new attachment's slug must be %q", derived))
	}
	if (missing && input.ExpectedRevision != 0) || (!missing && (input.ExpectedRevision != current.Revision || len(current.Attachment) == 0)) {
		return WikiPageResponse{}, pkgerrors.Conflict("attachment changed; expected_revision must match")
	}
	digest, err := s.putWikiContent(ctx, repository.ID, input.Data)
	if err != nil {
		return WikiPageResponse{}, err
	}
	if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, repository.ID); err != nil {
		return WikiPageResponse{}, err
	}
	metadata, _ := json.Marshal(WikiAttachment{Digest: digest, MediaType: media, Size: int64(len(input.Data))})
	var written db.WikiPage
	if missing {
		written, err = store.CreateWikiAttachment(ctx, db.CreateWikiAttachmentParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), Slug: slug, Path: filename, Title: path.Base(filename), AuthorID: actor.ID, Attachment: metadata})
	} else {
		written, err = store.UpdateWikiAttachment(ctx, db.UpdateWikiAttachmentParams{PageID: current.ID, RepositoryID: repository.ID, ExpectedRevision: current.Revision, Path: filename, Title: path.Base(filename), AuthorID: actor.ID, Attachment: metadata})
	}
	if errors.Is(err, pgx.ErrNoRows) || isWikiPageConflict(err) {
		return WikiPageResponse{}, pkgerrors.Conflict("attachment changed or path exists")
	}
	if err != nil {
		return WikiPageResponse{}, pkgerrors.Internal("failed to store attachment").WithCause(err)
	}
	response := mapWikiPageRecord(written, actor.Username)
	action := "updated"
	if missing {
		action = "created"
	}
	s.dispatchWikiEvent(ctx, repository, actor, action, response)
	return response, nil
}

// Every digest read starts with a repository- and visibility-scoped revision.
// Possession of a digest never authorizes access, even to identical bytes.
func (s *WikiService) GetWikiRevisionContent(ctx context.Context, viewer *db.User, owner, repo string, pageID, revision int64) (WikiContent, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiContent{}, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return WikiContent{}, err
	}
	if pageID <= 0 || revision <= 0 {
		return WikiContent{}, pkgerrors.BadRequest("positive page_id and revision are required")
	}
	store, ok := s.queries.(wikiAttachmentStore)
	if !ok {
		return WikiContent{}, wikiUnavailable("wiki content is unavailable")
	}
	row, err := store.GetWikiRevisionByNumber(ctx, db.GetWikiRevisionByNumberParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), PageID: pageID, Revision: revision})
	if errors.Is(err, pgx.ErrNoRows) {
		return WikiContent{}, pkgerrors.NotFound("wiki revision not found")
	}
	if err != nil {
		return WikiContent{}, pkgerrors.Internal("failed to read wiki revision").WithCause(err)
	}
	media := "text/markdown; charset=utf-8"
	if attachment := wikiAttachment(row.Attachment); attachment != nil {
		media = attachment.MediaType
	} else {
		if err = s.materializeWikiMarkdown(ctx, repository.ID, row.Body, row.ContentDigest); err != nil {
			return WikiContent{}, err
		}
	}
	data, err := s.readWikiContent(ctx, repository.ID, row.ContentDigest)
	if err != nil {
		return WikiContent{}, wikiUnavailable("wiki content is unavailable or corrupt")
	}
	if err = s.wikiReadStillAuthorized(ctx, viewer, owner, repo, repository.ID); err != nil {
		return WikiContent{}, err
	}
	return WikiContent{Data: data, Path: row.Path, MediaType: media, Digest: row.ContentDigest}, nil
}
