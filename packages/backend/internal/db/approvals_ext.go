package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const expireApproval = `
UPDATE approvals
SET state = 'expired',
    decided_at = NOW(),
    decided_by = NULL
WHERE member_id IS NULL AND id = $1
  AND repository_id = $2
  AND state = 'pending'
  AND expires_at < $3
RETURNING id, session_id, repository_id, state, kind, title, description, created_at, decided_at, decided_by, expires_at, payload
`

type ExpireApprovalParams struct {
	ID           string `json:"id"`
	RepositoryID int64  `json:"repository_id"`
	ExpiresAt    pgtype.Timestamptz
}

// ExpireApproval transitions a pending approval to expired when it has timed out.
func (q *Queries) ExpireApproval(ctx context.Context, arg ExpireApprovalParams) (Approval, error) {
	row := q.db.QueryRow(ctx, expireApproval, arg.ID, arg.RepositoryID, arg.ExpiresAt)
	var i Approval
	err := row.Scan(
		&i.ID,
		&i.SessionID,
		&i.RepositoryID,
		&i.State,
		&i.Kind,
		&i.Title,
		&i.Description,
		&i.CreatedAt,
		&i.DecidedAt,
		&i.DecidedBy,
		&i.ExpiresAt,
		&i.Payload,
	)
	return i, err
}
