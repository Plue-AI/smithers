package services

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type WikiCollaborationStore interface {
	DeleteWikiPageAsActor(context.Context, db.DeleteWikiPageAsActorParams) (int64, error)
	InitializeWikiDocument(context.Context, db.InitializeWikiDocumentParams) (int64, error)
	GetWikiPageIdentity(context.Context, db.GetWikiPageIdentityParams) (db.GetWikiPageIdentityRow, error)
	GetWikiDocument(context.Context, db.GetWikiDocumentParams) (db.GetWikiDocumentRow, error)
	WriteWikiDocument(context.Context, db.WriteWikiDocumentParams) (db.WikiPage, error)
	CountWikiRevisions(context.Context, db.CountWikiRevisionsParams) (int64, error)
	ListWikiRevisions(context.Context, db.ListWikiRevisionsParams) ([]db.WikiPageRevision, error)
}

type WikiDocumentHost interface {
	MergeWikiDocument(context.Context, string, string, repohost.WikiDocumentRequest) (repohost.WikiDocumentResult, error)
}

type WikiServiceOption func(*WikiService)

func wikiUnavailable(message string) error {
	return &pkgerrors.APIError{Status: http.StatusServiceUnavailable, Code: pkgerrors.CodeWikiUnavailable, Message: message, RetryAfter: 1}
}

func WithWikiCollaboration(store WikiCollaborationStore, host WikiDocumentHost) WikiServiceOption {
	return func(s *WikiService) { s.documents, s.documentHost = store, host }
}

type WikiDocumentResponse struct {
	Page        WikiPageResponse `json:"page"`
	State       string           `json:"state"`
	StateVector string           `json:"state_vector"`
}

// The document state and rendered body are accepted in one revision-checked
// write. Merging happens outside Postgres; a competing writer causes a fresh
// merge over its state. There is no additional connection, queue, or job ledger.
func (s *WikiService) GetWikiDocument(ctx context.Context, viewer *db.User, owner, repo, slug string) (WikiDocumentResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiDocumentResponse{}, err
	}
	ctx, err = s.admitExecutionWikiRead(ctx, viewer, repository.ID, "wiki.document", slug)
	if err != nil {
		return WikiDocumentResponse{}, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return WikiDocumentResponse{}, err
	}
	row, err := s.initializedWikiDocument(ctx, owner, repo, repository.ID, slug)
	if err != nil {
		return WikiDocumentResponse{}, err
	}
	current, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiDocumentResponse{}, err
	}
	if current.ID != repository.ID {
		return WikiDocumentResponse{}, pkgerrors.Conflict("repository was replaced")
	}
	if err = s.requireReadAccess(ctx, current, viewer); err != nil {
		return WikiDocumentResponse{}, err
	}
	return documentResponse(row), nil
}

