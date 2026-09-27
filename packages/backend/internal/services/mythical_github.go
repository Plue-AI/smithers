package services

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// mythicalGitHubRepo is a repository's GitHub destination with credentials
// resolved for one run and never stored.
type mythicalGitHubRepo struct {
	Owner, Name string
	Token       string
	GitURL      string
}

// mythicalIssue is what admission reads of one GitHub issue.
type mythicalIssue struct {
	Number           int64
	Title, Body, URL string
	State            string // open | closed
	Author           gitHubActor
	// TextByMaintainer: the author and the last writers of the title and
	// body are maintainer persons (issueTextByMaintainerField).
	TextByMaintainer bool
	Labels           []string
	PullRequest      bool
}

// mythicalPull is one GitHub pull request as the stack follows it.
type mythicalPull struct {
	Number      int64
	URL         string
	State       string // open | closed
	Merged      bool
	MergeCommit string
	HeadRef     string
	HeadSHA     string
	// MergeableState is GitHub's word: clean, dirty (conflicts), behind
	// (the base moved and the branch must be updated), blocked, unknown.
	MergeableState string
}

// mythicalGitHub is the stack's GitHub surface: the destination and a token
// (resolved as landing pull requests resolve them), the open issues, and the
// item pull requests.
type mythicalGitHub interface {
	Resolve(ctx context.Context, repository db.Repository, owner string, actorUserID int64) (mythicalGitHubRepo, error)
	OpenIssues(ctx context.Context, gh mythicalGitHubRepo) ([]mythicalIssue, error)
	// IssueTextByMaintainer reads whether an open issue's author and the
	// last writers of its title and body, still as listed, are maintainers.
	IssueTextByMaintainer(ctx context.Context, gh mythicalGitHubRepo, issue mythicalIssue) (bool, error)
	// Maintainer reads whether an account is a maintainer person.
	Maintainer(ctx context.Context, gh mythicalGitHubRepo, account gitHubActor) (bool, error)
	Pull(ctx context.Context, gh mythicalGitHubRepo, number int64) (mythicalPull, error)
	FindPull(ctx context.Context, gh mythicalGitHubRepo, branch string) (*mythicalPull, error)
	CreatePull(ctx context.Context, gh mythicalGitHubRepo, title, head, base, body string) (mythicalPull, error)
}

// MythicalGitHubStore is what resolving a destination reads.
type MythicalGitHubStore interface {
	gitHubDestinationStore
}

// mythicalGitHubAPIPermissions covers the stack's API calls: reading issues
// and opening or reading its pull requests.
var mythicalGitHubAPIPermissions = map[string]string{"contents": "read", "issues": "read", "pull_requests": "write"}

type mythicalGitHubAPI struct {
	api         *landingGitHubAPI
	text        *gitHubIssueTextAPI
	store       MythicalGitHubStore
	tokens      LandingGitHubPullTokens
	prover      GitHubRepoPushProver
	connections RepoSyncConnectionChecker
	gitBase     func() string
}

// NewMythicalGitHub resolves the repository owner's App installation token at
// dispatch and proves the stack actor's own push access before any write, the
// credential policy of landing pull requests.
func NewMythicalGitHub(store MythicalGitHubStore, tokens LandingGitHubPullTokens, prover GitHubRepoPushProver, connections RepoSyncConnectionChecker) *mythicalGitHubAPI {
	api := &landingGitHubAPI{client: observability.NewHTTPClient(30 * time.Second), baseURL: githubAPIBaseURL}
	return &mythicalGitHubAPI{
		api: api, text: &gitHubIssueTextAPI{api: api},
		store: store, tokens: tokens, prover: prover, connections: connections,
		gitBase: func() string {
			if base := strings.TrimSpace(os.Getenv("SMITHERS_GITHUB_GIT_BASE_URL")); base != "" {
				return base
			}
			return defaultGitHubGitBaseURL
		},
	}
}

func (g *mythicalGitHubAPI) Resolve(ctx context.Context, repository db.Repository, owner string, actorUserID int64) (mythicalGitHubRepo, error) {
	if g == nil || g.store == nil || g.tokens == nil {
		return mythicalGitHubRepo{}, pkgerrors.Internal("GitHub is not configured for the mythical stack")
	}
	ghOwner, ghRepo, err := resolveGitHubDestination(ctx, g.store, g.connections, actorUserID, repository.ID, owner, repository.Name)
	if err != nil {
		return mythicalGitHubRepo{}, err
	}
	if g.prover == nil {
		return mythicalGitHubRepo{}, pkgerrors.Forbidden("GitHub push access cannot be proven")
	}
	if err := g.prover.GitHubRepoPushAuthorized(ctx, actorUserID, ghOwner, ghRepo); err != nil {
		return mythicalGitHubRepo{}, pkgerrors.Forbidden("The stack's GitHub account must have push access to " + ghOwner + "/" + ghRepo).WithCause(err)
	}
	// Like landings, neither token carries workflows: the git push holds
	// contents:write only and the API token cannot push.
	installation, err := g.tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, ghOwner, ghRepo, landingGitHubPushPermissions)
	if err != nil {
		return mythicalGitHubRepo{}, err
	}
	push := strings.TrimSpace(installation.Token)
	if push == "" {
		return mythicalGitHubRepo{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}
	api, err := g.tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, repository.UserID.Int64, repository.OrgID.Int64, ghOwner, ghRepo, mythicalGitHubAPIPermissions)
	if err != nil {
		return mythicalGitHubRepo{}, err
	}
	token := strings.TrimSpace(api.Token)
	if token == "" {
		return mythicalGitHubRepo{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}
	gitURL, err := gitMirrorURL(g.gitBase(), push, ghOwner, ghRepo)
	if err != nil {
		return mythicalGitHubRepo{}, pkgerrors.Internal("build GitHub destination URL").WithCause(err)
	}
	return mythicalGitHubRepo{Owner: ghOwner, Name: ghRepo, Token: token, GitURL: gitURL}, nil
}

