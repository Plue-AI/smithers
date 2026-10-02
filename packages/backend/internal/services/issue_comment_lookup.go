package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func (s *IssueService) FindIssueComment(ctx context.Context, actor *db.User, owner, repo string, number int64, key string) (IssueCommentResponse, error) {
	if actor == nil {
		return IssueCommentResponse{}, api.Unauthorized("authentication required")
	}
	if key == "" || len(key) > 128 {
		return IssueCommentResponse{}, api.BadRequest("invalid message identity")
	}
	_, i, err := s.resolveReadableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return IssueCommentResponse{}, err
	}
	q, err := s.commentQueries()
	if err != nil {
		return IssueCommentResponse{}, err
	}
	id, err := q.FindIssueCommentKey(ctx, i.ID, actor.ID, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueCommentResponse{}, api.NotFound("message identity not found")
	}
	if err != nil {
		return IssueCommentResponse{}, err
	}
	c, err := q.GetIssueCommentByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueCommentResponse{}, api.Conflict("message identity was deleted")
	}
	if err != nil {
		return IssueCommentResponse{}, err
	}
	return mapIssueComment(c), nil
}

// Native comment lookup/reactions require the ordinary product storage.
func (s *IssueService) commentQueries() (*db.Queries, error) {
	q, ok := s.queries.(*db.Queries)
	if !ok {
		return nil, api.Internal("issue comment storage unavailable")
	}
	return q, nil
}
