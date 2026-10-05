package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	GitHubRepoMetadataIssues = "issues"
	GitHubRepoMetadataPulls  = "pulls"

	// GitHub caps these collection endpoints at 100 rows. Eight MiB is large
	// enough for 100 issue or pull-request objects (including their bodies),
	// while keeping an unexpectedly large upstream response from consuming
	// unbounded API-server memory.
	githubRepoMetadataMaxResponseBytes int64 = 8 << 20
	githubRepoMetadataMaxPage                = 10_000
	githubRepoMetadataMaxFilterLength        = 1_024
)

// GitHubRepoMetadataResult preserves GitHub's already-validated JSON object or
// array bytes without coupling the Plue API to GitHub's large repository,
// issue, and pull-request schemas. Preserving the bytes also keeps the
// service's 8 MiB ceiling true at
// the HTTP boundary: re-encoding RawMessages with HTML escaping could otherwise
// expand a response several-fold.
type GitHubRepoMetadataResult struct {
	Body json.RawMessage
	Link string

	// Provenance, set only when the result came from the continuously-synced
	// store (github_synced_repos). Surfaced to clients as X-Metadata-Source /
	// X-Metadata-Synced-At / X-Metadata-Sync-Error, like X-Repos-Synced-At does
	// for the repo listing cache. Empty Source means the live passthrough.
	Source    string
	SyncedAt  *time.Time
	Stale     bool
	SyncError string
}

const (
	// GitHubRepoMetadataSourceStore / Live are the values of X-Metadata-Source.
	GitHubRepoMetadataSourceStore = "store"
	GitHubRepoMetadataSourceLive  = "live"
)

// GetAuthenticatedUserGitHubRepo reads one GitHub repository object using the
// signed-in user's OAuth credential. Unlike Plue repo APIs, it does not require
// the repository to have been imported or included in /user/repos affiliation
// filters, so any public (or user-visible private) GitHub repository can be
// selected as read-only context.
func (s *GitHubUserReposService) GetAuthenticatedUserGitHubRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (GitHubRepoMetadataResult, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubRepoMetadataResult{}, pkgerrors.Internal("github repository metadata service unavailable")
	}
	if userID <= 0 {
		return GitHubRepoMetadataResult{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, err := normalizeGitHubRepoMetadataSegment(owner, "owner")
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	normalizedRepo, err := normalizeGitHubRepoMetadataSegment(repo, "repository")
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}

	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	result, err := s.requestGitHubRepoObject(ctx, accessToken, normalizedOwner, normalizedRepo)
	if err != nil && isGitHubTokenExpired(err) {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			result, err = s.requestGitHubRepoObject(ctx, newToken, normalizedOwner, normalizedRepo)
		} else {
			err = refreshErr
		}
	}
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	return result, nil
}

// GetAuthenticatedUserGitHubPull reads one PR through the same user-owned
// credential as the list. A typed PR number need not be on its first page.
func (s *GitHubUserReposService) GetAuthenticatedUserGitHubPull(ctx context.Context, userID int64, owner, repo string, number int64) (GitHubRepoMetadataResult, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubRepoMetadataResult{}, pkgerrors.Internal("github repository metadata service unavailable")
	}
	if userID <= 0 {
		return GitHubRepoMetadataResult{}, pkgerrors.Unauthorized("authentication required")
	}
	if number <= 0 || number > 9007199254740991 {
		return GitHubRepoMetadataResult{}, pkgerrors.BadRequest("invalid github pull request number")
	}
	normalizedOwner, err := normalizeGitHubRepoMetadataSegment(owner, "owner")
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	normalizedRepo, err := normalizeGitHubRepoMetadataSegment(repo, "repository")
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	read := func(token string) (GitHubRepoMetadataResult, error) {
		path := strings.TrimRight(githubAPIBaseURL(), "/") + "/repos/" + url.PathEscape(normalizedOwner) + "/" + url.PathEscape(normalizedRepo) + "/pulls/" + strconv.FormatInt(number, 10)
		return s.requestGitHubRepoRaw(ctx, token, path, '{')
	}
	token, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	result, err := read(token)
	if err != nil && isGitHubTokenExpired(err) {
		if refreshed, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			result, err = read(refreshed)
		} else {
			err = refreshErr
		}
	}
	return result, err
}

