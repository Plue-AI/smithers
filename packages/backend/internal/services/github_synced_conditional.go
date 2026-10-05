package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// GitHubSyncedRepoConditionalPage carries a page or its HTTP 304 validator.
// Bodies remain transient; the synced store is the only object cache.
type GitHubSyncedRepoConditionalPage struct {
	Body        json.RawMessage
	ETag        string
	NotModified bool
}

type GitHubSyncedRepoConditionalFetcher func(context.Context, string, url.Values, string) (GitHubSyncedRepoConditionalPage, error)

type gitHubPageKey struct {
	registry, installation, repository int64
	owner, repo, resource, query       string
}

var errGitHubPageUnchanged = errors.New("GitHub page already committed")

// SetConditionalFetcherFactory configures install transport before workers start.
// Hosted instances continue using their existing fetcher and cache policy.
func (s *GitHubSyncedRepoService) SetConditionalFetcherFactory(factory func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher) {
	s.conditionalFetcherFactory = factory
}

func (s *GitHubSyncedRepoService) hasConditionalFetcher() bool {
	return s.install != nil && s.conditionalFetcherFactory != nil
}

// conditionalPages snapshots committed validators for one stream walk. Call
// committed only after the entire interval and its deliveries commit. A failed
// page, authorization check or transaction leaves the previous validators intact.
func (s *GitHubSyncedRepoService) conditionalPages(row db.GithubSyncedRepo, fallback gitHubSyncedRepoPageFetcher) (gitHubSyncedRepoPageFetcher, func()) {
	if !s.hasConditionalFetcher() {
		return fallback, func() {}
	}
	transport := s.conditionalFetcherFactory(row)
	s.install.mu.Lock()
	known := make(map[gitHubPageKey]string)
	for key, etag := range s.install.etags {
		if key.registry == row.ID && key.installation == row.InstallationID.Int64 && key.repository == row.GithubRepositoryID.Int64 && key.owner == row.OwnerLogin && key.repo == row.RepoName {
			known[key] = etag
		}
	}
	s.install.mu.Unlock()
	pending := make(map[gitHubPageKey]string)
	fetch := func(ctx context.Context, resource string, query url.Values) (json.RawMessage, error) {
		if transport == nil {
			return nil, gitHubFetchUnavailable()
		}
		if err := s.authorizeFetched(ctx, row); err != nil {
			return nil, err
		}
		key := gitHubPageKey{row.ID, row.InstallationID.Int64, row.GithubRepositoryID.Int64, row.OwnerLogin, row.RepoName, resource, query.Encode()}
		page, err := transport(ctx, resource, query, known[key])
		if err != nil {
			return nil, err
		}
		if page.NotModified {
			if known[key] == "" {
				return nil, errors.New("GitHub returned 304 without a committed validator")
			}
			return nil, errGitHubPageUnchanged
		}
		pending[key] = page.ETag
		return page.Body, nil
	}
	return fetch, func() {
		s.install.mu.Lock()
		defer s.install.mu.Unlock()
		if s.install.etags == nil {
			s.install.etags = make(map[gitHubPageKey]string)
		}
		for key, etag := range pending {
			if etag == "" {
				delete(s.install.etags, key)
			} else {
				s.install.etags[key] = etag
			}
		}
	}
}

// SyncedRepoConditionalFetcherFactory uses the shared GitHub transport and
// installation-scoped token cache. It does not retain response bodies or ETags.
func (s *GitHubUserReposService) SyncedRepoConditionalFetcherFactory(issuer GitHubInstallationTokenMinter) func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
	return func(row db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
		if s == nil || issuer == nil || !row.InstallationID.Valid || !row.GithubRepositoryID.Valid {
			return nil
		}
		api := &landingGitHubAPI{client: s.httpClient, baseURL: githubAPIBaseURL}
		return func(ctx context.Context, resource string, query url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
			var page GitHubSyncedRepoConditionalPage
			switch resource {
			case GitHubRepoMetadataIssues, GitHubRepoMetadataPulls, gitHubIssueEvents:
			default:
				return page, errors.New("unsupported GitHub install stream")
			}
			token, err := issuer.CreateGitHubInstallationToken(ctx, row.InstallationID.Int64, GitHubTokenScope{RepositoryIDs: []int64{row.GithubRepositoryID.Int64}, Permissions: gitHubRepoMetadataPermissions})
			if err != nil {
				return page, err
			}
			path := landingGitHubRepoPath(row.OwnerLogin, row.RepoName) + "/" + resource + "?" + query.Encode()
			status, headers, err := api.requestHeaders(ctx, token.Token, http.MethodGet, path, etag, nil, &page.Body)
			if err != nil {
				return page, err
			}
			if status != http.StatusOK && status != http.StatusNotModified {
				return page, landingGitHubStatusError(status, row.OwnerLogin, row.RepoName, "read repository metadata")
			}
			page.NotModified = status == http.StatusNotModified
			page.ETag = headers.Get("ETag")
			return page, nil
		}
	}
}