type mythicalGitHubIssue struct {
	Number           int64       `json:"number"`
	Title            string      `json:"title"`
	Body             *string     `json:"body"`
	HTMLURL          string      `json:"html_url"`
	State            string      `json:"state"`
	User             gitHubActor `json:"user"`
	TextByMaintainer bool        `json:"smithers_text_by_maintainer"`
	Labels           []struct {
		Name string `json:"name"`
	} `json:"labels"`
	PullRequest *struct{} `json:"pull_request"`
}

func (i mythicalGitHubIssue) issue() mythicalIssue {
	out := mythicalIssue{Number: i.Number, Title: i.Title, URL: i.HTMLURL, State: i.State,
		Author: i.User, TextByMaintainer: i.TextByMaintainer, PullRequest: i.PullRequest != nil}
	if i.Body != nil {
		out.Body = *i.Body
	}
	for _, label := range i.Labels {
		out.Labels = append(out.Labels, label.Name)
	}
	return out
}

func (g *mythicalGitHubAPI) IssueTextByMaintainer(ctx context.Context, gh mythicalGitHubRepo, issue mythicalIssue) (bool, error) {
	return g.text.TextByMaintainer(ctx, gh.Token, gh.Owner, gh.Name,
		gitHubIssueTextWrite{Number: issue.Number, Title: issue.Title, Body: issue.Body, Author: issue.Author})
}

func (g *mythicalGitHubAPI) Maintainer(ctx context.Context, gh mythicalGitHubRepo, account gitHubActor) (bool, error) {
	return g.text.personIsMaintainer(ctx, gh.Token, gh.Owner, gh.Name, &account)
}

// OpenIssues lists every open issue, bounded to 20 pages of 100.
func (g *mythicalGitHubAPI) OpenIssues(ctx context.Context, gh mythicalGitHubRepo) ([]mythicalIssue, error) {
	var out []mythicalIssue
	for page := 1; page <= 20; page++ {
		query := url.Values{"state": {"open"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}, "sort": {"created"}, "direction": {"asc"}}
		var issues []mythicalGitHubIssue
		status, err := g.api.request(ctx, gh.Token, http.MethodGet, landingGitHubRepoPath(gh.Owner, gh.Name)+"/issues?"+query.Encode(), nil, &issues)
		if err != nil {
			return nil, err
		}
		if status != http.StatusOK {
			return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read issues")
		}
		for _, issue := range issues {
			out = append(out, issue.issue())
		}
		if len(issues) < 100 {
			return out, nil
		}
	}
	return out, nil
}

type mythicalGitHubPull struct {
	landingGitHubPullRequest
	MergeableState string `json:"mergeable_state"`
}

func (p mythicalGitHubPull) pull() mythicalPull {
	out := mythicalPull{Number: p.Number, URL: p.HTMLURL, State: p.State, Merged: p.MergedAt != nil,
		HeadRef: p.Head.Ref, HeadSHA: p.Head.SHA, MergeableState: p.MergeableState}
	if out.Merged && p.MergeCommitSHA != nil {
		out.MergeCommit = *p.MergeCommitSHA
	}
	return out
}

func (g *mythicalGitHubAPI) Pull(ctx context.Context, gh mythicalGitHubRepo, number int64) (mythicalPull, error) {
	var pull mythicalGitHubPull
	status, err := g.api.request(ctx, gh.Token, http.MethodGet, landingGitHubRepoPath(gh.Owner, gh.Name)+"/pulls/"+strconv.FormatInt(number, 10), nil, &pull)
	if err != nil {
		return mythicalPull{}, err
	}
	if status != http.StatusOK {
		return mythicalPull{}, landingGitHubStatusError(status, gh.Owner, gh.Name, "read pull requests")
	}
	return pull.pull(), nil
}

func (g *mythicalGitHubAPI) FindPull(ctx context.Context, gh mythicalGitHubRepo, branch string) (*mythicalPull, error) {
	found, err := g.api.Find(ctx, gh.Token, gh.Owner, gh.Name, branch)
	if err != nil || found == nil {
		return nil, err
	}
	pull, err := g.Pull(ctx, gh, found.Number)
	if err != nil {
		return nil, err
	}
	return &pull, nil
}

func (g *mythicalGitHubAPI) CreatePull(ctx context.Context, gh mythicalGitHubRepo, title, head, base, body string) (mythicalPull, error) {
	created, err := g.api.Create(ctx, gh.Token, gh.Owner, gh.Name, landingGitHubPullCreate{Title: title, Head: head, Base: base, Body: body,
		MaintainerCanModify: true})
	if err != nil {
		if err == errLandingGitHubPullExists {
			found, findErr := g.FindPull(ctx, gh, head)
			if findErr != nil {
				return mythicalPull{}, findErr
			}
			if found != nil {
				return *found, nil
			}
		}
		return mythicalPull{}, err
	}
	return mythicalGitHubPull{landingGitHubPullRequest: *created}.pull(), nil
}