// ListAuthenticatedUserGitHubRepoMetadata reads issues or pull requests for
// any repository visible to the signed-in user's own GitHub OAuth credential.
// It deliberately does not resolve or import a Plue repository first.
func (s *GitHubUserReposService) ListAuthenticatedUserGitHubRepoMetadata(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	resource string,
	rawQuery url.Values,
) (GitHubRepoMetadataResult, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubRepoMetadataResult{}, pkgerrors.Internal("github repository metadata service unavailable")
	}
	if userID <= 0 {
		return GitHubRepoMetadataResult{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, err := normalizeGitHubRepoMetadataSegment(owner, "owner")
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	normalizedRepo, err := normalizeGitHubRepoMetadataSegment(repo, "repository")
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	normalizedResource, err := normalizeGitHubRepoMetadataResource(resource)
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	query, err := normalizeGitHubRepoMetadataQuery(normalizedResource, rawQuery)
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}

	// Serve from the continuously-synced store when this repo is enrolled, has
	// last-good rows, and this user's own credential read it live recently (the
	// store is shared, so only a fresh read grant authorizes it). The live
	// passthrough below is the FALLBACK (no grant, unenrolled repos, store
	// misses, filters the store does not model).
	if s.syncedRepos != nil {
		grant := s.syncedRepos.ReadGrant(ctx, userID, normalizedOwner, normalizedRepo)
		fetch := s.syncedRepoBackfillFetcher(userID, normalizedOwner, normalizedRepo)
		if page, served := s.syncedRepos.ServeMetadata(
			ctx, grant, normalizedResource, query, fetch,
		); served {
			syncedAt := page.SyncedAt
			return GitHubRepoMetadataResult{
				Body:      page.Body,
				Link:      page.Link,
				Source:    GitHubRepoMetadataSourceStore,
				SyncedAt:  &syncedAt,
				Stale:     page.Stale,
				SyncError: page.SyncError,
			}, nil
		}
	}

	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}

	result, err := s.requestGitHubRepoMetadata(ctx, accessToken, normalizedOwner, normalizedRepo, normalizedResource, query)
	if err != nil && isGitHubTokenExpired(err) {
		// GitHub App user tokens expire. Rotate the token once on an actual 401
		// and retry; a 403 is an access/rate-limit response and must not consume
		// a single-use refresh token.
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			result, err = s.requestGitHubRepoMetadata(ctx, newToken, normalizedOwner, normalizedRepo, normalizedResource, query)
		} else {
			err = refreshErr
		}
	}
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	// The live read just proved this user's token can see the repo: stamp the
	// user's read grant and lazily enroll. Both are idempotent and run detached
	// so the read path never waits on them; the NEXT read is served from the store.
	s.recordSyncedRepoAccess(userID, normalizedOwner, normalizedRepo)
	result.Source = GitHubRepoMetadataSourceLive
	return result, nil
}

// recordSyncedRepoAccess runs after a successful live read with the user's own
// credential. It stamps the user's read grant, then adds the repo to the sync
// registry, in the background. Failures are logged and dropped: both are
// optimizations, never a reason to fail a read that already succeeded; a
// missing grant only sends the next read live again.
func (s *GitHubUserReposService) recordSyncedRepoAccess(userID int64, owner, repo string) {
	if s.syncedRepos == nil {
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("github synced repo lazy enrollment panicked", "owner", owner, "repo", repo, "panic", fmt.Sprint(r))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.syncedRepos.RecordReadGrant(ctx, userID, owner, repo); err != nil {
			slog.Warn("github synced repo read grant not recorded", "user_id", userID, "owner", owner, "repo", repo, "error", err)
		}
		row, err := s.syncedRepos.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
			Owner:       owner,
			Repo:        repo,
			EnrolledVia: GitHubSyncedRepoEnrolledViaLazy,
			// A lazy read proves visibility, not a mirror namespace to push
			// refs into — metadata only until an import creates the mirror.
			MetadataOnly: true,
		})
		if err != nil {
			slog.Warn("github synced repo lazy enrollment failed", "owner", owner, "repo", repo, "error", err)
			return
		}
		// First enrollment has no last-good rows yet: prime the store so the very
		// next read is served from it instead of going live again.
		if !row.LastSyncedAt.Valid {
			s.syncedRepos.scheduleBackfill(row, s.syncedRepoBackfillFetcher(userID, owner, repo))
		}
		if s.enrollDone != nil {
			s.enrollDone(owner, repo)
		}
	}()
}

