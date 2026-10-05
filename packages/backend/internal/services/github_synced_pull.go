package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// pollInstallPull is called by the existing TODO follow loop, not a second
// scheduler. It stores detail responses in the same pull cache as list reads
// and admits the same durable, versioned consumer delivery.
func (s *GitHubSyncedRepoService) pollInstallPull(ctx context.Context, row db.GithubSyncedRepo, number int64) (err error) {
	if err = s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	if number <= 0 || !s.hasConditionalFetcher() {
		return gitHubFetchUnavailable()
	}
	resource := "pulls/" + strconv.FormatInt(number, 10)
	key := gitHubPageKey{gitHubStreamKey: syncedStreamKey(row, resource)}
	s.install.mu.Lock()
	validator := s.install.etags[key]
	s.install.mu.Unlock()
	defer func() {
		s.install.mu.Lock()
		defer s.install.mu.Unlock()
		state := s.install.streams[key.gitHubStreamKey]
		state.lastError, state.retryAt = err, s.budget.StreamRetryAt(row.InstallationID.Int64, "pulls")
		if err == nil {
			state.lastSuccess = s.now()
		}
		s.install.streams[key.gitHubStreamKey] = state
	}()
	// Respect a pause before the fetcher can mint an installation token.
	if at := s.budget.StreamRetryAt(row.InstallationID.Int64, "pulls"); at.After(s.now()) {
		return GitHubRateLimitError(http.StatusTooManyRequests, http.Header{"Retry-After": {at.UTC().Format(http.TimeFormat)}}, s.now())
	}
	// List reads or another detail read may have replaced the cache. ETags are
	// usable only while the exact representation they validated is still there.
	if validator.etag != "" {
		version, readErr := s.cachedPullVersion(ctx, s.install.pool, row.ID, number)
		if readErr != nil {
			return readErr
		}
		if version != validator.objectVersion {
			validator = gitHubPageValidator{}
		}
	}
	fetch := s.conditionalFetcherFactory(row)
	if fetch == nil {
		return gitHubFetchUnavailable()
	}
	page, err := fetch(ctx, resource, nil, validator.etag)
	if err != nil {
		return err
	}
	var version string
	err = pgx.BeginFunc(ctx, s.install.pool, func(tx pgx.Tx) error {
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
		if page.NotModified {
			if validator.etag == "" {
				return GitHubRequestFailure(ctx, "GitHub returned 304 without a committed pull validator")
			}
			version, err = s.cachedPullVersion(ctx, tx, row.ID, number)
			if err != nil {
				return err
			}
			if version != validator.objectVersion {
				return gitHubFetchUnavailable()
			}
			return nil
		}
		var pull mythicalGitHubPull
		if json.Unmarshal(page.Body, &pull) != nil || pull.Number != number || pull.Head.SHA == "" || (pull.State != "open" && pull.State != "closed") {
			return GitHubRequestFailure(ctx, "GitHub returned an invalid pull request")
		}
		if err := s.commitFetchedIssue(ctx, tx, row, GitHubRepoMetadataPulls, page.Body); err != nil {
			return err
		}
		// A late response older than the cache is ignored by commitFetchedIssue.
		// Do not associate its validator with the newer cached representation.
		var canonical string
		if err := tx.QueryRow(ctx, `SELECT $1::jsonb::text`, page.Body).Scan(&canonical); err != nil {
			return err
		}
		expected := gitHubPullVersion(canonical)
		version, err = s.cachedPullVersion(ctx, tx, row.ID, number)
		if err != nil {
			return err
		}
		if version != expected {
			version = ""
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !page.NotModified {
		s.install.mu.Lock()
		if s.install.etags == nil {
			s.install.etags = make(map[gitHubPageKey]gitHubPageValidator)
		}
		if page.ETag != "" && version != "" {
			s.install.etags[key] = gitHubPageValidator{etag: page.ETag, objectVersion: version}
		} else {
			delete(s.install.etags, key)
		}
		s.install.mu.Unlock()
	}
	return nil
}

func (s *GitHubSyncedRepoService) cachedPullVersion(ctx context.Context, q db.DBTX, row, number int64) (string, error) {
	var canonical string
	err := q.QueryRow(ctx, `SELECT payload::text FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2`, row, number).Scan(&canonical)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return gitHubPullVersion(canonical), nil
}

func gitHubPullVersion(canonical string) string {
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:])
}
