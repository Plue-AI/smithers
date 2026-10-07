package services

import (
	"context"
	"net/url"
	"strconv"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ListAuthenticatedUserGitHubIssueComments reads one issue (or pull request —
// GitHub serves PR conversation comments through the issues API) comment list
// using the signed-in user's OAuth credential. When the repo is enrolled in
// the continuously-synced store and the store can serve, rows come from it
// with the usual X-Metadata-* provenance; otherwise this is a live passthrough
// (and the live read lazily enrolls the repo, like the issues/pulls proxy).
func (s *GitHubUserReposService) ListAuthenticatedUserGitHubIssueComments(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	number int64,
	rawQuery url.Values,
) (GitHubRepoMetadataResult, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubRepoMetadataResult{}, pkgerrors.Internal("github issue comments service unavailable")
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
	if number <= 0 {
		return GitHubRepoMetadataResult{}, pkgerrors.BadRequest("invalid github issue number")
	}
	query, err := normalizeGitHubIssueCommentsQuery(rawQuery)
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}

	// Serve from the continuously-synced comment store when this repo is
	// enrolled and webhook-fed and this user holds a fresh read grant; the live
	// passthrough below is the FALLBACK.
	if s.syncedRepos != nil {
		grant := s.syncedRepos.ReadGrant(ctx, userID, normalizedOwner, normalizedRepo)
		fetch := s.syncedRepoBackfillFetcher(userID, normalizedOwner, normalizedRepo)
		if page, served := s.syncedRepos.ServeComments(
			ctx, grant, number, query, fetch,
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
	result, err := s.requestGitHubIssueComments(ctx, accessToken, normalizedOwner, normalizedRepo, number, query)
	if err != nil && isGitHubTokenExpired(err) {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			result, err = s.requestGitHubIssueComments(ctx, newToken, normalizedOwner, normalizedRepo, number, query)
		} else {
			err = refreshErr
		}
	}
	if err != nil {
		return GitHubRepoMetadataResult{}, err
	}
	s.recordSyncedRepoAccess(userID, normalizedOwner, normalizedRepo)
	result.Source = GitHubRepoMetadataSourceLive
	return result, nil
}

func (s *GitHubUserReposService) requestGitHubIssueComments(
	ctx context.Context,
	accessToken string,
	owner string,
	repo string,
	number int64,
	query url.Values,
) (GitHubRepoMetadataResult, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") +
		"/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) +
		"/issues/" + strconv.FormatInt(number, 10) + "/comments"
	if encoded := query.Encode(); encoded != "" {
		upstreamURL += "?" + encoded
	}
	return s.requestGitHubRepoRaw(ctx, accessToken, upstreamURL, '[')
}

func normalizeGitHubIssueCommentsQuery(rawQuery url.Values) (url.Values, error) {
	query := url.Values{}
	for key, values := range rawQuery {
		switch key {
		case "per_page":
			if len(values) != 1 {
				return nil, pkgerrors.BadRequest("github issue comments query parameters must have one value")
			}
			perPage, parseErr := strconv.Atoi(strings.TrimSpace(values[0]))
			if parseErr != nil || perPage < 1 || perPage > githubRepoListingPageSize {
				return nil, pkgerrors.BadRequest("github issue comments per_page must be between 1 and 100")
			}
			query.Set(key, strings.TrimSpace(values[0]))
		case "page", "cursor":
			if len(values) != 1 {
				return nil, pkgerrors.BadRequest("github issue comments query parameters must have one value")
			}
			page, parseErr := strconv.Atoi(strings.TrimSpace(values[0]))
			if parseErr != nil || page < 1 || page > githubRepoMetadataMaxPage {
				return nil, pkgerrors.BadRequest("invalid github issue comments page")
			}
			if key == "cursor" {
				if strings.TrimSpace(rawQuery.Get("page")) != "" {
					return nil, pkgerrors.BadRequest("github issue comments page and cursor cannot both be set")
				}
				query.Set("page", strings.TrimSpace(values[0]))
				continue
			}
			query.Set(key, strings.TrimSpace(values[0]))
		default:
			return nil, pkgerrors.BadRequest("unsupported github issue comments query parameter")
		}
	}
	return query, nil
}