// syncedRepoBackfillFetcher binds one user's GitHub credential to a page fetch
// the store service can call from a background goroutine. It resolves the token
// per call (never captures one) because a backfill can start minutes after the
// request that scheduled it, by which point the token may have rotated.
func (s *GitHubUserReposService) syncedRepoBackfillFetcher(userID int64, owner, repo string) gitHubSyncedRepoPageFetcher {
	return func(ctx context.Context, resource string, query url.Values) (json.RawMessage, error) {
		accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
		if err != nil {
			return nil, err
		}
		result, err := s.requestGitHubRepoMetadata(ctx, accessToken, owner, repo, resource, query)
		if err != nil && isGitHubTokenExpired(err) {
			if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
				result, err = s.requestGitHubRepoMetadata(ctx, newToken, owner, repo, resource, query)
			} else {
				err = refreshErr
			}
		}
		if err != nil {
			return nil, err
		}
		return result.Body, nil
	}
}

// gitHubRepoMetadataPermissions reads a synced repository's issues and pulls.
var gitHubRepoMetadataPermissions = map[string]string{"issues": "read", "pull_requests": "read"}

// SyncedRepoInstallationFetcherFactory builds the R2-conformant page fetcher
// for the synced store: pages are fetched with the repo's App installation
// token (cached ~1h by the issuer), never a user's OAuth token. It resolves
// the token per call so mid-sweep expiry just re-mints.
func (s *GitHubUserReposService) SyncedRepoInstallationFetcherFactory(issuer GitHubInstallationTokenMinter) func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher {
	return func(row db.GithubSyncedRepo) GitHubSyncedRepoPageFetcher {
		if s == nil || issuer == nil || !row.InstallationID.Valid || !row.GithubRepositoryID.Valid {
			return nil
		}
		installationID := row.InstallationID.Int64
		owner, repo := row.OwnerLogin, row.RepoName
		return func(ctx context.Context, resource string, query url.Values) (json.RawMessage, error) {
			token, err := issuer.CreateGitHubInstallationToken(ctx, installationID, GitHubTokenScope{RepositoryIDs: []int64{row.GithubRepositoryID.Int64}, Permissions: gitHubRepoMetadataPermissions})
			if err != nil {
				return nil, err
			}
			result, err := s.requestGitHubRepoMetadata(ctx, token.Token, owner, repo, resource, query)
			if err != nil {
				return nil, err
			}
			return result.Body, nil
		}
	}
}

func normalizeGitHubRepoMetadataResource(resource string) (string, error) {
	switch normalized := strings.ToLower(strings.TrimSpace(resource)); normalized {
	case GitHubRepoMetadataIssues, GitHubRepoMetadataPulls:
		return normalized, nil
	default:
		return "", pkgerrors.BadRequest("unsupported github repository metadata resource")
	}
}

func normalizeGitHubRepoMetadataSegment(value string, field string) (string, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return "", pkgerrors.BadRequest(field + " is required")
	}
	if len(normalized) > 100 || normalized == "." || normalized == ".." {
		return "", pkgerrors.BadRequest("invalid github " + field)
	}
	for _, r := range normalized {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return "", pkgerrors.BadRequest("invalid github " + field)
	}
	return normalized, nil
}

func normalizeGitHubRepoMetadataQuery(resource string, rawQuery url.Values) (url.Values, error) {
	allowed := map[string]struct{}{
		"state": {}, "sort": {}, "direction": {}, "per_page": {}, "page": {}, "cursor": {},
	}
	if resource == GitHubRepoMetadataIssues {
		allowed["labels"] = struct{}{}
	} else {
		allowed["head"] = struct{}{}
		allowed["base"] = struct{}{}
	}

	query := url.Values{}
	for key, values := range rawQuery {
		if _, ok := allowed[key]; !ok {
			return nil, pkgerrors.BadRequest("unsupported github repository metadata query parameter")
		}
		if len(values) != 1 {
			return nil, pkgerrors.BadRequest("github repository metadata query parameters must have one value")
		}
		value := strings.TrimSpace(values[0])
		if value == "" {
			continue
		}

		switch key {
		case "state":
			if value != "open" && value != "closed" && value != "all" {
				return nil, pkgerrors.BadRequest("invalid github repository metadata state")
			}
		case "direction":
			if value != "asc" && value != "desc" {
				return nil, pkgerrors.BadRequest("invalid github repository metadata direction")
			}
		case "sort":
			if !validGitHubRepoMetadataSort(resource, value) {
				return nil, pkgerrors.BadRequest("invalid github repository metadata sort")
			}
		case "per_page":
			perPage, parseErr := strconv.Atoi(value)
			if parseErr != nil || perPage < 1 || perPage > githubRepoListingPageSize {
				return nil, pkgerrors.BadRequest("github repository metadata per_page must be between 1 and 100")
			}
		case "page", "cursor":
			page, parseErr := strconv.Atoi(value)
			if parseErr != nil || page < 1 || page > githubRepoMetadataMaxPage {
				return nil, pkgerrors.BadRequest("invalid github repository metadata page")
			}
		case "labels", "head", "base":
			if len(value) > githubRepoMetadataMaxFilterLength {
				return nil, pkgerrors.BadRequest("github repository metadata filter is too long")
			}
		}

		if key == "cursor" {
			if strings.TrimSpace(rawQuery.Get("page")) != "" {
				return nil, pkgerrors.BadRequest("github repository metadata page and cursor cannot both be set")
			}
			query.Set("page", value)
			continue
		}
		query.Set(key, value)
	}
	return query, nil
}

