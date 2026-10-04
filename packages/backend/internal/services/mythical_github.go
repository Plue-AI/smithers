package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// mythicalGitHubRepo is a repository's GitHub destination with credentials
// resolved for one run and never stored.
type mythicalGitHubRepo struct {
	Owner, Name string
	Token       string
	GitURL      string
	// userID and orgID own the repository; the stack's API writes mint
	// their own narrow installation tokens for it (Merge, the issue writes).
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
	Draft       bool
	NodeID      string
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
	CreatePull(ctx context.Context, gh mythicalGitHubRepo, title, head, base, body string, draft bool) (mythicalPull, error)
	// HeadChecks answers GitHub CI's verdict on one commit (mythicalCIGreen,
	// mythicalCIPending or mythicalCIRed).
	HeadChecks(ctx context.Context, gh mythicalGitHubRepo, sha string) (string, error)
	// HeadCheckFacts names each check on one commit and whether main's
	// protection requires it; a required check with no run yet is pending.
	HeadCheckFacts(ctx context.Context, gh mythicalGitHubRepo, sha string) ([]mythicalHeadCheck, error)
	// ReviewDecision is GitHub's verdict on main's required reviews for a
	// pull request: APPROVED, REVIEW_REQUIRED or CHANGES_REQUESTED, and ""
	// when main requires no review.
	ReviewDecision(ctx context.Context, gh mythicalGitHubRepo, number int64) (string, error)
	// Merge squash-merges a pull request only while its head is head, and
	// answers the merge commit.
	Merge(ctx context.Context, gh mythicalGitHubRepo, number int64, head string) (string, error)
	// LabelApplier answers who last applied label to an issue, or removed
	// it (Removed), as the issue's labels stand now: nil when none ever
	// applied it. It errs while GitHub's history trails the labels.
	LabelApplier(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) (*mythicalLabelApplier, error)
	// Comment posts body on an issue. With a key it says body once per key:
	// the comment carrying key is edited when one exists, else one is
	// posted, so a retry after a post that was not recorded never repeats
	// it; without one, every call posts.
	Comment(ctx context.Context, gh mythicalGitHubRepo, number int64, key, body string) error
	// CloseIssue closes an issue as completed; a closed one stays closed.
	CloseIssue(ctx context.Context, gh mythicalGitHubRepo, number int64) error
	// OnMain reports whether commit is reachable from the bookmark on
	// GitHub.
	OnMain(ctx context.Context, gh mythicalGitHubRepo, bookmark, commit string) (bool, error)
	// AddLabel puts label on an issue.
	AddLabel(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) error
	// RemoveLabel takes label off an issue; an absent label is removed.
	RemoveLabel(ctx context.Context, gh mythicalGitHubRepo, number int64, label string) error
	// Account reads the GitHub account with this numeric id as it stands
	// now: its login follows a rename.
	Account(ctx context.Context, gh mythicalGitHubRepo, id int64) (gitHubActor, error)
	// CreateIssue opens an issue with this title and body.
	CreateIssue(ctx context.Context, gh mythicalGitHubRepo, title, body string) (mythicalIssue, error)
}

// MythicalGitHubStore is what resolving a destination reads.
type MythicalGitHubStore interface {
	gitHubDestinationStore
}

// mythicalGitHubAPIPermissions covers the stack's API calls: reading issues
// and opening or reading its pull requests.
var mythicalGitHubAPIPermissions = map[string]string{"contents": "read", "issues": "read", "pull_requests": "write"}

