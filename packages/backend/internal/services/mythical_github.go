package services

import (
	"context"
	"encoding/json"
	"errors"
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
	// userID and orgID own the repository; the stack's two API writes mint
	// their own narrow installation tokens for it (Merge, RemoveLabel).
	userID, orgID int64
}

// mythicalIssue is what admission reads of one GitHub issue.
type mythicalIssue struct {
	Number           int64
	Title, Body, URL string
	State            string // open | closed
	Author           gitHubActor
	// ViaApp: a GitHub App created the issue for its author.
	ViaApp bool
	// TextByMaintainer: the author and the last writers of the title and
	// body are maintainer persons (issueTextByMaintainerField).
	TextByMaintainer bool
	Labels           []string
	PullRequest      bool
	CreatedAt        time.Time
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
	// HeadChecks answers GitHub CI's verdict on one commit (mythicalCIGreen,
	// mythicalCIPending or mythicalCIRed).
	HeadChecks(ctx context.Context, gh mythicalGitHubRepo, sha string) (string, error)
	// Merge squash-merges a pull request only while its head is head, and
	// answers the merge commit.
	Merge(ctx context.Context, gh mythicalGitHubRepo, number int64, head string) (string, error)
	// LabelApplier answers who last applied label to an issue, or removed
	// it (Removed), as the issue's labels stand now: nil when none ever
	// applied it. It errs while GitHub's history trails the labels.
	LabelApplier(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) (*mythicalLabelApplier, error)
	// Comment posts one comment on an issue.
	Comment(ctx context.Context, gh mythicalGitHubRepo, number int64, body string) error
	// AddLabel puts label on an issue.
	AddLabel(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) error
	// RemoveLabel takes label off an issue; an absent label is removed.
	RemoveLabel(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) error
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
	return mythicalGitHubRepo{Owner: ghOwner, Name: ghRepo, Token: token, GitURL: gitURL,
		userID: repository.UserID.Int64, orgID: repository.OrgID.Int64}, nil
}

type mythicalGitHubIssue struct {
	Number           int64            `json:"number"`
	Title            string           `json:"title"`
	Body             *string          `json:"body"`
	HTMLURL          string           `json:"html_url"`
	State            string           `json:"state"`
	User             gitHubActor      `json:"user"`
	ViaApp           *json.RawMessage `json:"performed_via_github_app"`
	TextByMaintainer bool             `json:"smithers_text_by_maintainer"`
	Labels           []struct {
		Name string `json:"name"`
	} `json:"labels"`
	PullRequest *struct{} `json:"pull_request"`
	CreatedAt   time.Time `json:"created_at"`
}

func (i mythicalGitHubIssue) issue() mythicalIssue {
	out := mythicalIssue{Number: i.Number, Title: i.Title, URL: i.HTMLURL, State: i.State,
		Author: i.User, ViaApp: i.ViaApp != nil && string(*i.ViaApp) != "null",
		TextByMaintainer: i.TextByMaintainer, PullRequest: i.PullRequest != nil, CreatedAt: i.CreatedAt}
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
		gitHubIssueTextWrite{Number: issue.Number, Title: issue.Title, Body: issue.Body, Author: issue.Author, ViaApp: issue.ViaApp})
}

func (g *mythicalGitHubAPI) Maintainer(ctx context.Context, gh mythicalGitHubRepo, account gitHubActor) (bool, error) {
	return g.text.personIsMaintainer(ctx, gh.Token, gh.Owner, gh.Name, &account)
}

// OpenIssues lists open issues only when the bounded listing is complete.
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
	// A full last page does not establish that there are no more issues.
	// Never let backfill reconcile absent items against this partial list.
	return nil, pkgerrors.New(pkgerrors.CodeBadGateway, "GitHub open issue listing exceeds 20 pages; backfill cannot reconcile incomplete issues")
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

// installationToken mints an installation token holding only permissions.
func (g *mythicalGitHubAPI) installationToken(ctx context.Context, gh mythicalGitHubRepo, permissions map[string]string) (string, error) {
	installation, err := g.tokens.CreateGitHubInstallationTokenForRepositoryOwner(ctx, gh.userID, gh.orgID, gh.Owner, gh.Name, permissions)
	if err != nil {
		return "", err
	}
	if token := strings.TrimSpace(installation.Token); token != "" {
		return token, nil
	}
	return "", pkgerrors.BadRequest("github app is not installed for this repository")
}

