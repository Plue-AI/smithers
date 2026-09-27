package db

import "context"

// MarkOutsiderWorkspace records that a workspace ran work started from an
// outsider's text; the mark is permanent.
func (q *Queries) MarkOutsiderWorkspace(ctx context.Context, repositoryID int64, workspaceID string) error {
	_, err := q.db.Exec(ctx, `INSERT INTO outsider_workspaces (workspace_id, repository_id) VALUES (lower($1), $2)
		ON CONFLICT (workspace_id) DO NOTHING`, workspaceID, repositoryID)
	return err
}

// IsOutsiderWorkspace reports whether a workspace ever ran such work.
func (q *Queries) IsOutsiderWorkspace(ctx context.Context, workspaceID string) (bool, error) {
	var found bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM outsider_workspaces WHERE workspace_id = lower($1))`, workspaceID).Scan(&found)
	return found, err
}

// RecordLandingSourceWorkspace records the workspace whose landing
// credential opened a landing.
func (q *Queries) RecordLandingSourceWorkspace(ctx context.Context, landingRequestID int64, workspaceID string) error {
	_, err := q.db.Exec(ctx, `INSERT INTO landing_source_workspaces (landing_request_id, workspace_id) VALUES ($1, lower($2))
		ON CONFLICT (landing_request_id) DO NOTHING`, landingRequestID, workspaceID)
	return err
}

// IsOutsiderLanding reports whether a landing was opened from a workspace
// that ran work started from an outsider's text.
func (q *Queries) IsOutsiderLanding(ctx context.Context, landingRequestID int64) (bool, error) {
	var found bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM landing_source_workspaces l
		JOIN outsider_workspaces o ON o.workspace_id = l.workspace_id WHERE l.landing_request_id = $1)`, landingRequestID).Scan(&found)
	return found, err
}
