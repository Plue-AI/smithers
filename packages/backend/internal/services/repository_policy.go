package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// factoryGitHubPolicy is the `github` block of the committed factory
// projection (.smithers/factory.json, S.Github.Policy): the owner's
// committed decisions about which paths and agents the repository trusts.
type factoryGitHubPolicy struct {
	// ProtectedPaths extends the built-in trust roots (protectedPaths).
	ProtectedPaths []string `json:"protectedPaths"`
	// ReviewerAgents are the logins whose agent LGTM counts toward
	// require_agent_lgtm and an ownership auto_land policy.
	ReviewerAgents []string `json:"reviewerAgents"`
}

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
	for _, login := range policy.ReviewerAgents {
		if strings.TrimSpace(login) == "" {
			return factoryGitHubPolicy{}, errors.New(factoryProjectionPath + " names an empty reviewer agent")
		}
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
	commit, found := "", false
	for cursor := ""; !found; {
		page, next, err := host.ListBookmarks(ctx, owner, repo, cursor, 100)
		if err != nil {
			return factoryGitHubPolicy{}, fmt.Errorf("resolve %s: %w", bookmark, err)
		}
		for _, entry := range page {
			if entry.Name == bookmark {
				commit, found = strings.TrimSpace(entry.TargetCommitID), true
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if !found {
		return factoryGitHubPolicy{}, nil
	}
	if commit == "" {
		return factoryGitHubPolicy{}, errors.New(bookmark + " names no commit")
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