// Merge is the stack's one write to GitHub main. The sha pins the merge to
// the reviewed head: GitHub refuses it (409) once the branch moved.
func (g *mythicalGitHubAPI) Merge(ctx context.Context, gh mythicalGitHubRepo, number int64, head string) (string, error) {
	token, err := g.installationToken(ctx, gh, map[string]string{"contents": "write", "pull_requests": "write"})
	if err != nil {
		return "", err
	}
	var merged struct {
		SHA    string `json:"sha"`
		Merged bool   `json:"merged"`
	}
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/pulls/" + strconv.FormatInt(number, 10) + "/merge"
	status, err := g.api.request(ctx, token, http.MethodPut, path, map[string]string{"sha": head, "merge_method": "squash"}, &merged)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK || !merged.Merged {
		return "", landingGitHubStatusError(status, gh.Owner, gh.Name, "merge pull requests")
	}
	return merged.SHA, nil
}

func (g *mythicalGitHubAPI) RemoveLabel(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) error {
	token, err := g.installationToken(ctx, gh, map[string]string{"issues": "write"})
	if err != nil {
		return err
	}
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10) + "/labels/" + url.PathEscape(label)
	status, err := g.api.request(ctx, token, http.MethodDelete, path, nil, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNotFound {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "edit issue labels")
	}
	return nil
}

// mythicalLabelApplier is who applied a label, and whether a GitHub App
// did it on their behalf.
type mythicalLabelApplier struct {
	Actor  gitHubActor
	ViaApp bool
	// EventID is the labeled event's GitHub id: one per application, so a
	// replayed delivery of it is told from a new application.
	EventID int64
	// Removed marks the label's last event as its removal, by Actor.
	Removed bool
}

// present reports whether the label is on the issue now.
func (a *mythicalLabelApplier) present() bool { return a != nil && !a.Removed }

// LabelApplier reads who last applied or removed label (nil: never), from
// the issue's whole event history (at most 10 pages of
// 100); a longer history is refused rather than read in part.
func (g *mythicalGitHubAPI) LabelApplier(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) (*mythicalLabelApplier, error) {
	// The issue's labels as they are now decide; the history only names who
	// applied or removed one. When the two disagree the history trails the
	// labels, and nothing is answered until it catches up.
	var issue struct {
		Labels []gitHubLabel `json:"labels"`
	}
	status, err := g.api.request(ctx, gh.Token, http.MethodGet, landingGitHubRepoPath(gh.Owner, gh.Name)+"/issues/"+strconv.FormatInt(number, 10), nil, &issue)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read the issue")
	}
	present := false
	for _, current := range issue.Labels {
		present = present || strings.EqualFold(current.Name, label)
	}
	applier, err := g.labelHistory(ctx, gh, number, label)
	if err != nil {
		return nil, err
	}
	if present != applier.present() {
		return nil, errors.New("GitHub's label history trails the issue's labels; read again later")
	}
	return applier, nil
}

// labelHistory answers the last application or removal of label in the
// issue's event history, nil when there is none.
func (g *mythicalGitHubAPI) labelHistory(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) (*mythicalLabelApplier, error) {
	var applier *mythicalLabelApplier
	for page := 1; ; page++ {
		if page > 10 {
			return nil, errors.New("the issue's label history is too long to read whole")
		}
		var events []struct {
			ID     int64            `json:"id"`
			Event  string           `json:"event"`
			Actor  gitHubActor      `json:"actor"`
			ViaApp *json.RawMessage `json:"performed_via_github_app"`
			Label  struct {
				Name string `json:"name"`
			} `json:"label"`
		}
		path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10) + "/events?per_page=100&page=" + strconv.Itoa(page)
		status, err := g.api.request(ctx, gh.Token, http.MethodGet, path, nil, &events)
		if err != nil {
			return nil, err
		}
		if status != http.StatusOK {
			return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read issue events")
		}
		for _, event := range events {
			if !strings.EqualFold(event.Label.Name, label) {
				continue
			}
			switch event.Event {
			case "labeled":
				applier = &mythicalLabelApplier{Actor: event.Actor, ViaApp: event.ViaApp != nil && string(*event.ViaApp) != "null", EventID: event.ID}
			case "unlabeled":
				applier = &mythicalLabelApplier{Actor: event.Actor, EventID: event.ID, Removed: true}
			}
		}
		if len(events) < 100 {
			return applier, nil
		}
	}
}

func (g *mythicalGitHubAPI) Comment(ctx context.Context, gh mythicalGitHubRepo, number int64, body string) error {
	token, err := g.installationToken(ctx, gh, map[string]string{"issues": "write"})
	if err != nil {
		return err
	}
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10) + "/comments"
	status, err := g.api.request(ctx, token, http.MethodPost, path, map[string]string{"body": body}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusCreated {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "comment on issues")
	}
	return nil
}

func (g *mythicalGitHubAPI) AddLabel(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) error {
	token, err := g.installationToken(ctx, gh, map[string]string{"issues": "write"})
	if err != nil {
		return err
	}
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10) + "/labels"
	status, err := g.api.request(ctx, token, http.MethodPost, path, map[string][]string{"labels": {label}}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "edit issue labels")
	}
	return nil
}

