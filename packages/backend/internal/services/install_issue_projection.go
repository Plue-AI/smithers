package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Install reads use the existing synchronized GitHub projections. On-demand
// refresh goes through their guarded fetch/commit boundary, never a parallel
// issue cache. The app performs this read as persisted background work.
func (s *MythicalService) refreshInstallIssueProjection(ctx context.Context, gh mythicalGitHubRepo, comments bool) (db.GithubSyncedRepo, error) {
	synced := s.installGitHubSync
	if synced == nil || synced.install == nil {
		return db.GithubSyncedRepo{}, issuesUnavailable()
	}
	row, err := synced.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: gh.Owner, RepoName: gh.Name})
	if err != nil {
		return row, issuesUnavailable()
	}
	if err = synced.authorizeFetched(ctx, row); err != nil {
		return row, err
	}
	fetch := synced.preferredFetcher(row, nil)
	if fetch == nil && !synced.hasConditionalFetcher() {
		return row, issuesUnavailable()
	}
	resources := []string{GitHubRepoMetadataIssues}
	if comments {
		resources = append(resources, gitHubConversationComments)
	}
	for _, resource := range resources {
		if at := synced.budget.StreamRetryAt(row.InstallationID.Int64, metadataBudgetStream(resource)); at.After(synced.now()) {
			return row, issuesUnavailable()
		}
		if err = synced.backfillResource(ctx, row, resource, fetch); err != nil {
			return row, err
		}
	}
	return row, nil
}

func (s *MythicalService) projectedInstallIssue(ctx context.Context, gh mythicalGitHubRepo, number int64) (InstallIssueThread, bool, error) {
	row, err := s.refreshInstallIssueProjection(ctx, gh, true)
	if err != nil {
		return InstallIssueThread{}, false, err
	}
	var issueJSON, commentsJSON []byte
	// One statement fixes the issue and comment context at one database snapshot.
	err = s.store.QueryRow(ctx, `SELECT i.payload,COALESCE((SELECT jsonb_agg(c.payload ORDER BY c.github_id) FROM github_synced_issue_comments c WHERE c.synced_repo_id=i.synced_repo_id AND c.issue_number=i.number AND c.source='conversation'),'[]'::jsonb) FROM github_synced_issues i WHERE i.synced_repo_id=$1 AND i.resource='issues' AND i.number=$2`, row.ID, number).Scan(&issueJSON, &commentsJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstallIssueThread{}, false, nil
	}
	if err != nil {
		return InstallIssueThread{}, false, err
	}
	var issue gitHubListedIssue
	var comments []InstallIssueComment
	if err = json.Unmarshal(issueJSON, &issue); err != nil {
		return InstallIssueThread{}, false, err
	}
	if issue.pull() {
		return InstallIssueThread{}, false, nil
	}
	if err = json.Unmarshal(commentsJSON, &comments); err != nil {
		return InstallIssueThread{}, false, err
	}
	if issue.Comments != int64(len(comments)) {
		return InstallIssueThread{}, false, fmt.Errorf("incomplete synchronized issue discussion")
	}
	return InstallIssueThread{Issue: issue.normalized(), Comments: comments}, true, nil
}

func (s *MythicalService) projectedInstallIssues(ctx context.Context, gh mythicalGitHubRepo, state string, page int) ([]InstallIssue, error) {
	row, err := s.refreshInstallIssueProjection(ctx, gh, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.Query(ctx, `SELECT payload FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='issues' AND (payload->'pull_request' IS NULL OR payload->'pull_request'='null'::jsonb) AND ($2='all' OR payload->>'state'=$2) ORDER BY number DESC LIMIT $3 OFFSET $4`, row.ID, state, installIssuesPerPage, (page-1)*installIssuesPerPage)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	issues := []InstallIssue{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var issue gitHubListedIssue
		if err := json.Unmarshal(raw, &issue); err != nil {
			return nil, err
		}
		issues = append(issues, issue.normalized())
	}
	return issues, rows.Err()
}
