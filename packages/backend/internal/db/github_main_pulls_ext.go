package db

import (
	"context"
	"strings"
)

const githubMainPullColumns = `p.repository_id, p.requested_generation, p.synced_generation, p.claimed_generation, p.claim, p.state,
p.attempts, p.lease_expires_at, p.next_attempt_at, p.github_repository, p.branch, p.policy, p.policy_commit, p.github_head,
p.smithers_head, p.last_error, p.last_checked_at, p.last_synced_at, p.created_at, p.updated_at, p.factory_state, p.factory_error`

func scanGithubMainPull(row interface{ Scan(...any) error }) (GithubMainPull, error) {
	var p GithubMainPull
	err := row.Scan(&p.RepositoryID, &p.RequestedGeneration, &p.SyncedGeneration, &p.ClaimedGeneration, &p.Claim, &p.State,
		&p.Attempts, &p.LeaseExpiresAt, &p.NextAttemptAt, &p.GithubRepository, &p.Branch, &p.Policy, &p.PolicyCommit, &p.GithubHead,
		&p.SmithersHead, &p.LastError, &p.LastCheckedAt, &p.LastSyncedAt, &p.CreatedAt, &p.UpdatedAt, &p.FactoryState, &p.FactoryError)
	return p, err
}

// A request makes the row due now. It never shortens a running claim: the
// claim query skips rows whose lease is live, so the new generation runs next.
const requestGithubMainPull = `
INSERT INTO github_main_pulls AS p (repository_id)
VALUES ($1)
ON CONFLICT (repository_id) DO UPDATE
SET requested_generation = p.requested_generation + 1,
    next_attempt_at = NOW(),
    updated_at = NOW()
RETURNING ` + githubMainPullColumns

// RequestGithubMainPull records one more requested pull for a repository.
func (q *Queries) RequestGithubMainPull(ctx context.Context, repositoryID int64) (GithubMainPull, error) {
	return scanGithubMainPull(q.db.QueryRow(ctx, requestGithubMainPull, repositoryID))
}

const getGithubMainPull = `SELECT ` + githubMainPullColumns + ` FROM github_main_pulls p WHERE p.repository_id = $1`

// GetGithubMainPull returns a repository's pull state.
func (q *Queries) GetGithubMainPull(ctx context.Context, repositoryID int64) (GithubMainPull, error) {
	return scanGithubMainPull(q.db.QueryRow(ctx, getGithubMainPull, repositoryID))
}

const listGithubMainPulls = `SELECT ` + githubMainPullColumns + ` FROM github_main_pulls p ORDER BY p.repository_id`

