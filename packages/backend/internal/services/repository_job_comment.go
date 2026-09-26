package services

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type RepositoryJobCommentInput struct {
	Repo        string `json:"repo"`
	WorkspaceID string `json:"workspace_id"`
	Revision    int64  `json:"revision"`
	Digest      string `json:"digest"`
	DeliveryKey string `json:"delivery_key"`
	Source      string `json:"source"`
	IssueNumber int64  `json:"issue_number"`
	Body        string `json:"body"`
}

type RepositoryJobCommentResult struct {
	RegistrationID string `json:"registration_id"`
	Revision       int64  `json:"revision"`
	Digest         string `json:"digest"`
	DeliveryKey    string `json:"delivery_key"`
	Step           string `json:"step"`
	Source         string `json:"source"`
	IssueNumber    int64  `json:"issue_number"`
	CommentID      int64  `json:"comment_id"`
	APIPath        string `json:"api_path"`
}

// CreateComment atomically publishes a native comment, source outbox event and
// immutable replay receipt. A lost response or even later deletion never causes
// the comment to be posted again. Source events cannot grant posting authority.
func (s *RepositoryJobService) CreateComment(ctx context.Context, gatewayID, bearer, job, step string, input RepositoryJobCommentInput) (RepositoryJobCommentResult, error) {
	var empty RepositoryJobCommentResult
	if input.Source != "smithers-cloud" {
		return empty, pkgerrors.BadRequest("idempotent job replies currently require a native Smithers issue")
	}
	if !repositoryJobNames[job] || strings.TrimSpace(step) == "" || len(step) > 200 || strings.ContainsAny(step, "\r\n\x00/") ||
		input.Revision <= 0 || !repositoryJobDigest.MatchString(input.Digest) || input.IssueNumber <= 0 ||
		strings.TrimSpace(input.DeliveryKey) == "" || len(input.DeliveryKey) > 300 || strings.TrimSpace(input.Body) == "" || len(input.Body) > 500000 {
		return empty, pkgerrors.BadRequest("reply requires an admitted event, exact candidate, step and body")
	}
	if err := validateSafeText("IssueComment", "body", input.Body); err != nil {
		return empty, err
	}
	repo, target, err := s.authorizeJobGateway(ctx, gatewayID, bearer, input.Repo, input.WorkspaceID)
	if err != nil {
		return empty, err
	}
	if s.transactions == nil {
		return empty, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository reply transactions unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repo.ID); err != nil {
		return empty, err
	}
	q := db.New(tx)
	fresh, err := (&RepositoryJobService{q: q}).authorizedRepo(ctx, repo.ID, target.UserID, true)
	if err != nil {
		return empty, err
	}
	if fresh.UserID != repo.UserID || fresh.OrgID != repo.OrgID || fresh.Name != repo.Name {
		return empty, pkgerrors.Conflict("repository ownership changed")
	}
	scope, err := q.GetRepositoryJobCommentDispatch(ctx, db.GetRepositoryJobCommentDispatchParams{RepositoryID: repo.ID, Job: job,
		Revision: input.Revision, Digest: input.Digest, DeliveryKey: input.DeliveryKey, Source: input.Source, IssueNumber: input.IssueNumber})
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, pkgerrors.NotFound("no matching repository job event was admitted")
	}
	if err != nil {
		return empty, err
	}
	reg, dispatch := scope.RepositoryJobRegistration, scope.RepositoryJobDispatch
	if reg.WorkspaceID != target.WorkspaceID || reg.UserID != target.UserID {
		return empty, pkgerrors.Forbidden("reply belongs to a different workspace activator")
	}
	if err = q.LockRepositoryJobComment(ctx, db.LockRepositoryJobCommentParams{DispatchID: dispatch.ID, Step: step}); err != nil {
		return empty, err
	}
	receipt, err := q.GetRepositoryJobComment(ctx, db.GetRepositoryJobCommentParams{DispatchID: dispatch.ID, Step: step})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if !reg.Enabled || reg.Revision != input.Revision || reg.Digest != input.Digest ||
			(dispatch.Status != "dispatching" && dispatch.Status != "submitted" && dispatch.Status != "waiting") {
			return empty, pkgerrors.Conflict("the repository job was paused, replaced or not started")
		}
		issue, err := q.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repo.ID, Number: input.IssueNumber})
		if errors.Is(err, pgx.ErrNoRows) {
			return empty, pkgerrors.NotFound("issue not found")
		}
		if err != nil {
			return empty, err
		}
		if issue.Kind == "chat" {
			return empty, pkgerrors.NotFound("issue not found")
		}
		actor, err := q.GetUserByIDNotDeleted(ctx, target.UserID)
		if err != nil {
			return empty, err
		}
		comment, err := q.CreateIssueComment(ctx, db.CreateIssueCommentParams{IssueID: issue.ID,
			UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, Commenter: actor.Username, Body: input.Body})
		if err != nil {
			return empty, err
		}
		receipt, err = q.CreateRepositoryJobComment(ctx, db.CreateRepositoryJobCommentParams{DispatchID: dispatch.ID, Step: step, Body: input.Body, CommentID: comment.ID})
		if err != nil {
			return empty, err
		}
	} else if receipt.Body != input.Body {
		return empty, pkgerrors.Conflict("reply step was already used with a different body")
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return RepositoryJobCommentResult{RegistrationID: reg.ID, Revision: input.Revision, Digest: input.Digest, DeliveryKey: input.DeliveryKey,
		Step: step, Source: input.Source, IssueNumber: input.IssueNumber, CommentID: receipt.CommentID,
		APIPath: fmt.Sprintf("/repos/%s/issues/%d/comments", input.Repo, input.IssueNumber)}, nil
}
