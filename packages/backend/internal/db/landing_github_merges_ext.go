package db

import "context"

// Columns of a landing merged by its GitHub pull request (migration 0035).
const landingGitHubMergeColumns = `landing_request_id, github_repository, pull_number, head_sha, merge_commit, created_at`

func scanLandingGitHubMerge(row interface{ Scan(...any) error }) (LandingGitHubMerge, error) {
	var m LandingGitHubMerge
	err := row.Scan(&m.LandingRequestID, &m.GithubRepository, &m.PullNumber, &m.HeadSha, &m.MergeCommit, &m.CreatedAt)
	return m, err
}

// The landing and its receipt change together, and only while the landing is
// open. The caller resolved the stack GitHub merged ($6: change id -> commit
// id) and verified its tip is the pull request's head. Main is not written.
const mergeLandingRequestFromGitHub = `
WITH landing AS (
	SELECT lr.id FROM landing_requests lr WHERE lr.id = $1 AND lr.state = 'open' FOR UPDATE
), merged AS (
	UPDATE landing_requests lr
	SET state = 'merged',
	    landed_revisions = COALESCE((
	        SELECT jsonb_object_agg(e.key, jsonb_build_object('commit_id', e.value, 'seq', (
	            SELECT cr.seq FROM change_revisions cr
	            WHERE cr.repository_id = lr.repository_id AND cr.change_id = e.key AND cr.commit_id = e.value
	            ORDER BY cr.id DESC LIMIT 1)))
	        FROM jsonb_each_text($6::jsonb) e
	    ), '{}'::jsonb),
	    merged_at = NOW(),
	    updated_at = NOW()
	FROM landing
	WHERE lr.id = landing.id
	RETURNING lr.id
)
INSERT INTO landing_github_merges (landing_request_id, github_repository, pull_number, head_sha, merge_commit)
SELECT id, $2, $3, $4, $5 FROM merged
RETURNING ` + landingGitHubMergeColumns

// MergeLandingRequestFromGitHubParams names the merged pull request and the
// exact landing tip it carried.
type MergeLandingRequestFromGitHubParams struct {
	LandingRequestID int64
	GithubRepository string
	PullNumber       int64
	HeadSha          string
	MergeCommit      string
	// Revisions is the merged stack as a JSON object of change id -> commit id.
	Revisions []byte
}

// MergeLandingRequestFromGitHub returns pgx.ErrNoRows when the landing is not open.
func (q *Queries) MergeLandingRequestFromGitHub(ctx context.Context, arg MergeLandingRequestFromGitHubParams) (LandingGitHubMerge, error) {
	return scanLandingGitHubMerge(q.db.QueryRow(ctx, mergeLandingRequestFromGitHub, arg.LandingRequestID, arg.GithubRepository,
		arg.PullNumber, arg.HeadSha, arg.MergeCommit, string(arg.Revisions)))
}

const getLandingGitHubMerge = `SELECT ` + landingGitHubMergeColumns + ` FROM landing_github_merges WHERE landing_request_id = $1`

// GetLandingGitHubMerge returns a landing's GitHub merge receipt.
func (q *Queries) GetLandingGitHubMerge(ctx context.Context, landingRequestID int64) (LandingGitHubMerge, error) {
	return scanLandingGitHubMerge(q.db.QueryRow(ctx, getLandingGitHubMerge, landingRequestID))
}

const listOpenLandingNumbers = `SELECT number FROM landing_requests
WHERE repository_id = $1 AND state = 'open' AND ($2 = 0 OR number < $2)
ORDER BY number DESC LIMIT $3`

// ListOpenLandingNumbers pages a repository's open landings newest first;
// before = 0 starts at the newest.
func (q *Queries) ListOpenLandingNumbers(ctx context.Context, repositoryID, before int64, limit int32) ([]int64, error) {
	rows, err := q.db.Query(ctx, listOpenLandingNumbers, repositoryID, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	numbers := []int64{}
	for rows.Next() {
		var number int64
		if err := rows.Scan(&number); err != nil {
			return nil, err
		}
		numbers = append(numbers, number)
	}
	return numbers, rows.Err()
}
