package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// The install's GitHub issues (J2 steps 1 and 2, mvp.md §6.3): the issue
// list card and the issue card read the repository's issues, and one issue
// with its comments, as GitHub holds them now. Every read goes through the
// install's GitHub App as the stack's actor (stackGitHub), so a member reads
// issues by their role (issue.read) and never needs a GitHub credential of
// their own that can read them.

const (
	// installIssuesPerPage keeps one page of issue bodies (at most 64 KiB
	// each) under the 4 MiB GitHub response bound.
	installIssuesPerPage = 50
	// installIssueCommentPages bounds one issue card to 1,000 comments.
	installIssueCommentPages = 10
)

// InstallIssuePerson is a GitHub account as the issue cards show it.
type InstallIssuePerson struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url,omitempty"`
}

// InstallIssueLabel is one label on an issue.
type InstallIssueLabel struct {
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

// InstallIssue is one GitHub issue as the issue cards read it, in GitHub's
// own field names.
type InstallIssue struct {
	Number    int64                `json:"number"`
	Title     string               `json:"title"`
	Body      string               `json:"body"`
	State     string               `json:"state"`
	HTMLURL   string               `json:"html_url"`
	User      *InstallIssuePerson  `json:"user"`
	Labels    []InstallIssueLabel  `json:"labels"`
	Assignees []InstallIssuePerson `json:"assignees"`
	// Comments is how many comments the issue has.
	Comments  int64      `json:"comments"`
	CreatedAt *time.Time `json:"created_at,omitempty"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
}

// InstallIssueComment is one comment on an issue.
type InstallIssueComment struct {
	ID        int64               `json:"id"`
	Body      string              `json:"body"`
	User      *InstallIssuePerson `json:"user"`
	CreatedAt *time.Time          `json:"created_at,omitempty"`
}

// InstallIssueThread is one issue and its comments, oldest first.
type InstallIssueThread struct {
	Issue    InstallIssue          `json:"issue"`
	Comments []InstallIssueComment `json:"comments"`
}

// gitHubListedIssue is an entry of GitHub's issues API, which lists pull
// requests too; pull_request marks them.
type gitHubListedIssue struct {
	InstallIssue
	PullRequest *json.RawMessage `json:"pull_request"`
}

func (i gitHubListedIssue) pull() bool {
	return i.PullRequest != nil && string(*i.PullRequest) != "null"
}

// normalized gives absent lists their empty value, so the cards read [].
func (i InstallIssue) normalized() InstallIssue {
	if i.Labels == nil {
		i.Labels = []InstallIssueLabel{}
	}
	if i.Assignees == nil {
		i.Assignees = []InstallIssuePerson{}
	}
	return i
}

// mythicalIssueReader reads the repository's issues as the issue cards show
// them; mythicalGitHubAPI implements it.
type mythicalIssueReader interface {
	IssuePage(ctx context.Context, gh mythicalGitHubRepo, state string, page int) ([]InstallIssue, error)
	IssueThread(ctx context.Context, gh mythicalGitHubRepo, number int64) (InstallIssueThread, bool, error)
}

// IssuePage reads one page of the repository's issues in state, newest
// first, without its pull requests.
func (g *mythicalGitHubAPI) IssuePage(ctx context.Context, gh mythicalGitHubRepo, state string, page int) ([]InstallIssue, error) {
	query := url.Values{"state": {state}, "per_page": {strconv.Itoa(installIssuesPerPage)}, "page": {strconv.Itoa(page)}}
	var listed []gitHubListedIssue
	status, err := g.api.request(ctx, gh.Token, http.MethodGet, landingGitHubRepoPath(gh.Owner, gh.Name)+"/issues?"+query.Encode(), nil, &listed)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read issues")
	}
	out := []InstallIssue{}
	for _, issue := range listed {
		if !issue.pull() {
			out = append(out, issue.normalized())
		}
	}
	return out, nil
}

// IssueThread reads one issue and its comments; found is false for a
// number that is no issue (absent, or a pull request).
func (g *mythicalGitHubAPI) IssueThread(ctx context.Context, gh mythicalGitHubRepo, number int64) (InstallIssueThread, bool, error) {
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10)
	var issue gitHubListedIssue
	status, err := g.api.request(ctx, gh.Token, http.MethodGet, path, nil, &issue)
	switch {
	case err != nil:
		return InstallIssueThread{}, false, err
	case status == http.StatusNotFound || status == http.StatusGone || status == http.StatusOK && issue.pull():
		return InstallIssueThread{}, false, nil
	case status != http.StatusOK:
		return InstallIssueThread{}, false, landingGitHubStatusError(status, gh.Owner, gh.Name, "read issues")
	}
	comments := []InstallIssueComment{}
	for page := 1; page <= installIssueCommentPages; page++ {
		var rows []InstallIssueComment
		status, err := g.api.request(ctx, gh.Token, http.MethodGet, path+"/comments?per_page=100&page="+strconv.Itoa(page), nil, &rows)
		if err != nil {
			return InstallIssueThread{}, false, err
		}
		if status != http.StatusOK {
			return InstallIssueThread{}, false, landingGitHubStatusError(status, gh.Owner, gh.Name, "read issue comments")
		}
		comments = append(comments, rows...)
		if len(rows) < 100 {
			break
		}
	}
	return InstallIssueThread{Issue: issue.normalized(), Comments: comments}, true, nil
}

// issuesUnavailable is the refusal of a read GitHub did not answer.
func issuesUnavailable() error {
	return &TodoControlError{http.StatusServiceUnavailable, "github_unavailable", "infra", "Could not read issues from GitHub"}
}

// installIssueReader resolves the repository's GitHub destination as the
// stack's actor and the reader that reads it.
func (s *MythicalService) installIssueReader(ctx context.Context, repositoryID int64) (mythicalIssueReader, mythicalGitHubRepo, error) {
	if s == nil || s.store == nil || s.github == nil {
		return nil, mythicalGitHubRepo{}, issuesUnavailable()
	}
	reader, ok := s.github.(mythicalIssueReader)
	if !ok {
		return nil, mythicalGitHubRepo{}, issuesUnavailable()
	}
	gh, err := s.stackGitHub(ctx, repositoryID)
	if err != nil {
		s.logger.Warn("install.issues_unavailable", "repository_id", repositoryID, "error", err)
		return nil, mythicalGitHubRepo{}, issuesUnavailable()
	}
	return reader, gh, nil
}

// InstallIssues answers one page of the repository's issues in state (open,
// closed or all), newest first, without pull requests.
func (s *MythicalService) InstallIssues(ctx context.Context, repositoryID int64, state string, page int) ([]InstallIssue, error) {
	if state != "open" && state != "closed" && state != "all" || page < 1 || page > 1000 {
		return nil, &TodoControlError{http.StatusBadRequest, "invalid_issue_query", "user", "state is open, closed or all, and page 1 to 1000"}
	}
	reader, gh, err := s.installIssueReader(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	issues, err := reader.IssuePage(ctx, gh, state, page)
	if err != nil {
		s.logger.Warn("install.issues_unavailable", "repository_id", repositoryID, "error", err)
		return nil, issuesUnavailable()
	}
	return issues, nil
}

// InstallIssue answers issue number with its comments.
func (s *MythicalService) InstallIssue(ctx context.Context, repositoryID, number int64) (InstallIssueThread, error) {
	if number <= 0 {
		return InstallIssueThread{}, &TodoControlError{http.StatusBadRequest, "invalid_issue_query", "user", "Invalid issue number"}
	}
	reader, gh, err := s.installIssueReader(ctx, repositoryID)
	if err != nil {
		return InstallIssueThread{}, err
	}
	thread, found, err := reader.IssueThread(ctx, gh, number)
	if err != nil {
		s.logger.Warn("install.issues_unavailable", "repository_id", repositoryID, "issue", number, "error", err)
		return InstallIssueThread{}, issuesUnavailable()
	}
	if !found {
		return InstallIssueThread{}, &TodoControlError{http.StatusNotFound, "not_found", "user", fmt.Sprintf("Issue #%d was not found", number)}
	}
	return thread, nil
}
