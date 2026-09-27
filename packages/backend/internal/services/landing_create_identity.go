package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The identity belongs to the existing landing row. A dedicated create route
// requires this capability so an older server cannot silently create duplicates.
type landingIdentityTx interface {
	CreateLandingRequestIdempotent(context.Context, db.CreateLandingRequestIdempotentParams) (db.LandingRequest, error)
	GetLandingRequestByCreateIdentity(context.Context, db.GetLandingRequestByCreateIdentityParams) (db.LandingRequest, error)
}

func (t *pgxLandingCreateTx) CreateLandingRequestIdempotent(ctx context.Context, p db.CreateLandingRequestIdempotentParams) (db.LandingRequest, error) {
	return t.q.CreateLandingRequestIdempotent(ctx, p)
}
func (t *pgxLandingCreateTx) GetLandingRequestByCreateIdentity(ctx context.Context, p db.GetLandingRequestByCreateIdentityParams) (db.LandingRequest, error) {
	return t.q.GetLandingRequestByCreateIdentity(ctx, p)
}

func landingCreateDigest(p db.CreateLandingRequestParams, ids []string) []byte {
	// Explicit versioned input: mutable row fields are never used to reconstruct
	// the original request on retry. Session identity cannot be changed by replay.
	raw, _ := json.Marshal(struct {
		Version       int      `json:"version"`
		Title         string   `json:"title"`
		Body          string   `json:"body"`
		Target        string   `json:"target_bookmark"`
		Source        string   `json:"source_bookmark"`
		ChangeIDs     []string `json:"change_ids"`
		AgentAuthored bool     `json:"agent_authored"`
		AgentSession  string   `json:"agent_session"`
	}{1, p.Title, p.Body, p.TargetBookmark, p.SourceBookmark, ids, p.AgentAuthored, p.AuthorAgentSessionID})
	sum := sha256.Sum256(raw)
	return sum[:]
}

func (s *LandingService) createLandingIdempotent(ctx context.Context, repository db.Repository, owner string, actor *db.User, p db.CreateLandingRequestParams, ids []string, requestID string) (LandingRequestResponse, error) {
	parsed, err := uuid.Parse(requestID)
	if err != nil || parsed == uuid.Nil || parsed.String() != requestID {
		return LandingRequestResponse{}, pkgerrors.BadRequest("request_id must be a canonical nonzero UUID")
	}
	if s.createTxManager == nil {
		return LandingRequestResponse{}, pkgerrors.New(pkgerrors.CodeLandingCreateUnavailable, "idempotent landing creation requires the existing transactional store")
	}
	tx, err := s.createTxManager.BeginCreateTx(ctx)
	if err != nil {
		return LandingRequestResponse{}, normalizeLandingCreateError(err, "failed to begin landing request transaction")
	}
	defer rollbackLandingTx(ctx, tx)
	identity, ok := tx.(landingIdentityTx)
	if !ok {
		return LandingRequestResponse{}, pkgerrors.New(pkgerrors.CodeLandingCreateUnavailable, "idempotent landing creation is unavailable")
	}
	key := pgtype.UUID{Bytes: parsed, Valid: true}
	digest := landingCreateDigest(p, ids)
	created, err := identity.CreateLandingRequestIdempotent(ctx, db.CreateLandingRequestIdempotentParams{
		RepositoryID: p.RepositoryID, Title: p.Title, Body: p.Body, AuthorID: p.AuthorID, TargetBookmark: p.TargetBookmark, SourceBookmark: p.SourceBookmark, StackSize: p.StackSize,
		AgentAuthored: p.AgentAuthored, AuthorAgentSessionID: p.AuthorAgentSessionID, RequestID: key, CreateRequestHash: digest,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		previous, lookupErr := identity.GetLandingRequestByCreateIdentity(ctx, db.GetLandingRequestByCreateIdentityParams{RepositoryID: p.RepositoryID, AuthorID: p.AuthorID, RequestID: key})
		if lookupErr != nil {
			return LandingRequestResponse{}, normalizeLandingCreateError(lookupErr, "failed to recover landing request")
		}
		if !bytes.Equal(previous.CreateRequestHash, digest) {
			return LandingRequestResponse{}, pkgerrors.New(pkgerrors.CodeLandingRequestConflict, "request_id was already used with different input or agent identity")
		}
		// Commit may have succeeded before the first HTTP response was lost. Reuse
		// the current existing row without replaying opened notifications or children.
		rollbackLandingTx(ctx, tx) // Release the connection and number lock before external-pool reads.
		if err := s.recordLandingSource(ctx, previous.ID); err != nil {
			return LandingRequestResponse{}, err
		}
		return s.GetLandingRequest(ctx, actor, owner, repository.Name, previous.Number)
	}
	if err != nil {
		return LandingRequestResponse{}, normalizeLandingCreateError(err, "failed to create landing request")
	}
	for i, id := range ids {
		if _, err = tx.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{LandingRequestID: created.ID, ChangeID: id, PositionInStack: int64(i + 1)}); err != nil {
			return LandingRequestResponse{}, normalizeLandingCreateError(err, "failed to store landing request changes")
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return LandingRequestResponse{}, normalizeLandingCreateError(err, "failed to commit landing request transaction")
	}
	return s.afterCreate(ctx, repository, owner, actor, created, ids, p.Body)
}
