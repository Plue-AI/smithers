package db

import "context"

func (q *Queries) IsWorkflowBackgroundWorkspace(ctx context.Context, id string) (bool, error) {
	var background bool
	err := q.db.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM workflow_run_flow_invocations WHERE background_workspace_id=$1::uuid)
 OR EXISTS(SELECT 1 FROM flow_runtime_host_bindings WHERE workspace_id=$1::uuid AND binding_kind IN ('learning','review','mythical-wiki'))
 OR EXISTS(SELECT 1 FROM mythical_wikis WHERE workspace_id=$1::text)
 OR EXISTS(SELECT 1 FROM workspaces w JOIN product_job_requests r ON
   (r.operation='install.review' AND w.name='review-' || r.id::text)
   OR (r.operation='learning.admission' AND w.name='learning-' || (r.payload->>'item'))
   WHERE w.id=$1::uuid)`, id).Scan(&background)
	return background, err
}