func (s *WikiService) initializedWikiDocument(ctx context.Context, owner, repo string, repoID int64, slug string) (db.GetWikiDocumentRow, error) {
	if s.documents == nil || s.documentHost == nil {
		return db.GetWikiDocumentRow{}, wikiUnavailable("wiki collaboration is unavailable")
	}
	normalized, err := normalizeWikiSlug(slug)
	if err != nil {
		return db.GetWikiDocumentRow{}, err
	}
	for attempt := 0; attempt < 8; attempt++ {
		row, err := s.documents.GetWikiDocument(ctx, db.GetWikiDocumentParams{RepositoryID: repoID, Visibility: wikiVisibility(ctx), Slug: normalized})
		if errors.Is(err, pgx.ErrNoRows) {
			return row, pkgerrors.NotFound("wiki page not found")
		}
		if err != nil {
			return row, pkgerrors.Internal("failed to read wiki document").WithCause(err)
		}
		if len(row.Attachment) > 0 {
			return row, pkgerrors.BadRequest("attachments have no collaborative document")
		}
		if row.CrdtState != nil {
			return row, nil
		}
		seed, err := s.mergeWikiDocument(ctx, owner, repo, repohost.WikiDocumentRequest{Operation: "seed", Markdown: &row.Body})
		if err != nil {
			return row, err
		}
		args, err := documentWrite(row, seed, pgtype.UUID{}, nil, row.AuthorID)
		if err != nil {
			return row, err
		}
		_, err = s.documents.InitializeWikiDocument(ctx, db.InitializeWikiDocumentParams{
			PageID: args.PageID, RepositoryID: args.RepositoryID, ExpectedRevision: args.ExpectedRevision,
			CrdtState: args.CrdtState, CrdtVector: args.CrdtVector,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return row, pkgerrors.Internal("failed to initialize wiki document").WithCause(err)
		}
		// Read back the winning state. A concurrent seed must never produce two
		// independent copies of the original text in different clients.
	}
	return db.GetWikiDocumentRow{}, pkgerrors.Conflict("wiki changed repeatedly; retry document initialization")
}

func (s *WikiService) mergeWikiDocument(ctx context.Context, owner, repo string, input repohost.WikiDocumentRequest) (repohost.WikiDocumentResult, error) {
	result, err := s.documentHost.MergeWikiDocument(ctx, owner, repo, input)
	if err != nil {
		var status *repohost.StatusError
		if errors.As(err, &status) && (status.StatusCode == http.StatusBadRequest || status.StatusCode == http.StatusUnprocessableEntity) {
			return result, pkgerrors.BadRequest("invalid wiki document update")
		}
		return result, wikiUnavailable("wiki merge is unavailable; retry the same update")
	}
	return result, nil
}

func documentWrite(row db.GetWikiDocumentRow, merged repohost.WikiDocumentResult, id pgtype.UUID, update []byte, authorID int64) (db.WriteWikiDocumentParams, error) {
	state, err := base64.StdEncoding.DecodeString(merged.State)
	if err != nil || len(state) == 0 || len(state) > 8<<20 {
		return db.WriteWikiDocumentParams{}, pkgerrors.Internal("wiki merge returned invalid state")
	}
	vector, err := base64.StdEncoding.DecodeString(merged.StateVector)
	if err != nil || len(vector) == 0 || len(merged.Markdown) > maxWikiBodyBytes || strings.ToValidUTF8(merged.Markdown, "") != merged.Markdown {
		return db.WriteWikiDocumentParams{}, pkgerrors.Internal("wiki merge returned invalid content")
	}
	return db.WriteWikiDocumentParams{PageID: row.ID, RepositoryID: row.RepositoryID, ExpectedRevision: row.Revision,
		Body: merged.Markdown, CrdtState: state, CrdtVector: vector, UpdateID: id, UpdateBytes: update,
		AuthorID: authorID, Title: row.Title, Slug: row.Slug, Path: row.Path}, nil
}

func documentResponse(row db.GetWikiDocumentRow) WikiDocumentResponse {
	return WikiDocumentResponse{
		Page: WikiPageResponse{ID: row.ID, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Slug: row.Slug, Title: row.Title, TitleSource: row.TitleSource, Body: row.Body, Revision: row.Revision,
			Author: WikiAuthorSummary{ID: row.AuthorID, Login: row.AuthorUsername}, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt},
		State: base64.StdEncoding.EncodeToString(row.CrdtState), StateVector: base64.StdEncoding.EncodeToString(row.CrdtVector),
	}
}

// Whole-document REST replacement needs an explicit revision once collaborative
// editing has started. Live co-editing requires the shared document channel.
func (s *WikiService) replaceCollaborativeWikiPage(ctx context.Context, actor *db.User, owner, repo string, pageID, repoID int64, currentSlug, nextSlug, nextTitle, nextPath string, input UpdateWikiPageInput) (WikiPageResponse, bool, error) {
	row, err := s.documents.GetWikiDocument(ctx, db.GetWikiDocumentParams{RepositoryID: repoID, Visibility: wikiVisibility(ctx), Slug: currentSlug})
	if errors.Is(err, pgx.ErrNoRows) {
		return WikiPageResponse{}, true, pkgerrors.NotFound("wiki page not found")
	}
	if err != nil {
		return WikiPageResponse{}, true, pkgerrors.Internal("failed to read wiki document").WithCause(err)
	}
	if row.ID != pageID {
		return WikiPageResponse{}, true, pkgerrors.Conflict("wiki page was replaced")
	}
	if row.CrdtState == nil {
		return WikiPageResponse{}, false, nil
	}
	if input.ExpectedRevision == nil || *input.ExpectedRevision != row.Revision {
		return WikiPageResponse{}, true, pkgerrors.Conflict("expected_revision is required to replace collaborative content; reopen or send a CRDT update")
	}
	if s.documentHost == nil {
		return WikiPageResponse{}, true, wikiUnavailable("wiki collaboration is unavailable")
	}
	merged := repohost.WikiDocumentResult{State: base64.StdEncoding.EncodeToString(row.CrdtState), StateVector: base64.StdEncoding.EncodeToString(row.CrdtVector), Markdown: row.Body}
	if input.Body != nil {
		merged, err = s.mergeWikiDocument(ctx, owner, repo, repohost.WikiDocumentRequest{Operation: "replace", State: merged.State, Markdown: input.Body})
		if err != nil {
			return WikiPageResponse{}, true, err
		}
	}
	args, err := documentWrite(row, merged, pgtype.UUID{}, nil, actor.ID)
	if err != nil {
		return WikiPageResponse{}, true, err
	}
	args.Title, args.Slug, args.Path, args.UpdateBytes = nextTitle, nextSlug, nextPath, args.CrdtState
	args.TitleSource = wikiTitleSourceUpdate(input)
	currentRepo, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiPageResponse{}, true, err
	}
	if currentRepo.ID != repoID {
		return WikiPageResponse{}, true, pkgerrors.Conflict("repository was replaced")
	}
	if err = s.requireWriteAccess(ctx, currentRepo, actor); err != nil {
		return WikiPageResponse{}, true, err
	}
	if _, err = s.putWikiContent(ctx, repoID, []byte(args.Body)); err != nil {
		return WikiPageResponse{}, true, err
	}
	if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, repoID); err != nil {
		return WikiPageResponse{}, true, err
	}
	written, err := s.documents.WriteWikiDocument(ctx, args)
	if errors.Is(err, pgx.ErrNoRows) || isWikiPageConflict(err) {
		return WikiPageResponse{}, true, pkgerrors.Conflict("wiki changed; reopen before replacing content")
	}
	if err != nil {
		return WikiPageResponse{}, true, pkgerrors.Internal("failed to store wiki document").WithCause(err)
	}
	return mapWikiPageRecord(written, actor.Username), true, nil
}
