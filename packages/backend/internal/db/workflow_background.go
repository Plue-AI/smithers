package db

import "context"

func (q *Queries) IsWorkflowBackgroundWorkspace(ctx context.Context, id string) (bool, error) {
	var background bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_run_flow_invocations WHERE background_workspace_id=$1::uuid)`, id).Scan(&background)
	return background, err
}