// ListGithubMainPulls returns every followed repository's pull state.
func (q *Queries) ListGithubMainPulls(ctx context.Context) ([]GithubMainPull, error) {
	rows, err := q.db.Query(ctx, listGithubMainPulls)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []GithubMainPull{}
	for rows.Next() {
		item, err := scanGithubMainPull(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// A retry makes every row due now in one statement, as a request makes one.
const requestAllGithubMainPulls = `
UPDATE github_main_pulls
SET requested_generation = requested_generation + 1,
    next_attempt_at = NOW(),
    updated_at = NOW()
`

// RequestAllGithubMainPulls records one more requested pull for every
// followed repository.
func (q *Queries) RequestAllGithubMainPulls(ctx context.Context) (int64, error) {
	tag, err := q.db.Exec(ctx, requestAllGithubMainPulls)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const claimGithubMainPulls = `
WITH due AS (
	SELECT repository_id
	FROM github_main_pulls
	WHERE requested_generation > synced_generation
	  AND next_attempt_at <= NOW()
	  AND (state <> 'running' OR lease_expires_at IS NULL OR lease_expires_at < NOW())
	ORDER BY next_attempt_at, repository_id
	FOR UPDATE SKIP LOCKED
	LIMIT $1
)
UPDATE github_main_pulls p
SET state = 'running',
    claim = p.claim + 1,
    claimed_generation = p.requested_generation,
    attempts = p.attempts + 1,
    lease_expires_at = NOW() + make_interval(secs => $2),
    updated_at = NOW()
FROM due
WHERE p.repository_id = due.repository_id
RETURNING ` + githubMainPullColumns

// ClaimGithubMainPulls leases due rows. A crashed worker's row becomes due
// again when its lease expires.
func (q *Queries) ClaimGithubMainPulls(ctx context.Context, limit int32, leaseSeconds float64) ([]GithubMainPull, error) {
	rows, err := q.db.Query(ctx, claimGithubMainPulls, limit, leaseSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []GithubMainPull{}
	for rows.Next() {
		item, err := scanGithubMainPull(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// FinishGithubMainPullParams closes one claim. State is synced, skipped or
// failed. A failure keeps synced_generation, so the row stays due after
// BackoffSeconds. Empty receipt fields keep their previous values. Factory
// receipts clear when policy is reset or an unreconciled source/policy changes.
type FinishGithubMainPullParams struct {
	RepositoryID     int64
	Claim            int64
	State            string
	GithubRepository string
	Branch           string
	Policy           string
	PolicyCommit     string
	GithubHead       string
	SmithersHead     string
	FactoryState     string
	FactoryError     string
	Error            string
	BackoffSeconds   float64
	// ResetPolicy clears the source/policy tuple instead of keeping it.
	ResetPolicy bool
}

const finishGithubMainPull = `
UPDATE github_main_pulls
SET synced_generation = CASE WHEN $3 = 'failed' THEN synced_generation ELSE GREATEST(synced_generation, claimed_generation) END,
    state = CASE
        WHEN $3 = 'failed' THEN 'failed'
        WHEN requested_generation > claimed_generation THEN 'pending'
        ELSE $3 END,
    attempts = CASE WHEN $3 = 'failed' THEN attempts ELSE 0 END,
    next_attempt_at = CASE WHEN $3 = 'failed' THEN NOW() + make_interval(secs => $11) ELSE NOW() END,
    lease_expires_at = NULL,
    github_repository = CASE WHEN $12 THEN '' WHEN $4 = '' THEN github_repository ELSE $4 END,
    branch = CASE WHEN $5 = '' THEN branch ELSE $5 END,
    policy = CASE WHEN $12 THEN '' WHEN $6 = '' THEN policy ELSE $6 END,
    policy_commit = CASE WHEN $12 THEN '' WHEN $7 = '' THEN policy_commit ELSE $7 END,
    github_head = CASE WHEN $8 = '' THEN github_head ELSE $8 END,
    smithers_head = CASE WHEN $9 = '' THEN smithers_head ELSE $9 END,
    last_error = $10,
    factory_state = CASE
        WHEN $12 THEN ''
        WHEN $13 <> '' THEN $13
        WHEN ($6 <> '' AND $6 <> 'pull') OR ($4 <> '' AND $4 <> github_repository) THEN ''
        ELSE factory_state END,
    factory_error = CASE
        WHEN $12 THEN ''
        WHEN $13 <> '' THEN $14
        WHEN ($6 <> '' AND $6 <> 'pull') OR ($4 <> '' AND $4 <> github_repository) THEN ''
        ELSE factory_error END,
    last_checked_at = NOW(),
    last_synced_at = CASE WHEN $3 = 'synced' THEN NOW() ELSE last_synced_at END,
    updated_at = NOW()
WHERE repository_id = $1
  AND claim = $2
  AND state = 'running'
`

// FinishGithubMainPull returns 0 when the claim was lost to a newer claimant.
func (q *Queries) FinishGithubMainPull(ctx context.Context, arg FinishGithubMainPullParams) (int64, error) {
	tag, err := q.db.Exec(ctx, finishGithubMainPull, arg.RepositoryID, arg.Claim, arg.State, arg.GithubRepository, arg.Branch,
		arg.Policy, arg.PolicyCommit, arg.GithubHead, arg.SmithersHead, strings.TrimSpace(arg.Error), arg.BackoffSeconds, arg.ResetPolicy, arg.FactoryState, strings.TrimSpace(arg.FactoryError))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// The poll re-checks pull repositories not checked within $1 seconds and
// re-evaluates skipped ones not checked within $2 seconds, so a missed
// webhook (or a missed policy change) is caught. Failed rows are already due
// by their own backoff.
const requestStaleGithubMainPulls = `
UPDATE github_main_pulls
SET requested_generation = requested_generation + 1,
    updated_at = NOW()
WHERE requested_generation = synced_generation
  AND ((policy = 'pull' AND state = 'synced' AND (last_checked_at IS NULL OR last_checked_at < NOW() - make_interval(secs => $1)))
    OR (state = 'skipped' AND (last_checked_at IS NULL OR last_checked_at < NOW() - make_interval(secs => $2))))
`

// RequestStaleGithubMainPulls re-requests pull repositories not checked recently.
func (q *Queries) RequestStaleGithubMainPulls(ctx context.Context, pullOlderThanSeconds, skippedOlderThanSeconds float64) (int64, error) {
	tag, err := q.db.Exec(ctx, requestStaleGithubMainPulls, pullOlderThanSeconds, skippedOlderThanSeconds)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// A repository's effective GitHub sources, in the precedence of
// ListRepositoryGitHubSources and resolveGitHubDestination: an explicit
// mirror destination, a current sync-registry binding, the latest ready
// import, or a repo connection under the same owner/name. The worker
// re-resolves each destination before any write, so this only nominates.
const githubSourcedRepositories = `
WITH owners AS (
	SELECT r.id, r.lower_name, r.user_id, LOWER(COALESCE(u.username, o.name)) AS owner_lower,
	       regexp_replace(regexp_replace(LOWER(r.mirror_destination), '^https://github\.com/', ''), '(\.git)?/?$', '') AS destination
	FROM repositories r
	LEFT JOIN users u ON u.id = r.user_id
	LEFT JOIN organizations o ON o.id = r.org_id
), latest_import AS (
	SELECT DISTINCT ON (j.repository_id) j.repository_id, LOWER(j.github_owner) AS github_owner, LOWER(j.github_repo) AS github_repo
	FROM import_jobs j
	WHERE j.status = 'ready' AND j.repository_id IS NOT NULL
	ORDER BY j.repository_id, j.created_at DESC, j.id DESC
), sources AS (
	SELECT o.id, split_part(o.destination, '/', 1) AS github_owner, split_part(o.destination, '/', 2) AS github_repo
	FROM owners o WHERE o.destination <> ''
	UNION
	SELECT o.id, g.owner_login_lower, g.repo_name_lower
	FROM owners o JOIN github_synced_repos g
	  ON LOWER(g.mirror_owner) = o.owner_lower AND LOWER(g.mirror_repo) = o.lower_name AND g.sync_state <> 'disabled'
	UNION
	SELECT i.repository_id, i.github_owner, i.github_repo FROM latest_import i
	UNION
	SELECT o.id, rc.repo_owner_lower, rc.repo_name_lower
	FROM owners o JOIN repo_connections rc
	  ON rc.user_id = o.user_id AND rc.repo_owner_lower = o.owner_lower AND rc.repo_name_lower = o.lower_name
)
`

const listRepositoryIDsForGitHubSource = githubSourcedRepositories + `
SELECT DISTINCT id FROM sources WHERE github_owner = $1 AND github_repo = $2 ORDER BY id
`

// ListRepositoryIDsForGitHubSource nominates the Smithers repositories whose
// effective GitHub source is owner/repo.
func (q *Queries) ListRepositoryIDsForGitHubSource(ctx context.Context, owner, repo string) ([]int64, error) {
	rows, err := q.db.Query(ctx, listRepositoryIDsForGitHubSource, strings.ToLower(strings.TrimSpace(owner)), strings.ToLower(strings.TrimSpace(repo)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

const requestUntrackedGithubMainPulls = githubSourcedRepositories + `
INSERT INTO github_main_pulls (repository_id)
SELECT DISTINCT s.id FROM sources s
WHERE NOT EXISTS (SELECT 1 FROM github_main_pulls p WHERE p.repository_id = s.id)
ORDER BY s.id
LIMIT $1
ON CONFLICT (repository_id) DO NOTHING
`

// RequestUntrackedGithubMainPulls starts tracking up to limit GitHub-sourced
// repositories that have never been evaluated, so no enrollment path has to
// remember to.
func (q *Queries) RequestUntrackedGithubMainPulls(ctx context.Context, limit int32) (int64, error) {
	tag, err := q.db.Exec(ctx, requestUntrackedGithubMainPulls, limit)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const isGithubMainPullMirror = `
SELECT EXISTS (
	SELECT 1
	FROM github_main_pulls p
	JOIN repositories r ON r.id = p.repository_id
	JOIN owner_namespaces ns ON ns.lower_slug = LOWER($1)
	 AND ((ns.owner_type = 'user' AND ns.user_id = r.user_id) OR (ns.owner_type = 'org' AND ns.org_id = r.org_id))
	WHERE r.lower_name = LOWER($2) AND p.policy = 'pull'
)
`

// IsGithubMainPullMirror reports whether the Smithers repository owner/repo
// was last evaluated as `mirror: "pull"`.
func (q *Queries) IsGithubMainPullMirror(ctx context.Context, owner, repo string) (bool, error) {
	var pull bool
	err := q.db.QueryRow(ctx, isGithubMainPullMirror, strings.TrimSpace(owner), strings.TrimSpace(repo)).Scan(&pull)
	return pull, err
}
