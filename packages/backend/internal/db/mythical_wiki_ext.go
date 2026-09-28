package db

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"
)

// Wiki state from migrations 0036 and 0037. LegacyPagesRemoved counts the
// retired source-index pages deleted by migration 0037; only that migration writes it.
const mythicalWikiColumns = `repository_id, version, generation, state, requested, commit_id, base_commit, workspace_id, run_id, outcome,
result, attempt, started_at, next_attempt_at, published_commit, published_base, published_at, receipt, pages, pool, error, updated_at,
legacy_pages_removed`

func scanMythicalWiki(row interface{ Scan(...any) error }) (MythicalWiki, error) {
	var w MythicalWiki
	var result, receipt, pages, pool []byte
	err := row.Scan(&w.RepositoryID, &w.Version, &w.Generation, &w.State, &w.Requested, &w.CommitID, &w.BaseCommit, &w.WorkspaceID,
		&w.RunID, &w.Outcome, &result, &w.Attempt, &w.StartedAt, &w.NextAttemptAt, &w.PublishedCommit, &w.PublishedBase,
		&w.PublishedAt, &receipt, &pages, &pool, &w.Error, &w.UpdatedAt, &w.LegacyPagesRemoved)
	w.Result, w.Receipt, w.Pages, w.Pool = rawJSON(result), rawJSON(receipt), rawJSON(pages), rawJSON(pool)
	return w, err
}

// GetMythicalWiki reads a repository's wiki state.
func (q *Queries) GetMythicalWiki(ctx context.Context, repositoryID int64) (MythicalWiki, error) {
	return scanMythicalWiki(q.db.QueryRow(ctx, `SELECT `+mythicalWikiColumns+` FROM mythical_wikis WHERE repository_id = $1`, repositoryID))
}

// EnsureMythicalWiki creates a repository's wiki row when it has none and
// answers the row.
func (q *Queries) EnsureMythicalWiki(ctx context.Context, repositoryID int64) (MythicalWiki, error) {
	if _, err := q.db.Exec(ctx, `INSERT INTO mythical_wikis (repository_id) VALUES ($1) ON CONFLICT (repository_id) DO NOTHING`, repositoryID); err != nil {
		return MythicalWiki{}, err
	}
	return q.GetMythicalWiki(ctx, repositoryID)
}

// SaveMythicalWiki writes w when its version is still current and answers the
// saved row (pgx.ErrNoRows when another writer saved first).
func (q *Queries) SaveMythicalWiki(ctx context.Context, w MythicalWiki) (MythicalWiki, error) {
	pages := w.Pages
	if len(pages) == 0 {
		pages = json.RawMessage("[]")
	}
	return scanMythicalWiki(q.db.QueryRow(ctx, `
UPDATE mythical_wikis SET version = version + 1, generation = $3, state = $4, requested = $5, commit_id = $6, base_commit = $7,
    workspace_id = $8, run_id = $9, outcome = $10, result = $11, attempt = $12, started_at = $13, next_attempt_at = $14,
    published_commit = $15, published_base = $16, published_at = $17, receipt = $18, pages = $19, pool = $20, error = $21,
    updated_at = NOW()
WHERE repository_id = $1 AND version = $2
RETURNING `+mythicalWikiColumns,
		w.RepositoryID, w.Version, w.Generation, w.State, w.Requested, w.CommitID, w.BaseCommit, w.WorkspaceID, w.RunID, w.Outcome,
		jsonArg(w.Result), w.Attempt, w.StartedAt, w.NextAttemptAt, w.PublishedCommit, w.PublishedBase, w.PublishedAt,
		jsonArg(w.Receipt), []byte(pages), jsonArg(w.Pool), w.Error))
}

// RequestMythicalWiki asks for a refresh now, or a retry of a failed one. A
// running refresh is left alone: it already reviews the newest folded main
// or is followed by one that does.
func (q *Queries) RequestMythicalWiki(ctx context.Context, repositoryID int64) (bool, error) {
	tag, err := q.db.Exec(ctx, `
UPDATE mythical_wikis SET requested = true, version = version + 1, next_attempt_at = NOW(), updated_at = NOW()
WHERE repository_id = $1 AND state IN ('idle', 'failed')`, repositoryID)
	return tag.RowsAffected() == 1, err
}

// BindMythicalWikiWorkspace records the workspace a launch of generation is
// about to use, before the workspace is provisioned, so a crash between the
// two never leaks a workspace the row does not name.
func (q *Queries) BindMythicalWikiWorkspace(ctx context.Context, repositoryID, generation int64, workspaceID string) (bool, error) {
	tag, err := q.db.Exec(ctx, `
UPDATE mythical_wikis SET workspace_id = $3, version = version + 1, updated_at = NOW()
WHERE repository_id = $1 AND generation = $2 AND workspace_id = ''`, repositoryID, generation, workspaceID)
	return tag.RowsAffected() == 1, err
}

// MythicalWikiSummary is what the snapshot shows of a repository's wiki:
// the row without its page bodies, reviews or run output.
type MythicalWikiSummary struct {
	State           string
	Requested       bool
	CommitID        string
	RunID           string
	Attempt         int32
	PublishedCommit string
	PublishedAt     pgtype.Timestamptz
	Error           string
	Pages           int64
	Edited          int64
}

// GetMythicalWikiSummary reads the snapshot's view of a repository's wiki.
func (q *Queries) GetMythicalWikiSummary(ctx context.Context, repositoryID int64) (MythicalWikiSummary, error) {
	var w MythicalWikiSummary
	err := q.db.QueryRow(ctx, `
SELECT state, requested, commit_id, run_id, attempt, published_commit, published_at, error, jsonb_array_length(pages),
    (SELECT count(*) FROM jsonb_array_elements(pages) AS page WHERE (page->>'edited')::boolean IS TRUE)
FROM mythical_wikis WHERE repository_id = $1`, repositoryID).Scan(&w.State, &w.Requested, &w.CommitID, &w.RunID, &w.Attempt,
		&w.PublishedCommit, &w.PublishedAt, &w.Error, &w.Pages, &w.Edited)
	return w, err
}
