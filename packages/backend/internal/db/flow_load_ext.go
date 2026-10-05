package db

import (
	"context"
	"encoding/json"
)

// Flow-load state and flow versions from migration 0117 (engineering spec
// §11.3): one flow_loads row per repository, and one workflow_definitions
// row per (name, digest) version flow-load measured.
const flowLoadColumns = `repository_id, version, generation, state, commit_id, loaded_commit, versions, tree, commit_tree, syncing,
workspace_id, run_id, outcome, result, attempt, started_at, next_attempt_at, error, updated_at`

func scanFlowLoad(row interface{ Scan(...any) error }) (FlowLoad, error) {
	var l FlowLoad
	var versions, tree, commitTree, syncing []byte
	err := row.Scan(&l.RepositoryID, &l.Version, &l.Generation, &l.State, &l.CommitID, &l.LoadedCommit, &versions, &tree, &commitTree,
		&syncing, &l.WorkspaceID, &l.RunID, &l.Outcome, &l.Result, &l.Attempt, &l.StartedAt, &l.NextAttemptAt, &l.Error, &l.UpdatedAt)
	l.Versions, l.Tree, l.CommitTree, l.Syncing = rawJSON(versions), rawJSON(tree), rawJSON(commitTree), rawJSON(syncing)
	return l, err
}

// GetFlowLoad reads a repository's flow-load state.
func (q *Queries) GetFlowLoad(ctx context.Context, repositoryID int64) (FlowLoad, error) {
	return scanFlowLoad(q.db.QueryRow(ctx, `SELECT `+flowLoadColumns+` FROM flow_loads WHERE repository_id = $1`, repositoryID))
}

// EnsureFlowLoad creates a repository's flow-load row when it has none and
// answers the row.
func (q *Queries) EnsureFlowLoad(ctx context.Context, repositoryID int64) (FlowLoad, error) {
	if _, err := q.db.Exec(ctx, `INSERT INTO flow_loads (repository_id) VALUES ($1) ON CONFLICT (repository_id) DO NOTHING`, repositoryID); err != nil {
		return FlowLoad{}, err
	}
	return q.GetFlowLoad(ctx, repositoryID)
}

// SaveFlowLoad writes l when its version is still current and answers the
// saved row (pgx.ErrNoRows when another writer saved first).
func (q *Queries) SaveFlowLoad(ctx context.Context, l FlowLoad) (FlowLoad, error) {
	orEmpty := func(value json.RawMessage, empty string) []byte {
		if len(value) == 0 {
			return []byte(empty)
		}
		return value
	}
	return scanFlowLoad(q.db.QueryRow(ctx, `
UPDATE flow_loads SET version = version + 1, generation = $3, state = $4, commit_id = $5, loaded_commit = $6, versions = $7,
    tree = $8, commit_tree = $9, syncing = $10, workspace_id = $11, run_id = $12, outcome = $13, result = $14, attempt = $15,
    started_at = $16, next_attempt_at = $17, error = $18, updated_at = NOW()
WHERE repository_id = $1 AND version = $2
RETURNING `+flowLoadColumns,
		l.RepositoryID, l.Version, l.Generation, l.State, l.CommitID, l.LoadedCommit, orEmpty(l.Versions, "[]"), orEmpty(l.Tree, "{}"),
		orEmpty(l.CommitTree, "{}"), orEmpty(l.Syncing, "[]"), l.WorkspaceID, l.RunID, l.Outcome, jsonArg(l.Result), l.Attempt, l.StartedAt,
		l.NextAttemptAt, l.Error))
}

// BindFlowLoadWorkspace records the workspace a launch of generation is about
// to use, before the workspace is provisioned, so a crash between the two
// never leaks a workspace the row does not name.
func (q *Queries) BindFlowLoadWorkspace(ctx context.Context, repositoryID, generation int64, workspaceID string) (bool, error) {
	tag, err := q.db.Exec(ctx, `
UPDATE flow_loads SET workspace_id = $3, version = version + 1, updated_at = NOW()
WHERE repository_id = $1 AND generation = $2 AND workspace_id = ''`, repositoryID, generation, workspaceID)
	return tag.RowsAffected() == 1, err
}

const flowVersionColumns = `id, repository_id, name, path, config, is_active, created_at, updated_at, source_commit, digest, status, load_error`

// ListFlowVersions answers a repository's flow versions, oldest first.
func (q *Queries) ListFlowVersions(ctx context.Context, repositoryID int64) ([]WorkflowDefinition, error) {
	rows, err := q.db.Query(ctx, `SELECT `+flowVersionColumns+` FROM workflow_definitions
WHERE repository_id = $1 AND digest IS NOT NULL ORDER BY id`, repositoryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	versions := []WorkflowDefinition{}
	for rows.Next() {
		var v WorkflowDefinition
		if err := rows.Scan(&v.ID, &v.RepositoryID, &v.Name, &v.Path, &v.Config, &v.IsActive, &v.CreatedAt, &v.UpdatedAt,
			&v.SourceCommit, &v.Digest, &v.Status, &v.LoadError); err != nil {
			return nil, err
		}
		versions = append(versions, v)
	}
	return versions, rows.Err()
}

// InsertFlowVersion writes one version unless its (name, digest) already has
// a row; it answers whether it wrote.
func (q *Queries) InsertFlowVersion(ctx context.Context, repositoryID int64, name, path, sourceCommit, digest, status, loadError string, config json.RawMessage) (bool, error) {
	tag, err := q.db.Exec(ctx, `
INSERT INTO workflow_definitions (repository_id, name, path, config, is_active, source_commit, digest, status, load_error)
VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8)
ON CONFLICT (repository_id, name, digest) WHERE digest IS NOT NULL DO NOTHING`,
		repositoryID, name, path, []byte(config), sourceCommit, digest, status, loadError)
	return tag.RowsAffected() == 1, err
}

// ActivateFlowVersion makes the loaded version (name, digest) the flow's
// Active one; it answers whether Active moved. A failed version is never
// activated.
func (q *Queries) ActivateFlowVersion(ctx context.Context, repositoryID int64, name, digest string) (bool, error) {
	var current string
	err := q.db.QueryRow(ctx, `SELECT COALESCE((SELECT digest FROM workflow_definitions
WHERE repository_id = $1 AND name = $2 AND digest IS NOT NULL AND is_active), '')`, repositoryID, name).Scan(&current)
	if err != nil || current == digest {
		return false, err
	}
	if _, err := q.db.Exec(ctx, `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
WHERE repository_id = $1 AND name = $2 AND digest IS NOT NULL AND is_active`, repositoryID, name); err != nil {
		return false, err
	}
	tag, err := q.db.Exec(ctx, `UPDATE workflow_definitions SET is_active = TRUE, updated_at = NOW()
WHERE repository_id = $1 AND name = $2 AND digest = $3 AND status = 'loaded'`, repositoryID, name, digest)
	return tag.RowsAffected() == 1, err
}

// DeactivateFlowVersions returns a flow to its built-in version (or to none):
// no repository version of it is Active. It answers whether Active moved.
func (q *Queries) DeactivateFlowVersions(ctx context.Context, repositoryID int64, name string) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
WHERE repository_id = $1 AND name = $2 AND digest IS NOT NULL AND is_active`, repositoryID, name)
	return tag.RowsAffected() > 0, err
}
