package services

import (
	"context"
	"log/slog"
)

var _ RepositoryJobGitHubReadAccess = (*GitHubUserReposService)(nil)

// GitHubRepoReadAuthorized reports whether userID's own GitHub credential can
// read owner/repo, for store readers other than the metadata proxy (repository
// job GitHub subjects). A fresh read grant answers without a GitHub call;
// otherwise a live GET /repos/{owner}/{repo} with the user's credential decides
// and, on success, stamps a new grant. Every failure is "not authorized".
func (s *GitHubUserReposService) GitHubRepoReadAuthorized(ctx context.Context, userID int64, owner, repo string) bool {
	if s == nil || userID <= 0 {
		return false
	}
	if s.syncedRepos != nil && s.syncedRepos.ReadGrant(ctx, userID, owner, repo).ok {
		return true
	}
	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return false
	}
	_, err = s.requestGitHubRepoObject(ctx, accessToken, owner, repo)
	if err != nil && isGitHubTokenExpired(err) {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			_, err = s.requestGitHubRepoObject(ctx, newToken, owner, repo)
		} else {
			err = refreshErr
		}
	}
	if err != nil {
		return false
	}
	if s.syncedRepos != nil {
		if err := s.syncedRepos.RecordReadGrant(ctx, userID, owner, repo); err != nil {
			slog.Warn("github synced repo read grant not recorded", "user_id", userID, "owner", owner, "repo", repo, "error", err)
		}
	}
	return true
}
