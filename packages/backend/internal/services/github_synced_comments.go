package services

import (
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const gitHubConversationComments = "issues/comments"
const gitHubReviewComments = "pulls/comments"

// fetchedObjectHeader lets the existing updated-at pager read both numbered
// issues and repository-wide comments. Comment URLs identify their issue; they
// are validated as data and never fetched or used as an API destination.
func fetchedObjectHeader(row db.GithubSyncedRepo, resource string, object json.RawMessage) (gitHubIssueHeader, error) {
	var header gitHubIssueHeader
	if resource == gitHubConversationComments || resource == gitHubReviewComments {
		var comment gitHubCommentHeader
		if json.Unmarshal(object, &comment) != nil || comment.Body == nil {
			return header, invalidFetchedComment()
		}
		identityURL := comment.IssueURL
		if resource == gitHubReviewComments {
			var review struct {
				PullRequestURL string `json:"pull_request_url"`
			}
			_ = json.Unmarshal(object, &review)
			identityURL = strings.Replace(review.PullRequestURL, "/pulls/", "/issues/", 1)
		}
		number, ok := fetchedCommentIssue(row, identityURL)
		if !ok || !parseGitHubTimestamp(comment.CreatedAt).Valid {
			return header, invalidFetchedComment()
		}
		header = gitHubIssueHeader{ID: comment.ID, Number: number, CreatedAt: comment.CreatedAt, UpdatedAt: comment.UpdatedAt}
	} else if json.Unmarshal(object, &header) != nil {
		return header, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub returned an invalid object")
	}
	if header.ID <= 0 || header.Number <= 0 || !parseGitHubTimestamp(header.UpdatedAt).Valid {
		return header, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub returned an invalid object")
	}
	return header, nil
}

func invalidFetchedComment() error {
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub returned an invalid comment")
}

func fetchedCommentIssue(row db.GithubSyncedRepo, value string) (int64, bool) {
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return 0, false
	}
	base, err := url.Parse(githubAPIBaseURL())
	if err != nil || u.Scheme != base.Scheme || !strings.EqualFold(u.Host, base.Host) {
		return 0, false
	}
	prefix := strings.TrimRight(base.EscapedPath(), "/") + landingGitHubRepoPath(row.OwnerLogin, row.RepoName) + "/issues/"
	path := u.EscapedPath()
	if len(path) <= len(prefix) || !strings.EqualFold(path[:len(prefix)], prefix) {
		return 0, false
	}
	value = path[len(prefix):]
	n, err := strconv.ParseInt(value, 10, 64)
	return n, err == nil && n > 0 && strconv.FormatInt(n, 10) == value
}

// Commit the complete fetched interval in its caller's registry transaction.
// Edits are versions of the same comment, not new comment identities. Consumers
// decide whether an edit may still replace held input; nothing here steers a run.
func (s *GitHubSyncedRepoService) commitFetchedComments(ctx context.Context, tx pgx.Tx, row db.GithubSyncedRepo, objects []json.RawMessage) error {
	return s.commitFetchedCommentsFrom(ctx, tx, row, gitHubConversationComments, objects)
}

func (s *GitHubSyncedRepoService) commitFetchedCommentsFrom(ctx context.Context, tx pgx.Tx, row db.GithubSyncedRepo, resource string, objects []json.RawMessage) error {
	source := "conversation"
	if resource == gitHubReviewComments {
		source = "review"
	}
	type entry struct {
		header  gitHubIssueHeader
		object  json.RawMessage
		updated time.Time
	}
	entries := make([]entry, 0, len(objects))
	for _, object := range objects {
		header, err := fetchedObjectHeader(row, resource, object)
		if err != nil {
			return err
		}
		entries = append(entries, entry{header, object, parseGitHubTimestamp(header.UpdatedAt).Time})
	}
	// Deliver an initial batch oldest first; equal timestamps use stable IDs.
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].updated.Equal(entries[j].updated) {
			return entries[i].header.ID < entries[j].header.ID
		}
		return entries[i].updated.Before(entries[j].updated)
	})
	for _, e := range entries {
		h := e.header
		var stale, misbound bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM github_synced_issue_comments WHERE synced_repo_id=$1 AND source=$5 AND github_id=$2 AND github_updated_at>$3::timestamptz), EXISTS(SELECT 1 FROM github_synced_issue_comments WHERE synced_repo_id=$1 AND source=$5 AND github_id=$2 AND issue_number<>$4)`, row.ID, h.ID, h.UpdatedAt, h.Number, source).Scan(&stale, &misbound)
		if err != nil {
			return err
		}
		if misbound {
			return invalidFetchedComment()
		}
		if stale {
			continue
		}
		var canonical []byte
		if err := tx.QueryRow(ctx, `SELECT $1::jsonb::text`, e.object).Scan(&canonical); err != nil {
			return err
		}
		if err := db.New(tx).UpsertGitHubSyncedIssueComment(ctx, db.UpsertGitHubSyncedIssueCommentParams{SyncedRepoID: row.ID, IssueNumber: h.Number, GithubID: h.ID, Payload: canonical, GithubCreatedAt: parseGitHubTimestamp(h.CreatedAt), GithubUpdatedAt: parseGitHubTimestamp(h.UpdatedAt), Source: source}); err != nil {
			return err
		}

		if err := s.admitFetchedObject(ctx, tx, row, resource, h.ID, h.Number, canonical); err != nil {
			return err
		}
	}
	// Missing rows are not tombstones: incremental pages cannot prove deletion.
	return nil
}
