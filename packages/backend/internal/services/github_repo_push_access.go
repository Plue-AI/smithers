package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// githubPushProofTTL bounds how long one user's proven GitHub push access lets
// platform writes on their behalf skip the live check. A collaborator whose
// push access is revoked stops driving platform writes within this window.
const githubPushProofTTL = 5 * time.Minute

// GitHubPushProofReason names why a user's GitHub push access could not be
// proven. Each value is a stable log and metric label.
type GitHubPushProofReason string

const (
	// GitHubPushProofNoCredential: the user has no linked GitHub credential.
	GitHubPushProofNoCredential GitHubPushProofReason = "no_github_credential"
	// GitHubPushProofDenied: GitHub answered, and the user cannot push (or
	// cannot see the repository at all).
	GitHubPushProofDenied GitHubPushProofReason = "push_required"
	// GitHubPushProofUnavailable: GitHub could not be asked. Treated as "no
	// proof": a write is never made on an unanswered question.
	GitHubPushProofUnavailable GitHubPushProofReason = "github_unavailable"
	// GitHubPushProofUnwired: no push checker is configured (fail closed).
	GitHubPushProofUnwired GitHubPushProofReason = "push_check_unwired"
	// GitHubPushProofNoBinder: the mirror has no recorded binding user.
	GitHubPushProofNoBinder GitHubPushProofReason = "no_binder"
)

// GitHubPushProofError is the typed failure of GitHubRepoPushAuthorized.
type GitHubPushProofError struct {
	UserID int64
	Owner  string
	Repo   string
	Reason GitHubPushProofReason
}

func (e *GitHubPushProofError) Error() string {
	return fmt.Sprintf("user %d has no proven push access to github %s/%s: %s", e.UserID, e.Owner, e.Repo, e.Reason)
}

// GitHubRepoPushProver proves, with the user's own GitHub credential, that the
// user can push to a GitHub repository right now. A nil error is a proof.
type GitHubRepoPushProver interface {
	GitHubRepoPushAuthorized(ctx context.Context, userID int64, owner, repo string) error
}

var _ GitHubRepoPushProver = (*GitHubUserReposService)(nil)

// githubPushProofs remembers (user, repo) pairs that proved push access.
type githubPushProofs struct {
	mu    sync.Mutex
	until map[string]time.Time
}

// GitHubRepoPushAuthorized asks GitHub, with userID's own credential, whether
// userID can push to owner/repo. The platform writes to GitHub with its own
// token, which can push to far more repositories than any one user, so every
// platform write on a user's behalf must first pass this check. Proofs are
// remembered for githubPushProofTTL; failures are never remembered.
func (s *GitHubUserReposService) GitHubRepoPushAuthorized(ctx context.Context, userID int64, owner, repo string) error {
	fail := func(reason GitHubPushProofReason) error {
		return &GitHubPushProofError{UserID: userID, Owner: owner, Repo: repo, Reason: reason}
	}
	if s == nil || userID <= 0 {
		return fail(GitHubPushProofNoCredential)
	}
	key := fmt.Sprintf("%d/%s/%s", userID, strings.ToLower(owner), strings.ToLower(repo))
	now := time.Now()
	if s.now != nil {
		now = s.now()
	}
	s.pushProofs.mu.Lock()
	exp, ok := s.pushProofs.until[key]
	s.pushProofs.mu.Unlock()
	if ok && now.Before(exp) {
		return nil
	}

	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		return fail(GitHubPushProofNoCredential)
	}
	canPush, _, err := s.requestGitHubRepoPushPermission(ctx, accessToken, owner, repo)
	if err != nil && isGitHubTokenExpired(err) {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			canPush, _, err = s.requestGitHubRepoPushPermission(ctx, newToken, owner, repo)
		} else {
			err = refreshErr
		}
	}
	if err != nil {
		var apiErr *pkgerrors.APIError
		if stdErrors.As(err, &apiErr) && (apiErr.Code == pkgerrors.CodeGitHubPermission || apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusUnauthorized) {
			return fail(GitHubPushProofDenied)
		}
		return fail(GitHubPushProofUnavailable)
	}
	if !canPush {
		return fail(GitHubPushProofDenied)
	}
	s.pushProofs.mu.Lock()
	if s.pushProofs.until == nil {
		s.pushProofs.until = map[string]time.Time{}
	}
	s.pushProofs.until[key] = now.Add(githubPushProofTTL)
	s.pushProofs.mu.Unlock()
	return nil
}
