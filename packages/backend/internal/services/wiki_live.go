package services

import (
	"context"
	"encoding/base64"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// OpenLiveWiki reuses the page's existing visibility and repository gates.
func (s *WikiService) OpenLiveWiki(ctx context.Context, actor *db.User, owner, repo, slug, visibility string, page int64, write bool) (db.GetWikiDocumentRow, error) {
	ctx, err := WithWikiVisibility(ctx, visibility)
	if err != nil {
		return db.GetWikiDocumentRow{}, err
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.GetWikiDocumentRow{}, err
	}
	if write {
		err = s.requireWriteAccess(ctx, repository, actor)
	} else {
		err = s.requireReadAccess(ctx, repository, actor)
	}
	if err != nil {
		return db.GetWikiDocumentRow{}, err
	}
	row, err := s.initializedWikiDocument(ctx, owner, repo, repository.ID, slug)
	if err == nil && row.ID != page {
		err = errors.New("wiki page replaced")
	}
	return row, err
}

// CommitLiveWiki returns only after the revision-checked SQL write commits.
// A conflict merges the persisted CRDT, never rendered Markdown, and retries.
func (s *WikiService) CommitLiveWiki(ctx context.Context, actor *db.User, owner, repo string, row db.GetWikiDocumentRow, state, vector []byte, text string, merge func([]byte, []byte) ([]byte, []byte, string, error)) (db.GetWikiDocumentRow, error) {
	ctx, err := WithWikiVisibility(ctx, row.Visibility)
	if err != nil {
		return row, err
	}
	merged := repohost.WikiDocumentResult{State: base64.StdEncoding.EncodeToString(state), StateVector: base64.StdEncoding.EncodeToString(vector), Markdown: text}
	for attempt := 0; attempt < 8; attempt++ {
		if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, row.RepositoryID); err != nil {
			return row, err
		}
		args, e := documentWrite(row, merged, pgtype.UUID{}, state, actor.ID)
		if e != nil {
			return row, e
		}
		if _, e = s.putWikiContent(ctx, row.RepositoryID, []byte(merged.Markdown)); e != nil {
			return row, e
		}
		if e = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, row.RepositoryID); e != nil {
			return row, e
		}
		written, e := s.documents.WriteWikiDocument(ctx, args)
		if e == nil {
			row.Revision, row.Body, row.CrdtState, row.CrdtVector = written.Revision, written.Body, written.CrdtState, written.CrdtVector
			return row, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return row, e
		}
		current, e := s.documents.GetWikiDocument(ctx, db.GetWikiDocumentParams{RepositoryID: row.RepositoryID, Slug: row.Slug, Visibility: row.Visibility})
		if e != nil || current.ID != row.ID {
			return row, errors.New("wiki page gone")
		}
		local, e := base64.StdEncoding.DecodeString(merged.State)
		if e != nil {
			return row, e
		}
		state, vector, text, e = merge(current.CrdtState, local)
		if e != nil {
			return row, e
		}
		merged = repohost.WikiDocumentResult{State: base64.StdEncoding.EncodeToString(state), StateVector: base64.StdEncoding.EncodeToString(vector), Markdown: text}

		row = current
	}
	return row, errors.New("wiki revision contention")
}
