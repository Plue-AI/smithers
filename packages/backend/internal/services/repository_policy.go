package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// factoryGitHubPolicy is the `github` block of the committed factory
// projection (.smithers/factory.json, S.Github.Policy): the owner's
// committed decisions about which paths, agents and agent issue sources the
// repository trusts.
type factoryGitHubPolicy struct {
	// ProtectedPaths extends the built-in trust roots (protectedPaths).
	ProtectedPaths []string `json:"protectedPaths"`
	// ReviewerAgents are the logins whose agent LGTM counts toward
	// require_agent_lgtm and an ownership auto_land policy.
	ReviewerAgents []string `json:"reviewerAgents"`
	// AgentIssueSources are the agent sources ("run", "linear", "trial")
	// whose filed issues start credentialed work without a label.
	AgentIssueSources []string `json:"agentIssueSources"`
	// Maintainers are the GitHub logins the factory takes todo and
	// automerge labels from, and whose own issues created since TodoSince
	// become TODOs without the label (the stack applies it).
	Maintainers []string `json:"maintainers"`
	// TodoSince is when that rule took effect (RFC 3339); an issue created
	// before it never becomes a TODO on its own.
	TodoSince string `json:"todoSince"`
	// DailyTokens bounds the tokens the factory's lanes spend per UTC day;
	// 0 (none declared) launches nothing: the factory never spends unbounded.
	// Each run in flight holds mythicalRunTokenReserve of it until it
	// settles (launchable): a day ends over only by the last admitted run's
	// spend plus what runs spend past their reserves.
	DailyTokens int64 `json:"dailyTokens"`
}

// namesMaintainers reports whether the owner committed a maintainers list.
// Without one, every person with write access keeps counting (the ingress
// stamp's rule), and no issue becomes a TODO on its own.
func (p factoryGitHubPolicy) namesMaintainers() bool { return p.Maintainers != nil }

// maintains reports whether login may apply todo and automerge: one of the
// named maintainers, or, with no list committed, anyone (the caller has
// already required a person with write access).
func (p factoryGitHubPolicy) maintains(login string) bool {
	if !p.namesMaintainers() {
		return strings.TrimSpace(login) != ""
	}
	for _, maintainer := range p.Maintainers {
		if login != "" && strings.EqualFold(strings.TrimSpace(maintainer), strings.TrimSpace(login)) {
			return true
		}
	}
	return false
}

// agentIssueSources are the native sources that file issues under a person's
// account without that person writing them (issues.filed_by, 0060).
var agentIssueSources = []string{"run", "linear", "trial"}

// parseFactoryGitHubPolicy reads a factory projection's github block. A
// missing projection is the empty policy; an unreadable one is an error,
// never an empty policy.
func parseFactoryGitHubPolicy(projection []byte) (factoryGitHubPolicy, error) {
	var policy factoryGitHubPolicy
	if len(projection) == 0 {
		return policy, nil
	}
	var factory struct {
		Github *factoryGitHubPolicy `json:"github"`
	}
	if err := json.Unmarshal(projection, &factory); err != nil {
		return policy, errors.New(factoryProjectionPath + " is not valid JSON")
	}
	if factory.Github != nil {
		policy = *factory.Github
	}
	for _, source := range policy.AgentIssueSources {
		if !slices.Contains(agentIssueSources, source) {
			return factoryGitHubPolicy{}, fmt.Errorf("%s names an unknown agent issue source %q", factoryProjectionPath, source)
		}
	}
	for _, login := range append(append([]string{}, policy.ReviewerAgents...), policy.Maintainers...) {
		if strings.TrimSpace(login) == "" {
			return factoryGitHubPolicy{}, errors.New(factoryProjectionPath + " names an empty login")
		}
	}
	if policy.TodoSince != "" {
		if _, err := time.Parse(time.RFC3339, policy.TodoSince); err != nil {
			return factoryGitHubPolicy{}, errors.New(factoryProjectionPath + " todoSince is not an RFC 3339 time")
		}
	}
	if policy.DailyTokens < 0 {
		return factoryGitHubPolicy{}, errors.New(factoryProjectionPath + " dailyTokens is negative")
	}
	return policy, nil
}

// repositoryPolicyHost reads the default bookmark's factory projection.
type repositoryPolicyHost interface {
	ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

// readRepositoryPolicy is the policy the owner committed to the repository's
// default bookmark. No bookmark or no projection is the empty policy; a
// failed or unreadable read is an error, so callers fail closed.
func readRepositoryPolicy(ctx context.Context, host repositoryPolicyHost, owner, repo, bookmark string) (factoryGitHubPolicy, error) {
	if host == nil {
		return factoryGitHubPolicy{}, errors.New("repository policy reader unavailable")
	}
	// The bookmark's commit is the immutable snapshot the owner committed;
	// its change id could move to a later revision while it is read.
	commit, found, err := bookmarkCommit(ctx, host, owner, repo, bookmark)
	if err != nil {
		return factoryGitHubPolicy{}, err
	}
	if !found {
		return factoryGitHubPolicy{}, nil
	}
	file, err := host.GetFileAtChange(ctx, owner, repo, commit, factoryProjectionPath)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return factoryGitHubPolicy{}, nil
	}
	if err != nil {
		return factoryGitHubPolicy{}, fmt.Errorf("read %s: %w", factoryProjectionPath, err)
	}
	if file.TooLarge || file.Encoding == "base64" {
		return factoryGitHubPolicy{}, errors.New(factoryProjectionPath + " is not readable text")
	}
	return parseFactoryGitHubPolicy([]byte(file.Content))
}

// bookmarkCommit is the commit a bookmark names on the repo host. A missing
// bookmark is not found; a bookmark naming no commit is an error.
func bookmarkCommit(ctx context.Context, host repositoryPolicyHost, owner, repo, bookmark string) (string, bool, error) {
	for cursor := ""; ; {
		page, next, err := host.ListBookmarks(ctx, owner, repo, cursor, 100)
		if err != nil {
			return "", false, fmt.Errorf("resolve %s: %w", bookmark, err)
		}
		for _, entry := range page {
			if entry.Name == bookmark {
				commit := strings.TrimSpace(entry.TargetCommitID)
				if commit == "" {
					return "", false, errors.New(bookmark + " names no commit")
				}
				return commit, true, nil
			}
		}
		if next == "" {
			return "", false, nil
		}
		cursor = next
	}
}

// repositoryReviewerAgents are the reviewer agent logins the repository's
// default bookmark names, lowercased for users.lower_username.
func repositoryReviewerAgents(ctx context.Context, host repositoryPolicyHost, owner string, repository db.Repository) ([]string, error) {
	policy, err := readRepositoryPolicy(ctx, host, owner, repository.Name, repository.DefaultBookmark)
	if err != nil {
		return nil, err
	}
	logins := make([]string, 0, len(policy.ReviewerAgents))
	for _, login := range policy.ReviewerAgents {
		logins = append(logins, strings.ToLower(strings.TrimSpace(login)))
	}
	return logins, nil
}
