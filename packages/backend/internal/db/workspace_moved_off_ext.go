package db

import (
	"context"
	"encoding/json"
)

// WorkspaceMovedOff returns the public fact only. The stored return commit and
// wait identity belong to the control transaction and are never branch payloads.
func (q *Queries) WorkspaceMovedOff(ctx context.Context, workspace string) (json.RawMessage, error) {
	var raw []byte
	err := q.db.QueryRow(ctx, `SELECT CASE WHEN moved_off IS NULL THEN NULL ELSE jsonb_build_object('by', moved_off->'by', 'item', moved_off->'item') END FROM workspaces WHERE id=$1 AND deleted_at IS NULL`, workspace).Scan(&raw)
	return raw, err
}
