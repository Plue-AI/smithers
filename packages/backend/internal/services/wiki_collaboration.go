package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
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
	GetWikiUpdateReceipt(context.Context, db.GetWikiUpdateReceiptParams) (db.WikiPageRevision, error)
	CountWikiRevisions(context.Context, db.CountWikiRevisionsParams) (int64, error)
	ListWikiRevisions(context.Context, db.ListWikiRevisionsParams) ([]db.WikiPageRevision, error)
	ListWikiUpdatesAfter(context.Context, db.ListWikiUpdatesAfterParams) ([]db.WikiPageRevision, error)
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

type WikiUpdateInput struct {
	PageID   int64  `json:"page_id"`
	UpdateID string `json:"update_id"`
	Update   string `json:"update"`
}

type WikiUpdateResponse struct {
	Document         WikiDocumentResponse `json:"document"`
	UpdateID         string               `json:"update_id"`
	AcceptedRevision int64                `json:"accepted_revision"`
}

// The document state and rendered body are accepted in one revision-checked
// write. Merging happens outside Postgres; a competing writer causes a fresh
// merge over its state. There is no additional connection, queue, or job ledger.
func (s *WikiService) GetWikiDocument(ctx context.Context, viewer *db.User, owner, repo, slug string) (WikiDocumentResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
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

func (s *WikiService) ApplyWikiUpdate(ctx context.Context, actor *db.User, owner, repo, slug string, input WikiUpdateInput) (WikiUpdateResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return WikiUpdateResponse{}, err
	}
	if err = s.requireWriteAccess(ctx, repository, actor); err != nil {
		return WikiUpdateResponse{}, err
	}
	id, err := uuid.Parse(input.UpdateID)
	if err != nil || id == uuid.Nil || input.PageID <= 0 {
		return WikiUpdateResponse{}, pkgerrors.BadRequest("page_id and a nonzero UUID update_id are required")
	}
	if len(input.Update) > 4*((maxWikiBodyBytes+2)/3) {
		return WikiUpdateResponse{}, pkgerrors.BadRequest("wiki update exceeds 1 MiB")
	}
	update, err := base64.StdEncoding.DecodeString(input.Update)
	if err != nil || len(update) == 0 || len(update) > maxWikiBodyBytes {
		return WikiUpdateResponse{}, pkgerrors.BadRequest("wiki update must be Yjs v1 base64 of at most 1 MiB")
	}
	updateID := pgtype.UUID{Bytes: id, Valid: true}
	for attempt := 0; attempt < 8; attempt++ {
		row, err := s.initializedWikiDocument(ctx, owner, repo, repository.ID, slug)
		if err != nil {
			return WikiUpdateResponse{}, err
		}
		// Slugs can be reused after deletion. The original page ID fences an
		// offline editor from writing into the replacement page.
		if row.ID != input.PageID {
			return WikiUpdateResponse{}, pkgerrors.Conflict("wiki page was replaced; reopen it before editing")
		}
		receipt, err := s.documents.GetWikiUpdateReceipt(ctx, db.GetWikiUpdateReceiptParams{PageID: row.ID, UpdateID: updateID})
		if err == nil {
			if receipt.RepositoryID != repository.ID || !receipt.AuthorID.Valid || receipt.AuthorID.Int64 != actor.ID || !bytes.Equal(receipt.UpdateBytes, update) {
				return WikiUpdateResponse{}, pkgerrors.Conflict("update_id already belongs to a different edit")
			}
			return WikiUpdateResponse{Document: documentResponse(row), UpdateID: id.String(), AcceptedRevision: receipt.Revision}, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return WikiUpdateResponse{}, pkgerrors.Internal("failed to read wiki update receipt")
		}
		merged, err := s.mergeWikiDocument(ctx, owner, repo, repohost.WikiDocumentRequest{
			Operation: "apply", State: base64.StdEncoding.EncodeToString(row.CrdtState), Update: input.Update,
		})
		if err != nil {
			return WikiUpdateResponse{}, err
		}
		args, err := documentWrite(row, merged, updateID, update, actor.ID)
		if err != nil {
			return WikiUpdateResponse{}, err
		}
		// Recheck current repository authorization after the remote merge.
		currentRepo, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
		if err != nil {
			return WikiUpdateResponse{}, err
		}
		if currentRepo.ID != repository.ID {
			return WikiUpdateResponse{}, pkgerrors.Conflict("repository was replaced")
		}
		if err = s.requireWriteAccess(ctx, currentRepo, actor); err != nil {
			return WikiUpdateResponse{}, err
		}
		if _, err = s.putWikiContent(ctx, repository.ID, []byte(args.Body)); err != nil {
			return WikiUpdateResponse{}, err
		}
		if err = s.wikiWriteStillAuthorized(ctx, actor, owner, repo, repository.ID); err != nil {
			return WikiUpdateResponse{}, err
		}
		written, err := s.documents.WriteWikiDocument(ctx, args)
		if errors.Is(err, pgx.ErrNoRows) || isWikiPageConflict(err) {
			continue
		}
		if err != nil {
			return WikiUpdateResponse{}, pkgerrors.Internal("failed to store wiki update").WithCause(err)
		}
		response := WikiDocumentResponse{Page: mapWikiPageRecord(written, actor.Username), State: merged.State, StateVector: merged.StateVector}
		s.dispatchWikiEvent(ctx, currentRepo, actor, "updated", response.Page)
		return WikiUpdateResponse{Document: response, UpdateID: id.String(), AcceptedRevision: written.Revision}, nil
	}
	return WikiUpdateResponse{}, pkgerrors.Conflict("wiki changed repeatedly; retry the same update_id")
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
		Page: WikiPageResponse{ID: row.ID, Visibility: row.Visibility, Path: row.Path, ContentDigest: row.ContentDigest, Slug: row.Slug, Title: row.Title, Body: row.Body, Revision: row.Revision,
			Author: WikiAuthorSummary{ID: row.AuthorID, Login: row.AuthorUsername}, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt},
		State: base64.StdEncoding.EncodeToString(row.CrdtState), StateVector: base64.StdEncoding.EncodeToString(row.CrdtVector),
	}
}