type mythicalGitHubAPI struct {
	credentials GitHubAppCredentialReader
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
	api := &landingGitHubAPI{client: gitHubProviderClient(tokens, 30*time.Second), baseURL: githubAPIBaseURL}
	var credentials GitHubAppCredentialReader
	if connections, ok := tokens.(*RepoConnectionService); ok {
		credentials = connections.githubAppCredentials
	}
	return &mythicalGitHubAPI{
		credentials: credentials, api: api, text: &gitHubIssueTextAPI{api: api},
		store: store, tokens: tokens, prover: prover, connections: connections,
		gitBase: githubGitBaseURL,
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
	out := mythicalPull{Draft: p.Draft, NodeID: p.NodeID, Number: p.Number, URL: p.HTMLURL, State: p.State, Merged: p.MergedAt != nil,
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

// ClosePull is the Drop write primitive. Its caller must first persist the
// outbound intent and reconcile uncertain results through Pull (T-GH-09).
// Never invoke it before the merge fence and retained final capture settle.
func (g *mythicalGitHubAPI) ClosePull(ctx context.Context, gh mythicalGitHubRepo, number int64) error {
	token, err := g.installationToken(ctx, gh, map[string]string{"pull_requests": "write"})
	if err != nil {
		return err
	}
	status, err := g.api.request(ctx, token, http.MethodPatch,
		landingGitHubRepoPath(gh.Owner, gh.Name)+"/pulls/"+strconv.FormatInt(number, 10), map[string]string{"state": "closed"}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "close pull requests")
	}
	return nil
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

func (g *mythicalGitHubAPI) CreatePull(ctx context.Context, gh mythicalGitHubRepo, title, head, base, body string, draft bool) (mythicalPull, error) {
	created, err := g.api.Create(ctx, gh.Token, gh.Owner, gh.Name, landingGitHubPullCreate{Title: title, Head: head, Base: base, Body: body,
		MaintainerCanModify: true, Draft: draft})
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
	var refusal GitHubRefusal
	status, err := g.api.request(ctx, token, http.MethodPut, path, map[string]string{"sha": head, "merge_method": "squash"}, &merged, &refusal)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK || !merged.Merged {
		if (status == 405 || status == 409 || status == 422) && refusal.Message != "" {
			return "", &refusal
		}
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

// mythicalCommentMarker is the hidden mark a keyed comment carries, so a
// retry finds it.
func mythicalCommentMarker(key string) string {
	return "<!-- smithers:" + strings.ReplaceAll(key, "--", "-") + " -->"
}

// mythicalCommentPages bounds how many pages of an issue's comments a keyed
// comment reads for its earlier say.
const mythicalCommentPages = 10

// findComment answers the id of the comment an App posted carrying marker, 0
// when none does. A person's comment quoting the marker is never taken for
// the stack's, and past mythicalCommentPages pages the thread is taken to
// hold none, so a very long thread gets a new comment rather than none.
func (g *mythicalGitHubAPI) findComment(ctx context.Context, gh mythicalGitHubRepo, number int64, marker string) (int64, error) {
	credentials, err := loadGitHubAppCredentials(ctx, g.credentials)
	if err != nil {
		return 0, err
	}
	if credentials.ID <= 0 {
		return 0, ErrGitHubAppNotConfigured
	}

	for page := 1; page <= mythicalCommentPages; page++ {
		var comments []struct {
			ID   int64  `json:"id"`
			Body string `json:"body"`
			User struct {
				Type string `json:"type"`
			} `json:"user"`
			App *struct {
				ID int64 `json:"id"`
			} `json:"performed_via_github_app"`
		}
		path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10) + "/comments?per_page=100&page=" + strconv.Itoa(page)
		status, err := g.api.request(ctx, gh.Token, http.MethodGet, path, nil, &comments)
		if err != nil {
			return 0, err
		}
		if status != http.StatusOK {
			return 0, landingGitHubStatusError(status, gh.Owner, gh.Name, "read issue comments")
		}
		for _, comment := range comments {
			if comment.App != nil && comment.App.ID == credentials.ID && comment.User.Type == "Bot" && strings.Contains(comment.Body, marker) {
				return comment.ID, nil
			}
		}
		if len(comments) < 100 {
			return 0, nil
		}
	}
	return 0, nil
}

func (g *mythicalGitHubAPI) Comment(ctx context.Context, gh mythicalGitHubRepo, number int64, key, body string) error {
	var existing int64
	payload := map[string]string{"body": body}
	if key != "" {
		marker := mythicalCommentMarker(key)
		found, err := g.findComment(ctx, gh, number, marker)
		if err != nil {
			return err
		}
		existing, payload["body"] = found, body+"\n\n"+marker
	}
	token, err := g.installationToken(ctx, gh, map[string]string{"issues": "write"})
	if err != nil {
		return err
	}
	if existing != 0 {
		path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/comments/" + strconv.FormatInt(existing, 10)
		status, err := g.api.request(ctx, token, http.MethodPatch, path, payload, nil)
		if err != nil {
			return err
		}
		if status != http.StatusOK {
			return landingGitHubStatusError(status, gh.Owner, gh.Name, "comment on issues")
		}
		return nil
	}
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10) + "/comments"
	status, err := g.api.request(ctx, token, http.MethodPost, path, payload, nil)
	if err != nil {
		return err
	}
	if status != http.StatusCreated {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "comment on issues")
	}
	return nil
}

func (g *mythicalGitHubAPI) CloseIssue(ctx context.Context, gh mythicalGitHubRepo, number int64) error {
	token, err := g.installationToken(ctx, gh, map[string]string{"issues": "write"})
	if err != nil {
		return err
	}
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/issues/" + strconv.FormatInt(number, 10)
	status, err := g.api.request(ctx, token, http.MethodPatch, path, map[string]string{"state": "closed", "state_reason": "completed"}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "close issues")
	}
	return nil
}

// OnMain compares the bookmark with the commit: a commit the bookmark is
// not behind at all is reachable from it.
func (g *mythicalGitHubAPI) OnMain(ctx context.Context, gh mythicalGitHubRepo, bookmark, commit string) (bool, error) {
	ahead, err := g.api.AheadBy(ctx, gh.Token, gh.Owner, gh.Name, bookmark, commit)
	if err != nil {
		return false, err
	}
	return ahead == 0, nil
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
// no report at all yet, is pending. Required names absent from the head
// remain pending; advisory failures retain the existing merge hold.
// HeadChecks and projections read the same named facts.
func (g *mythicalGitHubAPI) HeadChecks(ctx context.Context, gh mythicalGitHubRepo, sha string) (string, error) {
	facts, err := g.HeadCheckFacts(ctx, gh, sha)
	if err != nil {
		return "", err
	}
	if len(facts) == 0 {
		return mythicalCIPending, nil
	}
	pending := false
	for _, f := range facts {
		if f.State == mythicalCIRed {
			return mythicalCIRed, nil
		}
		pending = pending || f.State == mythicalCIPending
	}
	token, err := g.installationToken(ctx, gh, map[string]string{"checks": "read", "statuses": "read"})
	if err != nil {
		return "", err
	}
	commit := landingGitHubRepoPath(gh.Owner, gh.Name) + "/commits/" + url.PathEscape(sha)
	for page := 1; page <= 10; page++ {
		verdict, full, err := g.headSuites(ctx, token, gh, commit, page)
		if err != nil || verdict == mythicalCIRed {
			return verdict, err
		}
		pending = pending || verdict == mythicalCIPending
		if !full {
			if pending {
				return mythicalCIPending, nil
			}
			return mythicalCIGreen, nil
		}
	}
	return mythicalCIPending, nil
}