func validGitHubRepoMetadataSort(resource string, sort string) bool {
	if resource == GitHubRepoMetadataIssues {
		return sort == "created" || sort == "updated" || sort == "comments"
	}
	return sort == "created" || sort == "updated" || sort == "popularity" || sort == "long-running"
}

func (s *GitHubUserReposService) requestGitHubRepoMetadata(
	ctx context.Context,
	accessToken string,
	owner string,
	repo string,
	resource string,
	query url.Values,
) (GitHubRepoMetadataResult, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") +
		"/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/" + resource
	if encoded := query.Encode(); encoded != "" {
		upstreamURL += "?" + encoded
	}
	return s.requestGitHubRepoRaw(ctx, accessToken, upstreamURL, '[')
}

func (s *GitHubUserReposService) requestGitHubRepoObject(ctx context.Context, accessToken string, owner string, repo string) (GitHubRepoMetadataResult, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") +
		"/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
	return s.requestGitHubRepoRaw(ctx, accessToken, upstreamURL, '{')
}

func (s *GitHubUserReposService) requestGitHubRepoRaw(ctx context.Context, accessToken string, upstreamURL string, expectedTopLevel byte) (GitHubRepoMetadataResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return GitHubRepoMetadataResult{}, pkgerrors.Internal("failed to build github repository metadata request").WithCause(err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return GitHubRepoMetadataResult{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
			"github repository metadata request failed")
	}
	defer func() { _ = resp.Body.Close() }()

	if err := gitHubRepoMetadataUpstreamError(resp, s.now()); err != nil {
		return GitHubRepoMetadataResult{}, err
	}

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, githubRepoMetadataMaxResponseBytes+1))
	if readErr != nil {
		return GitHubRepoMetadataResult{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
			"failed to read github repository metadata response")
	}
	if int64(len(body)) > githubRepoMetadataMaxResponseBytes {
		return GitHubRepoMetadataResult{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
			"github repository metadata response exceeded the size limit")
	}

	trimmedBody := bytes.TrimSpace(body)
	expectedEnd := byte(']')
	if expectedTopLevel == '{' {
		expectedEnd = '}'
	}
	if len(trimmedBody) < 2 || trimmedBody[0] != expectedTopLevel || trimmedBody[len(trimmedBody)-1] != expectedEnd || !json.Valid(trimmedBody) {
		return GitHubRepoMetadataResult{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
			"failed to decode github repository metadata response")
	}
	return GitHubRepoMetadataResult{Body: json.RawMessage(body), Link: resp.Header.Get("Link")}, nil
}

func gitHubRepoMetadataUpstreamError(resp *http.Response, now time.Time) error {
	if limited := GitHubRateLimitError(resp.StatusCode, resp.Header, now); limited != nil {
		return limited
	}
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return nil
	}
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return pkgerrors.Unauthorized("github oauth token was rejected")
	case http.StatusForbidden:
		return pkgerrors.Forbidden("github denied the repository metadata request")
	case http.StatusNotFound:
		return pkgerrors.NotFound("github repository was not found")
	case http.StatusUnprocessableEntity:
		return pkgerrors.UnprocessableEntity("github rejected the repository metadata query")
	}
	if resp.StatusCode >= http.StatusBadRequest && resp.StatusCode < http.StatusInternalServerError {
		return pkgerrors.BadRequest("github rejected the repository metadata request")
	}
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
		fmt.Sprintf("github repository metadata upstream returned status %d", resp.StatusCode))
}
