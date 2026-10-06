package services

import (
	"net/url"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// GitHub's since filter is exclusive and timestamps can share a second. Keep
// the actual newest timestamp as the cursor; overlap its whole second when
// querying so a later edit in that second cannot disappear behind the cursor.
func githubUpdatedBoundary(cursor time.Time) time.Time {
	if cursor.IsZero() {
		return time.Time{}
	}
	return cursor.UTC().Truncate(time.Second).Add(-time.Second)
}

func (s *GitHubSyncedRepoService) fetchedUpdatedCursor(row db.GithubSyncedRepo, resource string) time.Time {
	if s.install == nil {
		return time.Time{}
	}
	s.install.mu.Lock()
	defer s.install.mu.Unlock()
	return s.install.streams[syncedStreamKey(row, resource)].updated
}

// Called only after cache and delivery commit. Stale concurrent walks never
// regress the cursor. Old issue-query validators are no longer useful once
// since advances; retain only the current URL family, without caching bodies.
func (s *GitHubSyncedRepoService) advanceUpdatedCursor(row db.GithubSyncedRepo, resource string, newest time.Time) {
	s.install.mu.Lock()
	defer s.install.mu.Unlock()
	key := syncedStreamKey(row, resource)
	state := s.install.streams[key]
	if newest.After(state.updated) {
		state.updated = newest
		s.install.streams[key] = state
	}
	if (resource != GitHubRepoMetadataIssues && resource != gitHubConversationComments) || state.updated.IsZero() {
		return
	}
	since := githubUpdatedBoundary(state.updated).Format(time.RFC3339)
	for page := range s.install.etags {
		if page.gitHubStreamKey != key {
			continue
		}
		query, err := url.ParseQuery(page.query)
		if err != nil || query.Get("since") != since {
			delete(s.install.etags, page)
		}
	}
}
