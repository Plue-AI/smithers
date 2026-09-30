package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type IssueStateFactQueries interface {
	GetIssueStateJournal(context.Context, int64) (db.IssueStateJournal, error)
	ListIssueStateFacts(context.Context, db.ListIssueStateFactsParams) ([]db.IssueStateFact, error)
}
type IssueStateFactPage struct {
	SchemaVersion int16                    `json:"schema_version"`
	StreamID      string                   `json:"stream_id"`
	Events        []IssueStateFact         `json:"events"`
	Cursor        int64                    `json:"cursor"`
	Head          int64                    `json:"head"`
	HasMore       bool                     `json:"has_more"`
	Coverage      NotificationFactCoverage `json:"coverage"`
}

func (s *IssueEventService) AuthorizeIssueState(ctx context.Context, viewer *db.User, owner, name string) (db.Repository, error) {
	repo, err := s.resolveRepo(ctx, owner, name)
	if err != nil {
		return db.Repository{}, err
	}
	if err := s.requireRead(ctx, repo, viewer); err != nil {
		return db.Repository{}, err
	}
	return repo, nil
}

// Every page re-resolves repository identity and permissions. Repository IDs in
// the query and each fact prevent history crossing a rename/name-reuse scope.
func (s *IssueEventService) ListIssueStateFacts(ctx context.Context, viewer *db.User, owner, name string, expectedRepo, after int64, limit int) (IssueStateFactPage, error) {
	repo, err := s.AuthorizeIssueState(ctx, viewer, owner, name)
	if err != nil {
		return IssueStateFactPage{}, err
	}
	if expectedRepo != 0 && repo.ID != expectedRepo {
		return IssueStateFactPage{}, pkgerrors.Conflict("issue stream repository changed")
	}
	if after < 0 {
		return IssueStateFactPage{}, pkgerrors.BadRequest("invalid issue journal cursor")
	}
	if limit < 1 || limit > 1000 {
		limit = 1000
	}
	q, ok := s.queries.(IssueStateFactQueries)
	if !ok {
		return IssueStateFactPage{}, pkgerrors.Internal("issue journal unavailable")
	}
	page := IssueStateFactPage{SchemaVersion: 1, StreamID: fmt.Sprintf("issues:%d", repo.ID), Cursor: after, Events: []IssueStateFact{}, Coverage: NotificationFactCoverage{Kind: "from_creation"}}
	journal, err := q.GetIssueStateJournal(ctx, repo.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		if after > 0 {
			return IssueStateFactPage{}, pkgerrors.UnknownCursor("issue cursor is ahead of journal")
		}
		return page, nil
	}
	if err != nil {
		return IssueStateFactPage{}, pkgerrors.Internal("read issue journal").WithCause(err)
	}
	if after > journal.Head {
		return IssueStateFactPage{}, pkgerrors.UnknownCursor("issue cursor is ahead of journal")
	}
	page.Head = journal.Head
	page.Coverage = NotificationFactCoverage{Kind: journal.CoverageKind, StartedAt: &journal.CoverageStartedAt}
	rows, err := q.ListIssueStateFacts(ctx, db.ListIssueStateFactsParams{RepositoryID: repo.ID, AfterSequence: after, ThroughSequence: journal.Head, PageSize: int32(limit)})
	if err != nil {
		return IssueStateFactPage{}, pkgerrors.Internal("read issue state facts").WithCause(err)
	}
	for _, row := range rows {
		if row.RepositoryID != repo.ID || row.Sequence != page.Cursor+1 {
			return IssueStateFactPage{}, pkgerrors.Internal("issue journal scope or position mismatch")
		}
		page.Cursor = row.Sequence
		if row.AudienceUserID.Valid && (viewer == nil || viewer.ID != row.AudienceUserID.Int64) {
			continue
		}
		fact, err := DecodeIssueStateFact(row)
		if err != nil {
			return IssueStateFactPage{}, pkgerrors.Internal("decode issue state fact: " + err.Error())
		}
		page.Events = append(page.Events, fact)
		page.Cursor = row.Sequence
	}
	page.HasMore = page.Cursor < page.Head
	if page.HasMore && len(rows) == 0 {
		return IssueStateFactPage{}, pkgerrors.Internal("issue journal truncated")
	}
	// Recheck after the durable read as well; live revocation cancels a running
	// drain. This is current-policy gating, not a historical permissions log.
	latest, err := s.AuthorizeIssueState(ctx, viewer, owner, name)
	if err != nil {
		return IssueStateFactPage{}, err
	}
	if latest.ID != repo.ID {
		return IssueStateFactPage{}, pkgerrors.Conflict("issue stream repository changed")
	}
	return page, nil
}
