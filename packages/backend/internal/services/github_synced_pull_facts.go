package services

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Pull facts run on the existing per-TODO follow loop. They never approve a
// review or authorize a merge; GitHub and the human merge gate retain authority.
type gitHubPullFactStreams struct {
	service *GitHubSyncedRepoService
	kind    string
}

func (s *GitHubSyncedRepoService) PullFactStreams(kind string) GitHubSyncStreams {
	return gitHubPullFactStreams{s, kind}
}
func (g gitHubPullFactStreams) RequiredStreams(ctx context.Context) ([]GitHubSyncStream, error) {
	s := g.service
	if g.kind != "checks" && g.kind != "reviews" {
		return nil, githubSyncUnavailable()
	}
	rows, err := s.readyInstallSyncRows(ctx)
	if err != nil {
		return nil, err
	}
	if !s.install.pullFacts || s.install.requiredPullFacts == nil {
		return nil, githubSyncUnavailable()
	}
	var streams []GitHubSyncStream
	for _, row := range rows {
		facts, err := s.install.requiredPullFacts(ctx, row, g.kind)
		if err != nil {
			return nil, err
		}
		streams = append(streams, facts...)
		if g.kind == "reviews" {
			streams = append(streams, s.syncStreamObservation(row, gitHubReviewComments, "review-comments"))
		}
	}
	return streams, nil
}
func (g gitHubPullFactStreams) RetryStreams(ctx context.Context) error {
	return g.service.RetryStreams(ctx)
}

// Validate resource paths before minting scoped read credentials.
func gitHubPullFactResource(resource string) bool {
	parts := strings.Split(resource, "/")
	if len(parts) != 3 {
		return false
	}
	if (parts[0] == "pulls" && (parts[2] == "reviews" || parts[2] == "comments")) || (parts[0] == "issues" && parts[2] == "comments") {
		n, err := strconv.ParseInt(parts[1], 10, 64)
		return err == nil && n > 0 && strconv.FormatInt(n, 10) == parts[1]
	}
	if parts[0] != "commits" || (parts[2] != "check-runs" && parts[2] != "statuses") {
		return false
	}
	if len(parts[1]) != 40 && len(parts[1]) != 64 {
		return false
	}
	for _, c := range parts[1] {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
func gitHubPullFactPermissions(resource string) map[string]string {
	if strings.HasPrefix(resource, "commits/") {
		return map[string]string{"checks": "read", "statuses": "read", "contents": "read"}
	}
	return gitHubRepoMetadataPermissions
}

func (s *GitHubSyncedRepoService) pollInstallPullFacts(ctx context.Context, row db.GithubSyncedRepo, number int64) error {
	var head string
	if err := s.install.pool.QueryRow(ctx, `SELECT payload->'head'->>'sha' FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2`, row.ID, number).Scan(&head); err != nil {
		return err
	}
	var failures []error
	for _, kind := range []string{"checks", "reviews"} {
		err := s.ReadInstallPullFacts(ctx, row, number, head, kind)
		s.install.mu.Lock()
		key := syncedStreamKey(row, kind+"/"+strconv.FormatInt(number, 10))
		state := s.install.streams[key]
		state.lastError = err
		state.retryAt = s.budget.StreamRetryAt(row.InstallationID.Int64, kind)
		if err == nil {
			state.lastSuccess = s.now()
			state.retryAt = time.Time{}
		}
		s.install.streams[key] = state
		s.install.mu.Unlock()
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// ReadInstallPullFacts refreshes one TODO PR through the shared guarded reader.
func (s *GitHubSyncedRepoService) ReadInstallPullFacts(ctx context.Context, row db.GithubSyncedRepo, number int64, head, kind string) error {
	if kind != "checks" && kind != "reviews" {
		return gitHubFetchUnavailable()
	}
	paths := []string{"pulls/" + strconv.FormatInt(number, 10) + "/reviews", "pulls/" + strconv.FormatInt(number, 10) + "/comments", "issues/" + strconv.FormatInt(number, 10) + "/comments"}
	if kind == "checks" {
		paths = []string{"commits/" + head + "/check-runs", "commits/" + head + "/statuses"}
	}
	return s.pollInstallRelated(ctx, row, number, head, kind, paths)
}
