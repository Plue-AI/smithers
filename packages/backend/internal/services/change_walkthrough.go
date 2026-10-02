package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ChangeWalkthroughSection is one story section rendered in the Walkthrough
// facet. Diagram contains Mermaid source when the section has a diagram.
type ChangeWalkthroughSection struct {
	Title    string  `json:"title"`
	Markdown string  `json:"markdown"`
	Diagram  *string `json:"diagram,omitempty"`
}

// ChangeWalkthroughResponse contains the narrated sections for a change revision.
type ChangeWalkthroughResponse struct {
	Sections []ChangeWalkthroughSection `json:"sections"`
}

type changeWalkthroughStore interface {
	UpsertChangeWalkthrough(context.Context, db.UpsertChangeWalkthroughParams) (db.ChangeWalkthrough, error)
	NotifyChangeEvent(context.Context, db.NotifyChangeEventParams) error
}

type changeWalkthroughAvailableEvent struct {
	EventID     string `json:"event_id"`
	Action      string `json:"action"`
	ChangeID    string `json:"change_id"`
	RevisionSeq int64  `json:"revision_seq"`
}

// GetWalkthrough returns the artifact for revisionSeq. A zero revision selects
// the newest recorded revision, matching change.walkthrough's optional rev.
func (s *ChangeService) GetWalkthrough(ctx context.Context, repositoryID int64, changeID string, revisionSeq int64) (ChangeWalkthroughResponse, error) {
	if s == nil || s.queries == nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("change walkthrough service not configured")
	}
	if strings.TrimSpace(changeID) == "" {
		return ChangeWalkthroughResponse{}, pkgerrors.BadRequest("change_id is required")
	}
	if revisionSeq < 0 {
		return ChangeWalkthroughResponse{}, pkgerrors.BadRequest("invalid revision")
	}

	row, err := s.queries.GetChangeWalkthrough(ctx, db.GetChangeWalkthroughParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
		RevisionSeq:  revisionSeq,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ChangeWalkthroughResponse{}, pkgerrors.NotFound("walkthrough not found")
		}
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to load change walkthrough").WithCause(err)
	}

	return decodeChangeWalkthrough(row)
}

// StoreWalkthrough attaches a smithers review story to an immutable change
// revision. The artifact upsert and pg_notify are committed together, so every
// successfully stored version produces a change-stream availability event.
func (s *ChangeService) StoreWalkthrough(ctx context.Context, repositoryID int64, changeID string, revisionSeq int64, input ChangeWalkthroughResponse) (ChangeWalkthroughResponse, error) {
	if s == nil || s.queries == nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("change walkthrough service not configured")
	}
	if strings.TrimSpace(changeID) == "" {
		return ChangeWalkthroughResponse{}, pkgerrors.BadRequest("change_id is required")
	}
	if revisionSeq < 0 {
		return ChangeWalkthroughResponse{}, pkgerrors.BadRequest("invalid revision")
	}

	sections := input.Sections
	if sections == nil {
		sections = []ChangeWalkthroughSection{}
	}
	sectionsJSON, err := json.Marshal(sections)
	if err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.UnprocessableEntity("invalid walkthrough sections")
	}

	revision, err := s.queries.GetChangeRevisionForWalkthrough(ctx, db.GetChangeRevisionForWalkthroughParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
		RevisionSeq:  revisionSeq,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ChangeWalkthroughResponse{}, pkgerrors.NotFound("change revision not found")
		}
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to load change revision").WithCause(err)
	}

	params := db.UpsertChangeWalkthroughParams{
		ChangeRevisionID: revision.ID,
		Sections:         sectionsJSON,
		// Retain the historical column for existing installations; new artifacts contain no quiz.
		Quiz: json.RawMessage(`[]`),
	}
	if s.pool == nil {
		return storeChangeWalkthrough(ctx, s.queries, params, repositoryID, changeID, revision.Seq)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to begin change walkthrough transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	result, err := storeChangeWalkthrough(ctx, db.New(tx), params, repositoryID, changeID, revision.Seq)
	if err != nil {
		return ChangeWalkthroughResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to commit change walkthrough").WithCause(err)
	}
	return result, nil
}

func storeChangeWalkthrough(ctx context.Context, store changeWalkthroughStore, params db.UpsertChangeWalkthroughParams, repositoryID int64, changeID string, revisionSeq int64) (ChangeWalkthroughResponse, error) {
	row, err := store.UpsertChangeWalkthrough(ctx, params)
	if err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to store change walkthrough").WithCause(err)
	}

	eventJSON, err := json.Marshal(changeWalkthroughAvailableEvent{
		EventID:     fmt.Sprintf("%d-%d", row.ID, row.UpdatedAt.UnixNano()),
		Action:      "walkthrough_available",
		ChangeID:    changeID,
		RevisionSeq: revisionSeq,
	})
	if err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to encode change walkthrough event").WithCause(err)
	}
	if err := store.NotifyChangeEvent(ctx, db.NotifyChangeEventParams{
		RepositoryID: repositoryID,
		Payload:      string(eventJSON),
	}); err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to publish change walkthrough event").WithCause(err)
	}

	return decodeChangeWalkthrough(row)
}

func decodeChangeWalkthrough(row db.ChangeWalkthrough) (ChangeWalkthroughResponse, error) {
	response := ChangeWalkthroughResponse{
		Sections: []ChangeWalkthroughSection{},
	}
	if err := json.Unmarshal(row.Sections, &response.Sections); err != nil {
		return ChangeWalkthroughResponse{}, pkgerrors.Internal("failed to decode change walkthrough sections").WithCause(err)
	}
	if response.Sections == nil {
		response.Sections = []ChangeWalkthroughSection{}
	}
	return response, nil
}
