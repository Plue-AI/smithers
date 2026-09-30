package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type WikiEvent struct {
	Version       int               `json:"version"`
	Sequence      int64             `json:"sequence"`
	PageID        int64             `json:"page_id"`
	Revision      int64             `json:"revision"`
	Visibility    string            `json:"visibility"`
	Slug          string            `json:"slug"`
	Path          string            `json:"path"`
	TitleSource   string            `json:"title_source,omitempty"`
	Title         string            `json:"title"`
	ContentDigest string            `json:"content_digest"`
	Attachment    *WikiAttachment   `json:"attachment,omitempty"`
	Deleted       bool              `json:"deleted"`
	Author        WikiAuthorSummary `json:"author"`
	At            time.Time         `json:"at"`
}
type WikiProjection struct {
	Sequence int64               `json:"sequence"`
	Pages    map[int64]WikiEvent `json:"pages"`
}

// FoldWikiEvents is a pure, replayable projection. Snapshots plus a suffix have
// the same result as the full stream. Old deliveries are harmless; a gap or an
// unknown event version refuses to manufacture an apparently current index.
func FoldWikiEvents(state WikiProjection, events []WikiEvent) (WikiProjection, error) {
	next := WikiProjection{Sequence: state.Sequence, Pages: map[int64]WikiEvent{}}
	for id, page := range state.Pages {
		next.Pages[id] = page
	}
	for _, event := range events {
		if event.Sequence <= next.Sequence {
			continue
		}
		if event.Version != 1 || event.Sequence != next.Sequence+1 || event.PageID <= 0 || event.Revision <= 0 {
			return state, fmt.Errorf("invalid wiki event at sequence %d", event.Sequence)
		}
		if event.Deleted {
			delete(next.Pages, event.PageID)
		} else {
			next.Pages[event.PageID] = event
		}
		next.Sequence = event.Sequence
	}
	return next, nil
}
func wikiEvent(row db.WikiPageRevision) WikiEvent {
	return WikiEvent{Version: 1, Sequence: row.Sequence, PageID: row.PageID, Revision: row.Revision, Visibility: row.Visibility, Slug: row.Slug, Path: row.Path, Title: row.Title, TitleSource: row.TitleSource, ContentDigest: row.ContentDigest, Attachment: wikiAttachment(row.Attachment), Deleted: row.Deleted, Author: WikiAuthorSummary{ID: row.AuthorID.Int64, Login: row.AuthorUsername}, At: row.CreatedAt.UTC()}
}

type wikiEventStore interface {
	ListWikiEvents(context.Context, db.ListWikiEventsParams) ([]db.WikiPageRevision, error)
	GetWikiLatestRevision(context.Context, db.GetWikiLatestRevisionParams) (db.WikiPageRevision, error)
}

func (s *WikiService) ListWikiEvents(ctx context.Context, viewer *db.User, owner, repo string, after int64) ([]WikiEvent, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, err
	}
	if after < 0 {
		return nil, pkgerrors.BadRequest("after must be nonnegative")
	}
	store, ok := s.queries.(wikiEventStore)
	if !ok {
		return nil, wikiUnavailable("wiki events are unavailable")
	}
	rows, err := store.ListWikiEvents(ctx, db.ListWikiEventsParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), Sequence: after, Limit: 100})
	if err != nil {
		return nil, pkgerrors.Internal("failed to read wiki events").WithCause(err)
	}
	out := make([]WikiEvent, 0, len(rows))
	for _, row := range rows {
		if len(row.Attachment) == 0 {
			if err = s.materializeWikiMarkdown(ctx, repository.ID, row.Body, row.ContentDigest); err != nil {
				return nil, err
			}
		}
		out = append(out, wikiEvent(row))
	}
	if err = s.wikiReadStillAuthorized(ctx, viewer, owner, repo, repository.ID); err != nil {
		return nil, err
	}
	return out, nil
}
func (s *WikiService) ListWikiPageHistory(ctx context.Context, viewer *db.User, owner, repo string, pageID int64, page, perPage int) ([]WikiRevisionResponse, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, 0, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, 0, err
	}
	store, ok := s.queries.(wikiEventStore)
	if !ok || s.documents == nil {
		return nil, 0, wikiUnavailable("wiki history is unavailable")
	}
	_, err = store.GetWikiLatestRevision(ctx, db.GetWikiLatestRevisionParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), PageID: pageID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, pkgerrors.NotFound("wiki page not found")
	}
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to read wiki history").WithCause(err)
	}
	return s.wikiHistory(ctx, repository.ID, pageID, page, perPage)
}
func (s *WikiService) wikiHistory(ctx context.Context, repoID, pageID int64, page, perPage int) ([]WikiRevisionResponse, int64, error) {
	size, offset, _, _ := normalizePage(page, perPage)
	total, err := s.documents.CountWikiRevisions(ctx, db.CountWikiRevisionsParams{RepositoryID: repoID, PageID: pageID})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count wiki revisions").WithCause(err)
	}
	rows, err := s.documents.ListWikiRevisions(ctx, db.ListWikiRevisionsParams{RepositoryID: repoID, PageID: pageID, Limit: size, Offset: offset})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list wiki revisions").WithCause(err)
	}
	revisions := make([]WikiRevisionResponse, 0, len(rows))
	for _, row := range rows {
		revisions = append(revisions, WikiRevisionResponse{ID: row.ID, PageID: row.PageID, Revision: row.Revision, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Attachment: wikiAttachment(row.Attachment), Slug: row.Slug, Title: row.Title, Body: row.Body, Deleted: row.Deleted, HistoryCommitID: row.HistoryCommitID, Author: WikiAuthorSummary{ID: row.AuthorID.Int64, Login: row.AuthorUsername}, UpdatedAt: row.CreatedAt})
	}
	return revisions, total, nil
}
