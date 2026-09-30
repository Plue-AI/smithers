package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

// SwapWorkspaceHeadPushTokenID records next as the workspace's publisher token
// only while the row still records expected (NULL when expected is invalid),
// and in the same statement revokes expected, so no crash or concurrent API
// replica can leave a superseded token live and unrecorded. It reports whether
// this caller won; a loser still owns next and must revoke it.
func (q *Queries) SwapWorkspaceHeadPushTokenID(ctx context.Context, id string, userID int64, expected, next pgtype.Int8) (bool, error) {
	var won bool
	err := q.db.QueryRow(ctx, `
WITH swapped AS (
  UPDATE workspaces
  SET head_push_token_id = $4::bigint, updated_at = NOW()
  WHERE id = $1
    AND head_push_token_id IS NOT DISTINCT FROM $3::bigint
  RETURNING id
), revoked AS (
  DELETE FROM access_tokens
  WHERE id = $3::bigint
    AND user_id = $2
    AND EXISTS (SELECT 1 FROM swapped)
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM swapped)`, id, userID, expected, next).Scan(&won)
	return won, err
}
