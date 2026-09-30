package db

import (
	"context"
	"time"
)

// ListStoppedAgentWorkspaceIDs lists live agent workspaces suspended for at
// least stoppedFor, oldest first: the ones whose machine disk the runtime may
// reclaim (#2275).
func (q *Queries) ListStoppedAgentWorkspaceIDs(ctx context.Context, stoppedFor time.Duration) ([]string, error) {
	rows, err := q.db.Query(ctx, `
SELECT id
FROM workspaces
WHERE kind = 'agent'
  AND status = 'suspended'
  AND deleted_at IS NULL
  AND COALESCE(suspended_at, updated_at) <= NOW() - make_interval(secs => $1::double precision)
ORDER BY COALESCE(suspended_at, updated_at), id`, stoppedFor.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
