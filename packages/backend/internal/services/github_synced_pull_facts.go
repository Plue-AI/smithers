package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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
	if parts[0] == "pulls" && (parts[2] == "reviews" || parts[2] == "comments") {
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
		err := s.readInstallPullFacts(ctx, row, number, head, kind)
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

func (s *GitHubSyncedRepoService) readInstallPullFacts(ctx context.Context, row db.GithubSyncedRepo, number int64, head, kind string) error {
	if err := s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	if at := s.budget.StreamRetryAt(row.InstallationID.Int64, kind); at.After(s.now()) {
		return GitHubRateLimitError(http.StatusTooManyRequests, http.Header{"Retry-After": {at.UTC().Format(http.TimeFormat)}}, s.now())
	}
	fetch := s.conditionalFetcherFactory(row)
	if fetch == nil {
		return gitHubFetchUnavailable()
	}
	paths := []string{"pulls/" + strconv.FormatInt(number, 10) + "/reviews", "pulls/" + strconv.FormatInt(number, 10) + "/comments"}
	if kind == "checks" {
		paths = []string{"commits/" + head + "/check-runs", "commits/" + head + "/statuses"}
	}
	facts := map[string]any{"head": head}
	for _, path := range paths {
		if !gitHubPullFactResource(path) {
			return gitHubFetchUnavailable()
		}
		var objects []json.RawMessage
		for page := 1; ; page++ {
			if page > githubRepoMetadataMaxPage {
				return fmt.Errorf("GitHub pull facts exceed pagination limit")
			}
			query := url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}
			if strings.HasSuffix(path, "check-runs") {
				query.Set("filter", "latest")
			}
			response, err := fetch(ctx, path, query, "")
			if err != nil {
				return err
			}
			if response.NotModified {
				return fmt.Errorf("GitHub pull facts returned an unsolicited 304")
			}
			var entries []json.RawMessage
			body := response.Body
			if strings.HasSuffix(path, "check-runs") {
				var envelope struct {
					Runs json.RawMessage `json:"check_runs"`
				}
				if err := json.Unmarshal(body, &envelope); err != nil {
					return err
				}
				body = envelope.Runs
			}
			if len(body) == 0 || body[0] != '[' || json.Unmarshal(body, &entries) != nil {
				return fmt.Errorf("GitHub returned invalid %s facts", kind)
			}
			objects = append(objects, entries...)
			if len(entries) < 100 {
				break
			}
		}
		facts[path] = objects
	}
	body, err := json.Marshal(facts)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
		current, err := lockFetchedRepo(ctx, tx, row.ID)
		if err != nil {
			return err
		}
		if current.InstallationID != row.InstallationID || current.GithubRepositoryID != row.GithubRepositoryID || current.OwnerLogin != row.OwnerLogin || current.RepoName != row.RepoName {
			return gitHubFetchUnavailable()
		}
		if err := s.authorizeFetched(ctx, current); err != nil {
			return err
		}
		if kind == "reviews" && s.install.consumers[gitHubReviews] != nil {
			if err := s.admitFetchedReviewSnapshot(ctx, tx, row, number, facts); err != nil {
				return err
			}
		}
		result, err := tx.Exec(ctx, `UPDATE github_synced_issues SET related_facts=jsonb_set(related_facts,ARRAY[$4::text],$5::jsonb) WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2 AND payload->'head'->>'sha'=$3`, row.ID, number, head, kind, body)
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return gitHubFetchUnavailable()
		}
		return nil
	})
}
