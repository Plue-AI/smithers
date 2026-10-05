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
	// DailyTokens bounds the tokens the factory's lanes spend per UTC day.
	// A repository that declares none gets defaultDailyTokens; a declared 0
	// launches nothing: the factory never spends unbounded.
	// Each run in flight holds mythicalRunTokenReserve of it until it
	// settles (launchable): a day ends over only by the last admitted run's
	// spend plus what runs spend past their reserves.
	DailyTokens int64 `json:"dailyTokens"`
}

// defaultDailyTokens is the daily budget of a repository whose committed
// policy declares none, so a repository with no Smithers declarations still
// runs TODOs (mvp.md J1.4, M-11). It is ten runs at mythicalRunTokenReserve,
// the TUI's default rule of ten runs at the per-run cap (apps/tui/src/budget.ts)
// applied to the factory's per-run reserve: a tripwire for runaway loops, not
// cost control. A declared value, 0 included, always wins.
const defaultDailyTokens = 10 * mythicalRunTokenReserve

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
// missing projection is the default policy; an unreadable one is an error,
// never a default. Each field the block omits keeps its default.
func parseFactoryGitHubPolicy(projection []byte) (factoryGitHubPolicy, error) {
	policy := factoryGitHubPolicy{DailyTokens: defaultDailyTokens}
	if len(projection) == 0 {
		return policy, nil
	}
	var factory struct {
		Github *struct {
			factoryGitHubPolicy
			// Shadows the embedded field, so an omitted budget is told
			// apart from a declared 0.
			DailyTokens *int64 `json:"dailyTokens"`
		} `json:"github"`
	}
	if err := json.Unmarshal(projection, &factory); err != nil {
		return factoryGitHubPolicy{}, errors.New(factoryProjectionPath + " is not valid JSON")
	}
	if factory.Github != nil {
		policy = factory.Github.factoryGitHubPolicy
		policy.DailyTokens = defaultDailyTokens
		if factory.Github.DailyTokens != nil {
			policy.DailyTokens = *factory.Github.DailyTokens
		}
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

// repositorySourceHost reads committed repository source files.
type repositorySourceHost interface {
	repohost.BookmarkReader
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

// repositoryPolicyHost shares immutable default-bookmark policy projections.
type repositoryPolicyHost interface {
	repositorySourceHost
	GetFileAtCommit(ctx context.Context, owner, repo, commit, path string) (repohost.FileContent, error)
}

// readRepositoryPolicy is the policy the owner committed to the repository's
// default bookmark. No bookmark or no projection is the default policy; a
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
		return parseFactoryGitHubPolicy(nil)
	}
	file, err := host.GetFileAtCommit(ctx, owner, repo, commit, factoryProjectionPath)
	if repohost.IsFileNotFound(err) {
		return parseFactoryGitHubPolicy(nil)
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
func bookmarkCommit(ctx context.Context, host repohost.BookmarkReader, owner, repo, bookmark string) (string, bool, error) {
	entry, found, err := repohost.LookupBookmark(ctx, host, owner, repo, bookmark)
	if err != nil {
		return "", false, fmt.Errorf("resolve %s: %w", bookmark, err)
	}
	if !found {
		return "", false, nil
	}
	commit := strings.TrimSpace(entry.TargetCommitID)
	if commit == "" {
		return "", false, errors.New(bookmark + " names no commit")
	}
	return commit, true, nil
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
