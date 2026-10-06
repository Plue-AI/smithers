package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// GitHub timestamps have second precision. A read records the committed PR
// observations before network I/O so a delayed response cannot replace a
// concurrently committed, different payload merely because their times tie.
// The ledger is shared across list/detail readers and service instances.
type gitHubPullRead struct {
	source       gitHubStreamKey
	observations map[int64]int64
}

func (s *GitHubSyncedRepoService) beginPullRead(ctx context.Context, row db.GithubSyncedRepo, number int64) (*gitHubPullRead, error) {
	if err := s.authorizeFetched(ctx, row); err != nil {
		return nil, err
	}
	rows, err := s.install.pool.Query(ctx, `SELECT (payload->>'number')::bigint,MAX(COALESCE((payload->>'pull_observation')::bigint,0)) FROM product_job_requests WHERE tenant_id=$1 AND principal_id='pulls' AND operation=$2 AND (payload->>'repo')::bigint=$3 AND ($4::bigint=0 OR (payload->>'number')::bigint=$4) GROUP BY (payload->>'number')::bigint`, fmt.Sprintf("github:%d:%d", row.InstallationID.Int64, row.GithubRepositoryID.Int64), githubFetchedOperation, row.ID, number)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	read := &gitHubPullRead{source: syncedStreamKey(row, GitHubRepoMetadataPulls), observations: make(map[int64]int64)}
	for rows.Next() {
		var n, observation int64
		if err := rows.Scan(&n, &observation); err != nil {
			return nil, err
		}
		if n <= 0 || observation < 0 {
			return nil, gitHubFetchUnavailable()
		}
		read.observations[n] = observation
	}
	return read, rows.Err()
}

func (r *gitHubPullRead) matches(row db.GithubSyncedRepo) bool {
	return r != nil && r.source == syncedStreamKey(row, GitHubRepoMetadataPulls)
}

// The caller holds the source row lock and has already ignored strictly older
// source timestamps. Equality is safe only without a concurrent change, for an
// identical payload, or when the response has a provably newer source time.
func (r *gitHubPullRead) check(ctx context.Context, tx pgx.Tx, row db.GithubSyncedRepo, header gitHubIssueHeader, canonical []byte) error {
	if !r.matches(row) {
		return gitHubFetchUnavailable()
	}
	current, err := latestPullObservation(ctx, tx, row, header.Number)
	if err != nil {
		return err
	}
	if current.PullObservation == r.observations[header.Number] || current.Version == gitHubPullVersion(string(canonical)) {
		return nil
	}
	var previous gitHubIssueHeader
	if err := json.Unmarshal(current.Object, &previous); err != nil {
		return gitHubFetchUnavailable()
	}
	old, incoming := parseGitHubTimestamp(previous.UpdatedAt), parseGitHubTimestamp(header.UpdatedAt)
	if old.Valid && incoming.Valid && incoming.Time.After(old.Time) {
		return nil
	}
	return gitHubFetchUnavailable()
}