// GitHub CI verdicts on one commit.
const (
	mythicalCIGreen   = "green"
	mythicalCIPending = "pending"
	mythicalCIRed     = "red"
)

// headSuites reads one page of the commit's check suites: red on a failed
// suite, pending while one that is CI has not finished, and whether the
// page was full.
func (g *mythicalGitHubAPI) headSuites(ctx context.Context, token string, gh mythicalGitHubRepo, commit string, page int) (string, bool, error) {
	var suites struct {
		CheckSuites []struct {
			Status     string  `json:"status"`
			Conclusion *string `json:"conclusion"`
			Runs       int     `json:"latest_check_runs_count"`
			App        *struct {
				Slug string `json:"slug"`
			} `json:"app"`
		} `json:"check_suites"`
	}
	status, err := g.api.request(ctx, token, http.MethodGet, commit+"/check-suites?per_page=100&page="+strconv.Itoa(page), nil, &suites)
	if err != nil {
		return "", false, err
	}
	if status != http.StatusOK {
		return "", false, landingGitHubStatusError(status, gh.Owner, gh.Name, "read check suites")
	}
	verdict := mythicalCIGreen
	for _, suite := range suites.CheckSuites {
		actions := suite.App != nil && suite.App.Slug == "github-actions"
		switch {
		case suite.Runs == 0 && !actions && suite.Status != "completed":
			// An App's placeholder suite: it never ran here.
		case suite.Status != "completed" || suite.Conclusion == nil:
			verdict = mythicalCIPending
		case *suite.Conclusion != "success" && *suite.Conclusion != "neutral" && *suite.Conclusion != "skipped":
			return mythicalCIRed, false, nil
		}
	}
	return verdict, len(suites.CheckSuites) == 100, nil
}

// HeadChecks is green only when at least one check reported on the commit
// and every check run and commit status on it finished successfully
// (success, neutral or skipped). A failed one is red; one still running, or
// no report at all yet, is pending. Nothing reads a job name, so an advisory
// job's failure holds the merge for a person too.
func (g *mythicalGitHubAPI) HeadChecks(ctx context.Context, gh mythicalGitHubRepo, sha string) (string, error) {
	token, err := g.installationToken(ctx, gh, map[string]string{"checks": "read", "statuses": "read"})
	if err != nil {
		return "", err
	}
	commit := landingGitHubRepoPath(gh.Owner, gh.Name) + "/commits/" + url.PathEscape(sha)
	reported, pending := 0, false
	for page := 1; ; page++ {
		if page > 10 {
			// Runs past what is read could be red: never green on a part.
			return mythicalCIPending, nil
		}
		var runs struct {
			CheckRuns []struct {
				Status     string  `json:"status"`
				Conclusion *string `json:"conclusion"`
			} `json:"check_runs"`
		}
		status, err := g.api.request(ctx, token, http.MethodGet, commit+"/check-runs?per_page=100&page="+strconv.Itoa(page), nil, &runs)
		if err != nil {
			return "", err
		}
		if status != http.StatusOK {
			return "", landingGitHubStatusError(status, gh.Owner, gh.Name, "read check runs")
		}
		for _, run := range runs.CheckRuns {
			reported++
			switch {
			case run.Status != "completed" || run.Conclusion == nil:
				pending = true
			case *run.Conclusion != "success" && *run.Conclusion != "neutral" && *run.Conclusion != "skipped":
				return mythicalCIRed, nil
			}
		}
		if len(runs.CheckRuns) < 100 {
			break
		}
	}
	// A workflow whose later jobs have no check run yet still has a suite
	// that has not completed: CI is green only once every suite finished.
	// GitHub also opens a suite on every push for each installed App that
	// may write checks, and one whose App never runs on the commit stays
	// queued with no runs forever: such a suite is not CI. A GitHub Actions
	// suite always counts, so a workflow whose jobs are not created yet
	// (ci.yml's required jobs among them) keeps the head pending.
	for page := 1; ; page++ {
		if page > 10 {
			return mythicalCIPending, nil
		}
		verdict, full, err := g.headSuites(ctx, token, gh, commit, page)
		if err != nil || verdict == mythicalCIRed {
			return verdict, err
		}
		pending = pending || verdict == mythicalCIPending
		if !full {
			break
		}
	}
	var combined struct {
		State      string `json:"state"`
		TotalCount int    `json:"total_count"`
	}
	status, err := g.api.request(ctx, token, http.MethodGet, commit+"/status", nil, &combined)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", landingGitHubStatusError(status, gh.Owner, gh.Name, "read commit statuses")
	}
	if combined.TotalCount > 0 {
		reported += combined.TotalCount
		switch combined.State {
		case "success":
		case "pending":
			pending = true
		default:
			return mythicalCIRed, nil
		}
	}
	if pending || reported == 0 {
		return mythicalCIPending, nil
	}
	return mythicalCIGreen, nil
}