// Whole-document REST replacement needs an explicit revision once collaborative
// editing has started. Concurrent editors use ApplyWikiUpdate instead.
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

// Revisions are real stored snapshots, including deletions and metadata edits.
// The cursor is the per-page revision: unlike global sequence IDs, row-locked revisions commit in order.
type WikiUpdateEvent struct {
	ID       int64  `json:"id"`
	PageID   int64  `json:"page_id"`
	Revision int64  `json:"revision"`
	UpdateID string `json:"update_id,omitempty"`
	Deleted  bool   `json:"deleted"`
	Slug     string `json:"slug"`
}

// WikiUpdatePageSize is the most updates one ListWikiUpdates call returns. A
// shorter page means the caller has reached the end of the stream.
const WikiUpdatePageSize = 100

// ListWikiUpdates returns up to WikiUpdatePageSize committed updates after
// afterID, oldest first.
func (s *WikiService) ListWikiUpdates(ctx context.Context, viewer *db.User, owner, repo, slug string, pageID, afterID int64) ([]WikiUpdateEvent, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err = s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, err
	}
	if s.documents == nil {
		return nil, wikiUnavailable("wiki collaboration is unavailable")
	}
	if pageID <= 0 || afterID < 0 {
		return nil, pkgerrors.BadRequest("invalid wiki update cursor")
	}
	normalized, err := normalizeWikiSlug(slug)
	if err != nil {
		return nil, err
	}
	_, err = s.documents.GetWikiPageIdentity(ctx, db.GetWikiPageIdentityParams{RepositoryID: repository.ID, Visibility: wikiVisibility(ctx), PageID: pageID, Slug: normalized})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, pkgerrors.NotFound("wiki page not found")
	}
	if err != nil {
		return nil, pkgerrors.Internal("failed to read wiki page identity").WithCause(err)
	}

	// An established stream can replay the tombstone after the page is gone.
	// Repository scoping in the query prevents another repo's IDs leaking.
	rows, err := s.documents.ListWikiUpdatesAfter(ctx, db.ListWikiUpdatesAfterParams{RepositoryID: repository.ID, PageID: pageID, Revision: afterID, Limit: WikiUpdatePageSize})
	if err != nil {
		return nil, pkgerrors.Internal("failed to read wiki updates").WithCause(err)
	}
	out := make([]WikiUpdateEvent, 0, len(rows))
	for _, row := range rows {
		event := WikiUpdateEvent{ID: row.Revision, PageID: row.PageID, Revision: row.Revision, Deleted: row.Deleted, Slug: row.Slug}
		if row.UpdateID.Valid {
			event.UpdateID = uuid.UUID(row.UpdateID.Bytes).String()
		}
		out = append(out, event)
	}
	return out, nil
}
