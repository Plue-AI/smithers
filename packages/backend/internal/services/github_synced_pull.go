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
func (s *GitHubSyncedRepoService) pollInstallPull(ctx context.Context, row db.GithubSyncedRepo, number int64) error {
	return s.pollInstallPullRead(ctx, row, number, false)
}

func (s *GitHubSyncedRepoService) pollInstallPullRead(ctx context.Context, row db.GithubSyncedRepo, number int64, fresh bool) (err error) {
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
	var after int64
	if fresh {
		previous, err := latestPullObservation(ctx, s.install.pool, row, number)
		if err != nil {
			return err
		}
		after = previous.PullObservation
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
	read, err := s.beginPullRead(ctx, row, number)
	if err != nil {
		return err
	}
	page, err := fetch(ctx, resource, nil, validator.etag)
	if err != nil {
		return err
	}
	if !page.NotModified {
		page.Body, err = s.pullCloser(ctx, row, page.Body)
		if err != nil {
			return err
		}
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
			// Existing caches can predate numbered observations. Admit that
			// snapshot once; subsequent 304s reuse the same pending/settled job.
			var canonical []byte
			if err := tx.QueryRow(ctx, `SELECT payload::text FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2`, row.ID, number).Scan(&canonical); err != nil {
				return err
			}
			var header gitHubIssueHeader
			if err := json.Unmarshal(canonical, &header); err != nil || header.ID <= 0 {
				return gitHubFetchUnavailable()
			}
			return s.admitFetchedObjectAfter(ctx, tx, row, GitHubRepoMetadataPulls, header.ID, number, canonical, after)
		}
		var pull mythicalGitHubPull
		if json.Unmarshal(page.Body, &pull) != nil || pull.Number != number || pull.Head.SHA == "" || (pull.State != "open" && pull.State != "closed") {
			return GitHubRequestFailure(ctx, "GitHub returned an invalid pull request")
		}
		if err := s.commitFetchedIssue(ctx, tx, row, GitHubRepoMetadataPulls, read, page.Body); err != nil {
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
			if fresh {
				return gitHubFetchUnavailable()
			}
		} else if fresh {
			var header gitHubIssueHeader
			if err := json.Unmarshal(page.Body, &header); err != nil {
				return err
			}
			return s.admitFetchedObjectAfter(ctx, tx, row, GitHubRepoMetadataPulls, header.ID, number, json.RawMessage(canonical), after)
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

// Caller holds the synced repository row while admitting a new observation.
// Readers use the same retained jobs ledger, not a second lifecycle queue.
func latestPullObservation(ctx context.Context, q db.DBTX, row db.GithubSyncedRepo, number int64) (gitHubFetchedObject, error) {
	var fact gitHubFetchedObject
	var raw []byte
	err := q.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE tenant_id=$1 AND principal_id='pulls' AND operation=$2 AND (payload->>'repo')::bigint=$3 AND (payload->>'number')::bigint=$4 ORDER BY COALESCE((payload->>'pull_observation')::bigint,0) DESC,created_at DESC,id DESC LIMIT 1`,
		"github:"+strconv.FormatInt(row.InstallationID.Int64, 10)+":"+strconv.FormatInt(row.GithubRepositoryID.Int64, 10), githubFetchedOperation, row.ID, number).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return fact, nil
	}
	if err != nil {
		return fact, err
	}
	if err := json.Unmarshal(raw, &fact); err != nil || fact.PullObservation < 0 {
		return gitHubFetchedObject{}, gitHubFetchUnavailable()
	}
	return fact, nil
}

// GitHub carries closed_by on the issue representation, not the pull detail.
// Read it before admitting the lifecycle receipt; a trailing/reopened issue
// cannot attribute an older close. Null attribution remains an honest close.
func (s *GitHubSyncedRepoService) pullCloser(ctx context.Context, row db.GithubSyncedRepo, raw json.RawMessage) (json.RawMessage, error) {
	var pull struct {
		Number   int64           `json:"number"`
		State    string          `json:"state"`
		MergedAt json.RawMessage `json:"merged_at"`
		ClosedAt json.RawMessage `json:"closed_at"`
	}
	if err := json.Unmarshal(raw, &pull); err != nil {
		return nil, err
	}
	if pull.State != "closed" || len(pull.MergedAt) > 0 && string(pull.MergedAt) != "null" {
		return raw, nil
	}
	if !s.hasConditionalFetcher() {
		return nil, gitHubFetchUnavailable()
	}
	fetch := s.conditionalFetcherFactory(row)
	if fetch == nil {
		return nil, gitHubFetchUnavailable()
	}
	page, err := fetch(ctx, "issues/"+strconv.FormatInt(pull.Number, 10), nil, "")
	if err != nil {
		return nil, err
	}
	var issue struct {
		Number   int64           `json:"number"`
		State    string          `json:"state"`
		ClosedAt json.RawMessage `json:"closed_at"`
		ClosedBy json.RawMessage `json:"closed_by"`
	}
	if page.NotModified || json.Unmarshal(page.Body, &issue) != nil || issue.Number != pull.Number || issue.State != "closed" || string(issue.ClosedAt) != string(pull.ClosedAt) {
		return nil, GitHubRequestFailure(ctx, "GitHub close attribution trails the pull request")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	delete(object, "closed_by")
	if len(issue.ClosedBy) > 0 {
		object["closed_by"] = issue.ClosedBy
	}
	return json.Marshal(object)
}
