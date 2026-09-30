package db

import "context"

func (q *Queries) CountConnectedReposForUser(ctx context.Context, userID int64) (int, error) {
	var count int
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*)
FROM repo_connections
WHERE user_id = $1
`, userID).Scan(&count)
	return count, err
}

func (q *Queries) CountActiveWorkflowRunsForUser(ctx context.Context, userID int64) (int, error) {
	// The per-user concurrent-run cap gates workflow dispatch on EVERY repo the
	// user can dispatch to, so the footprint must cover org-member and
	// collaborator repos too — counting only personally-owned repos made the
	// cap a no-op for org/collaborator dispatches (a user could stack unbounded
	// concurrent runs on an org repo while their personal count stayed 0).
	// workflow_runs has no dispatching-user attribution column, so this counts
	// active runs across the user's whole dispatchable surface; on busy shared
	// repos that errs conservative (a teammate's runs count against you), which
	// is the right failure mode for a runner-capacity safety cap.
	var count int
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*)
FROM workflow_runs wr
JOIN repositories r ON r.id = wr.repository_id
WHERE wr.status IN ('queued', 'running')
  AND (
    r.user_id = $1
    OR r.org_id IN (SELECT organization_id FROM org_members WHERE user_id = $1)
    OR r.id IN (SELECT repository_id FROM collaborators WHERE user_id = $1)
  )
`, userID).Scan(&count)
	return count, err
}

// CountActiveSandboxesForUser counts product workspace reservations. Hosted
// deployments override this through deploymentdb to include private gateways.
// Child workspaces (#2802) have their own plan limit and are not counted.
func (q *Queries) CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error) {
	var count int
	err := q.db.QueryRow(ctx, `
SELECT COUNT(*) FROM workspaces w
WHERE w.user_id = $1 AND w.deleted_at IS NULL
  AND w.status IN ('pending', 'starting', 'running')
  AND NOT EXISTS (SELECT 1 FROM workspace_children c WHERE c.workspace_id = w.id)
`, userID).Scan(&count)
	return count, err
}
