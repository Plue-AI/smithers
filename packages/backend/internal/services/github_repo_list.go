package services

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// firstGitHubInstalledRepoForUserSQL finds an installation covering one of the
// user's connected repositories, by persisted repository id.
const firstGitHubInstalledRepoForUserSQL = `
SELECT gir.installation_id
FROM repo_connections rc
JOIN github_app_installation_repositories gir
  ON gir.github_repository_id = rc.github_repository_id
WHERE rc.user_id = $1
ORDER BY gir.updated_at DESC, gir.created_at DESC
LIMIT 1;
`

const userConnectedRepositoryIDsSQL = `
SELECT COALESCE(array_agg(github_repository_id), '{}'::bigint[])
FROM repo_connections
WHERE user_id = $1 AND github_repository_id IS NOT NULL;
`

type GitHubRepoListDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type GitHubRepoListService struct {
	db          GitHubRepoListDB
	tokenIssuer GitHubInstallationTokenMinter
	httpClient  *http.Client
}

type GitHubRepoListOption func(*GitHubRepoListService)

func WithGitHubRepoListHTTPClient(client *http.Client) GitHubRepoListOption {
	return func(s *GitHubRepoListService) {
		if client != nil {
			s.httpClient = client
		}
	}
}

func NewGitHubRepoListService(db GitHubRepoListDB, tokenIssuer GitHubInstallationTokenMinter, opts ...GitHubRepoListOption) *GitHubRepoListService {
	s := &GitHubRepoListService{
		db:          db,
		tokenIssuer: tokenIssuer,
		httpClient:  observability.NewHTTPClient(15 * time.Second),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

type GitHubRepoOwner struct {
	Login string `json:"login"`
}

type GitHubRepoListItem struct {
	ID              any             `json:"id"`
	FullName        string          `json:"full_name"`
	Owner           GitHubRepoOwner `json:"owner"`
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	Private         bool            `json:"private"`
	DefaultBranch   string          `json:"default_branch"`
	HTMLURL         string          `json:"html_url"`
	StarsCount      int64           `json:"stars_count"`
	ForksCount      int64           `json:"forks_count"`
	OpenIssuesCount int64           `json:"open_issues_count"`
	PushedAt        string          `json:"pushed_at"`
	UpdatedAt       string          `json:"updated_at"`
}

type GitHubRepoListResult struct {
	Repos []GitHubRepoListItem
	Link  string

	// Cache staleness metadata, set only when the result was served from the
	// per-user github_repo_listings cache (stale-while-revalidate). Surfaced
	// to clients as X-Repos-Synced-At / X-Repos-Sync-Error response headers.
	CacheSyncedAt  *time.Time
	CacheSyncError string
}

func (s *GitHubRepoListService) ListInstallationRepositories(ctx context.Context, userID int64, rawQuery url.Values) (GitHubRepoListResult, error) {
	if s == nil || s.db == nil || s.tokenIssuer == nil {
		return GitHubRepoListResult{}, pkgerrors.Internal("github repo list service unavailable")
	}
	if userID <= 0 {
		return GitHubRepoListResult{}, pkgerrors.Unauthorized("authentication required")
	}

	var installationID int64
	err := s.db.QueryRow(ctx, firstGitHubInstalledRepoForUserSQL, userID).Scan(&installationID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return GitHubRepoListResult{}, pkgerrors.Unauthorized("github app is not installed for this user")
		}
		return GitHubRepoListResult{}, pkgerrors.Internal("failed to resolve github installation").WithCause(err)
	}

	token, err := s.tokenIssuer.CreateGitHubInstallationToken(ctx, installationID, GitHubTokenScope{AllRepositories: true, Permissions: gitHubListingPermissions})
	if err != nil {
		return GitHubRepoListResult{}, err
	}

	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") + "/installation/repositories"
	q := url.Values{}
	for _, key := range []string{"visibility", "sort", "direction", "per_page", "page"} {
		if value := strings.TrimSpace(rawQuery.Get(key)); value != "" {
			q.Set(key, value)
		}
	}
	if cursor := strings.TrimSpace(rawQuery.Get("cursor")); cursor != "" {
		q.Set("page", cursor)
	}
	if encoded := q.Encode(); encoded != "" {
		upstreamURL += "?" + encoded
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return GitHubRepoListResult{}, pkgerrors.Internal("failed to build github repositories request").WithCause(err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token.Token))
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return GitHubRepoListResult{}, pkgerrors.Internal("github repositories request failed").WithCause(err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		invalidateCachedInstallationToken(token.InstallationID)
		return GitHubRepoListResult{}, pkgerrors.Unauthorized("github installation token was rejected")
	}
	if resp.StatusCode == http.StatusForbidden {
		return GitHubRepoListResult{}, pkgerrors.Forbidden(githubRepoListUpstreamErrorMessage(body, "github repositories request was forbidden"))
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return GitHubRepoListResult{}, pkgerrors.Internal("github repositories request was rejected")
	}

	var payload struct {
		Repositories []GitHubRepoListItem `json:"repositories"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return GitHubRepoListResult{}, pkgerrors.Internal("failed to decode github repositories response").WithCause(err)
	}

	// The installation token grants visibility over EVERY repository in the
	// GitHub App installation, but the caller is only authorized for the repos
	// they explicitly connected: intersect the upstream listing with the
	// caller's repo_connections so one connection cannot enumerate other
	// (private) repos sharing the installation.
	var connectedIDs []int64
	if err := s.db.QueryRow(ctx, userConnectedRepositoryIDsSQL, userID).Scan(&connectedIDs); err != nil {
		return GitHubRepoListResult{}, pkgerrors.Internal("failed to load repo connections").WithCause(err)
	}
	repos := make([]GitHubRepoListItem, 0, len(payload.Repositories))
	for _, item := range payload.Repositories {
		if id, ok := item.ID.(float64); ok && slices.Contains(connectedIDs, int64(id)) {
			repos = append(repos, item)
		}
	}

	return GitHubRepoListResult{Repos: repos, Link: resp.Header.Get("Link")}, nil
}

func githubRepoListUpstreamErrorMessage(body []byte, fallback string) string {
	var payload struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &payload)
	if message := strings.TrimSpace(payload.Message); message != "" {
		return message
	}
	return fallback
}
