package services

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"regexp"
)

type IssueReaction struct {
	Name   string `json:"name"`
	Actor  string `json:"actor"`
	Active bool   `json:"active"`
}

var reactionName = regexp.MustCompile(`^[a-z0-9_+\-]{1,64}$`)

func (s *IssueService) IssueReactions(ctx context.Context, actor *db.User, owner, repo string, number, commentID int64) ([]IssueReaction, error) {
	_, i, err := s.resolveReadableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return nil, err
	}
	q, err := s.syncQueries()
	if err != nil {
		return nil, err
	}
	c, err := q.GetIssueCommentByID(ctx, commentID)
	if err != nil || c.IssueID != i.ID {
		return nil, api.NotFound("comment not found")
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT r.emoji,COALESCE(e.actor,'user:'||r.user_id::text) FROM reactions r LEFT JOIN issue_external_reactions e ON e.reaction_id=r.id WHERE r.target_type='issue_comment' AND r.target_id=$1 ORDER BY r.id`, commentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IssueReaction{}
	for rows.Next() {
		var r IssueReaction
		r.Active = true
		if err = rows.Scan(&r.Name, &r.Actor); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *IssueService) SetIssueReaction(ctx context.Context, actor *db.User, owner, repo string, number, commentID int64, in IssueReaction) ([]IssueReaction, error) {
	_, i, err := s.resolveWritableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return nil, err
	}
	if !reactionName.MatchString(in.Name) {
		return nil, api.BadRequest("invalid reaction")
	}
	q, err := s.syncQueries()
	if err != nil {
		return nil, err
	}
	c, err := q.GetIssueCommentByID(ctx, commentID)
	if err != nil || c.IssueID != i.ID {
		return nil, api.NotFound("comment not found")
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, i.ID); err != nil {
		return nil, err
	}
	var changed bool
	if in.Active {
		tag, e := tx.Exec(ctx, `INSERT INTO reactions(user_id,target_type,target_id,emoji) VALUES($1,'issue_comment',$2,$3) ON CONFLICT DO NOTHING`, actor.ID, commentID, in.Name)
		err = e
		changed = tag.RowsAffected() > 0
	} else {
		tag, e := tx.Exec(ctx, `DELETE FROM reactions WHERE user_id=$1 AND target_type='issue_comment' AND target_id=$2 AND emoji=$3`, actor.ID, commentID, in.Name)
		err = e
		changed = tag.RowsAffected() > 0
	}
	if err != nil {
		return nil, err
	}
	if changed {
		err = recordReaction(ctx, tx, i.ID, commentID, actor.ID, in.Name, fmt.Sprintf("user:%d", actor.ID), in.Active, true)
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.IssueReactions(ctx, actor, owner, repo, number, commentID)
}
func recordReaction(ctx context.Context, tx pgx.Tx, issueID, commentID, actorID int64, name, author string, active, outbound bool) error {
	payload, _ := json.Marshal(map[string]any{"comment": map[string]any{"id": commentID}, "reaction": map[string]any{"name": name, "actor": author, "active": active}})
	var eventID int64
	err := tx.QueryRow(ctx, `INSERT INTO issue_events(issue_id,actor_id,event_type,payload) VALUES($1,$2,'comment.reaction',$3) RETURNING id`, issueID, actorID, payload).Scan(&eventID)
	if err != nil {
		return err
	}
	if outbound {
		_, err = tx.Exec(ctx, `INSERT INTO issue_sync_deliveries(issue_id,event_id) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM issue_sync_threads WHERE issue_id=$1)`, issueID, eventID)
	}
	return err
}
