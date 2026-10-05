package services

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	// githubPullDiffMaxResponseBytes caps one proxied PR diff. Diffs are
	// unbounded upstream (generated over every changed file), so unlike the
	// 8 MiB JSON metadata ceiling this one is deliberately tighter: anything
	// past it gets a typed too-large verdict instead of unbounded API-server
	// memory use.
	githubPullDiffMaxResponseBytes int64 = 2 << 20
)

// CodeGitHubPullDiffTooLarge is the typed verdict a client keys on to render
// an honest "diff too large to display" state instead of a generic failure.
const CodeGitHubPullDiffTooLarge = pkgerrors.CodeGitHubPullDiffTooLarge

// GitHubPullDiffResult carries the raw unified-diff bytes. Unlike the JSON
// metadata results there is no store provenance: diffs are always a live
// passthrough (the synced store does not model patches).
type GitHubPullDiffResult struct {
	Body []byte
}

// GetAuthenticatedUserGitHubPullDiff proxies one pull request's diff from
// GitHub (Accept: application/vnd.github.diff) with the same per-user OAuth
// token resolution and single 401-refresh as the metadata proxy.
func (s *GitHubUserReposService) GetAuthenticatedUserGitHubPullDiff(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	number int64,
) (GitHubPullDiffResult, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubPullDiffResult{}, pkgerrors.Internal("github pull diff service unavailable")
	}
	if userID <= 0 {
		return GitHubPullDiffResult{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, err := normalizeGitHubRepoMetadataSegment(owner, "owner")
	if err != nil {
		return GitHubPullDiffResult{}, err
	}
	normalizedRepo, err := normalizeGitHubRepoMetadataSegment(repo, "repository")
	if err != nil {
		return GitHubPullDiffResult{}, err
	}
	if number <= 0 {
		return GitHubPullDiffResult{}, pkgerrors.BadRequest("invalid github pull request number")
	}

	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return GitHubPullDiffResult{}, err
	}
	result, err := s.requestGitHubPullDiff(ctx, accessToken, normalizedOwner, normalizedRepo, number)
	if err != nil && isGitHubTokenExpired(err) {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			result, err = s.requestGitHubPullDiff(ctx, newToken, normalizedOwner, normalizedRepo, number)
		} else {
			err = refreshErr
		}
	}
	if err != nil {
		return GitHubPullDiffResult{}, err
	}
	return result, nil
}

func (s *GitHubUserReposService) requestGitHubPullDiff(
	ctx context.Context,
	accessToken string,
	owner string,
	repo string,
	number int64,
) (GitHubPullDiffResult, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") +
		"/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/pulls/" +
		strconv.FormatInt(number, 10)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return GitHubPullDiffResult{}, pkgerrors.Internal("failed to build github pull diff request").WithCause(err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github.diff")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return GitHubPullDiffResult{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
			"github pull diff request failed")
	}
	defer func() { _ = resp.Body.Close() }()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, githubPullDiffMaxResponseBytes+1))
	if readErr != nil {
		return GitHubPullDiffResult{}, pkgerrors.New(pkgerrors.CodeGitHubUnavailable,
			"failed to read github pull diff response")
	}
	if int64(len(body)) > githubPullDiffMaxResponseBytes {
		return GitHubPullDiffResult{}, &pkgerrors.APIError{
			Status:  http.StatusBadGateway,
			Code:    CodeGitHubPullDiffTooLarge,
			Message: "github pull diff exceeded the size limit",
		}
	}

	if err := gitHubRepoMetadataUpstreamError(resp, s.now()); err != nil {
		return GitHubPullDiffResult{}, err
	}
	return GitHubPullDiffResult{Body: body}, nil
}
