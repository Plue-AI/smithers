package services

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHub's events carry the author's association with the repository, never
// the editor's, and an association (MEMBER, COLLABORATOR) does not say
// whether the account may write. So the author and the last writer of each
// part of an object's text (an issue's or pull request's title and body, a
// comment's or review's body) are read separately: the sender of an event for
// the parts it wrote, otherwise GitHub's edit history. Each must be a
// maintainer: a user whose live repository permission is write, maintain or
// admin. An app, a bot, a deleted account, a read or triage user is not.

// gitHubMaintainerTTL is how long a permission answer is reused.
const gitHubMaintainerTTL = time.Minute

// gitHubIssueTextAPI reads text writers and collaborator permissions.
type gitHubIssueTextAPI struct {
	api *landingGitHubAPI
	now func() time.Time

	mu          sync.Mutex
	maintainers map[string]gitHubMaintainerAnswer
}

type gitHubMaintainerAnswer struct {
	maintainer bool
	at         time.Time
}

// errGitHubIssueTextUnavailable is a transient failure: the caller retries.
var errGitHubIssueTextUnavailable = errors.New("GitHub did not answer who wrote the issue text")

// gitHubIssueText is an issue's current text, its author, and the last
// writer of each part (nil when GitHub names none, such as a deleted
// account).
type gitHubIssueText struct {
	Title, Body             string
	Author                  *gitHubActor
	TitleWriter, BodyWriter *gitHubActor
}

const gitHubIssueTextFields = `title body author{__typename login} userContentEdits(first:1){nodes{editor{__typename login}}} ` +
	`timelineItems(itemTypes:[RENAMED_TITLE_EVENT],last:1){nodes{... on RenamedTitleEvent{actor{__typename login}}}}`

const gitHubIssueTextQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){` +
	`issueOrPullRequest(number:$number){... on Issue{` + gitHubIssueTextFields + `} ... on PullRequest{` + gitHubIssueTextFields + `}}}}`

type gitHubGraphQLActor struct {
	Typename string `json:"__typename"`
	Login    string `json:"login"`
}

func (a *gitHubGraphQLActor) actor() *gitHubActor {
	if a == nil || strings.TrimSpace(a.Login) == "" {
		return nil
	}
	return &gitHubActor{Login: a.Login, Type: a.Typename}
}

// IssueText reads an issue's current text and the last writer of each part:
// the newest body edit (userContentEdits lists the newest first) and the last
// title rename (the timeline lists the oldest first); a part never changed
// was written by the author.
func (g *gitHubIssueTextAPI) IssueText(ctx context.Context, token, owner, repo string, number int64) (gitHubIssueText, error) {
	var out struct {
		Data struct {
			Repository *struct {
				Issue *struct {
					Title  string              `json:"title"`
					Body   string              `json:"body"`
					Author *gitHubGraphQLActor `json:"author"`
					Edits  struct {
						Nodes []struct {
							Editor *gitHubGraphQLActor `json:"editor"`
						} `json:"nodes"`
					} `json:"userContentEdits"`
					Renames struct {
						Nodes []struct {
							Actor *gitHubGraphQLActor `json:"actor"`
						} `json:"nodes"`
					} `json:"timelineItems"`
				} `json:"issueOrPullRequest"`
			} `json:"repository"`
		} `json:"data"`
		Errors []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	status, err := g.api.request(ctx, token, http.MethodPost, "/graphql", map[string]any{
		"query": gitHubIssueTextQuery, "variables": map[string]any{"owner": owner, "name": repo, "number": number},
	}, &out)
	if err != nil || gitHubTransient(status) {
		return gitHubIssueText{}, errGitHubIssueTextUnavailable
	}
	for _, graphErr := range out.Errors {
		if graphErr.Type == "RATE_LIMITED" {
			return gitHubIssueText{}, errGitHubIssueTextUnavailable
		}
	}
	if status != http.StatusOK || len(out.Errors) > 0 || out.Data.Repository == nil || out.Data.Repository.Issue == nil {
		return gitHubIssueText{}, pkgerrors.Forbidden("GitHub did not show who wrote the issue text")
	}
	issue := out.Data.Repository.Issue
	text := gitHubIssueText{Title: issue.Title, Body: issue.Body}
	if author := issue.Author.actor(); author != nil {
		// GraphQL types the author by its account; the rule needs a user.
		text.Author, text.TitleWriter, text.BodyWriter = author, author, author
	}
	if len(issue.Renames.Nodes) > 0 {
		text.TitleWriter = issue.Renames.Nodes[0].Actor.actor()
	}
	if len(issue.Edits.Nodes) > 0 {
		text.BodyWriter = issue.Edits.Nodes[0].Editor.actor()
	}
	return text, nil
}

// gitHubTransient is a status worth retrying: a server error or a rate
// limit (GitHub answers a secondary rate limit with 403; an installation
// token always reads repository metadata and the issues it was sent).
func gitHubTransient(status int) bool {
	return status >= 500 || status == http.StatusTooManyRequests || status == http.StatusForbidden
}

// Maintainer reports whether login may write the repository: GitHub's
// permission is admin or write (maintain reads as write, triage as read, and
// a custom role as its base). An answer is reused for gitHubMaintainerTTL; a
// failure is not remembered and fails the caller closed.
func (g *gitHubIssueTextAPI) Maintainer(ctx context.Context, token, owner, repo, login string) (bool, error) {
	key := strings.ToLower(owner + "/" + repo + "/" + login)
	now := time.Now
	if g.now != nil {
		now = g.now
	}
	g.mu.Lock()
	cached, ok := g.maintainers[key]
	g.mu.Unlock()
	if ok && now().Sub(cached.at) < gitHubMaintainerTTL {
		return cached.maintainer, nil
	}
	var out struct {
		Permission string `json:"permission"`
	}
	status, err := g.api.request(ctx, token, http.MethodGet,
		landingGitHubRepoPath(owner, repo)+"/collaborators/"+url.PathEscape(login)+"/permission", nil, &out)
	if err != nil || gitHubTransient(status) {
		return false, errGitHubIssueTextUnavailable
	}
	maintainer := status == http.StatusOK && (out.Permission == "admin" || out.Permission == "write")
	g.mu.Lock()
	if g.maintainers == nil {
		g.maintainers = map[string]gitHubMaintainerAnswer{}
	}
	at := now()
	for other, answer := range g.maintainers {
		if at.Sub(answer.at) >= gitHubMaintainerTTL {
			delete(g.maintainers, other)
		}
	}
	g.maintainers[key] = gitHubMaintainerAnswer{maintainer: maintainer, at: at}
	g.mu.Unlock()
	return maintainer, nil
}

// forget drops the cached answers for owner's repositories, or every answer
// when owner is empty.
func (g *gitHubIssueTextAPI) forget(owner string) {
	prefix := strings.ToLower(strings.TrimSpace(owner)) + "/"
	g.mu.Lock()
	defer g.mu.Unlock()
	for key := range g.maintainers {
		if prefix == "/" || strings.HasPrefix(key, prefix) {
			delete(g.maintainers, key)
		}
	}
}

// gitHubPermissionEvents change who may write a repository: a collaborator,
// a team's repository or members, an organization's members, or the
// repository itself (transferred, made private).
var gitHubPermissionEvents = map[string]bool{"member": true, "membership": true, "team": true, "team_add": true,
	"organization": true, "repository": true}

// forgetMaintainers drops the permission answers an event may have changed:
// the repository owner's, or the organization's.
func (s *GitHubTextStamper) forgetMaintainers(eventType string, payload []byte) {
	if s == nil || s.api == nil || !gitHubPermissionEvents[NormalizeTriggerName(eventType)] {
		return
	}
	var event struct {
		Repository struct {
			Owner struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"repository"`
		Organization struct {
			Login string `json:"login"`
		} `json:"organization"`
	}
	_ = json.Unmarshal(payload, &event)
	owner := event.Repository.Owner.Login
	if owner == "" {
		owner = event.Organization.Login
	}
	s.api.forget(owner)
}

// LabelAppliedByPerson reports whether this application of label to an
// issue by login (the event GitHub lists at appliedAt, give or take a few
// seconds) was the person's own, not a GitHub App acting for them
// (performed_via_github_app). An application GitHub does not list yet is
// retried; one it will not list, or an issue with more events than are
// read, is not the person's.
func (g *gitHubIssueTextAPI) LabelAppliedByPerson(ctx context.Context, token, owner, repo string, number int64, label, login string, appliedAt time.Time) (bool, error) {
	const pages, skew = 10, 5 * time.Second
	var found *bool
	for page := 1; ; page++ {
		if page > pages {
			slog.Warn("github.label_events_unread", "owner", owner, "repo", repo, "issue", number)
			return false, nil
		}
		var events []struct {
			Event string `json:"event"`
			Actor *struct {
				Login string `json:"login"`
			} `json:"actor"`
			Label *struct {
				Name string `json:"name"`
			} `json:"label"`
			CreatedAt time.Time        `json:"created_at"`
			ViaApp    *json.RawMessage `json:"performed_via_github_app"`
		}
		query := url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}
		status, err := g.api.request(ctx, token, http.MethodGet,
			landingGitHubRepoPath(owner, repo)+"/issues/"+strconv.FormatInt(number, 10)+"/events?"+query.Encode(), nil, &events)
		if err != nil || gitHubTransient(status) {
			return false, errGitHubIssueTextUnavailable
		}
		if status != http.StatusOK {
			slog.Warn("github.label_events_unreadable", "owner", owner, "repo", repo, "issue", number, "status", status)
			return false, nil
		}
		for _, event := range events {
			if event.Event == "labeled" && event.Actor != nil && event.Label != nil &&
				strings.EqualFold(event.Actor.Login, login) && strings.EqualFold(strings.TrimSpace(event.Label.Name), strings.TrimSpace(label)) &&
				!event.CreatedAt.Before(appliedAt.Add(-skew)) && !event.CreatedAt.After(appliedAt.Add(skew)) {
				person := event.ViaApp == nil || string(*event.ViaApp) == "null"
				found = &person
			}
		}
		if len(events) < 100 {
			break
		}
	}
	if found == nil {
		// GitHub's list can trail the webhook.
		return false, errGitHubIssueTextUnavailable
	}
	return *found, nil
}

// PullCreatedViaApp reads whether a pull request was created through a
// GitHub App: pull request events do not say, its issue does.
func (g *gitHubIssueTextAPI) PullCreatedViaApp(ctx context.Context, token, owner, repo string, number int64) (bool, error) {
	var issue struct {
		ViaApp *json.RawMessage `json:"performed_via_github_app"`
	}
	status, err := g.api.request(ctx, token, http.MethodGet,
		landingGitHubRepoPath(owner, repo)+"/issues/"+strconv.FormatInt(number, 10), nil, &issue)
	if err != nil || gitHubTransient(status) {
		return false, errGitHubIssueTextUnavailable
	}
	return status != http.StatusOK || (issue.ViaApp != nil && string(*issue.ViaApp) != "null"), nil
}

// personIsMaintainer applies the maintainer rule to one account: a user
// (never an app, bot or organization) with write access.
func (g *gitHubIssueTextAPI) personIsMaintainer(ctx context.Context, token, owner, repo string, actor *gitHubActor) (bool, error) {
	if actor == nil || actor.Type != "User" || strings.TrimSpace(actor.Login) == "" {
		return false, nil
	}
	return g.Maintainer(ctx, token, owner, repo, actor.Login)
}

// gitHubIssueTextWrite is what one event says about an issue's text: its
// current title and body, and the writer of each part the event itself wrote
// (nil: the event wrote it not, so GitHub's history names the writer).
type gitHubIssueTextWrite struct {
	Number                  int64
	Title, Body             string
	Author                  gitHubActor
	TitleWriter, BodyWriter *gitHubActor
	// ViaApp: the object was created through a GitHub App acting for its
	// author (performed_via_github_app). Its text is the app's: GitHub does
	// not say whether a later edit was the app's too, so it is never a
	// maintainer's; only a maintainer's label approves it.
	ViaApp bool
}

// TextByMaintainer reports whether an object's author and the last writer
// of both parts of its text are maintainers. A part the event did not write
// is read from GitHub and must still be the event's text; text GitHub no
// longer shows is not a maintainer's.
func (g *gitHubIssueTextAPI) TextByMaintainer(ctx context.Context, token, owner, repo string, write gitHubIssueTextWrite) (bool, error) {
	if write.ViaApp {
		return false, nil
	}
	if write.TitleWriter == nil || write.BodyWriter == nil {
		current, err := g.IssueText(ctx, token, owner, repo, write.Number)
		if errors.Is(err, errGitHubIssueTextUnavailable) {
			return false, err
		}
		if err != nil {
			slog.Warn("github.issue_text_unreadable", "owner", owner, "repo", repo, "issue", write.Number, "error", err)
			return false, nil
		}
		if write.TitleWriter == nil {
			if current.Title != write.Title {
				return false, nil
			}
			write.TitleWriter = current.TitleWriter
		}
		if write.BodyWriter == nil {
			if current.Body != write.Body {
				return false, nil
			}
			write.BodyWriter = current.BodyWriter
		}
		if write.Author.Login == "" && current.Author != nil {
			write.Author = *current.Author
		}
	}
	for _, person := range []*gitHubActor{&write.Author, write.TitleWriter, write.BodyWriter} {
		if ok, err := g.personIsMaintainer(ctx, token, owner, repo, person); err != nil || !ok {
			return false, err
		}
	}
	return true, nil
}

// gitHubIssueTextTokens mints the installation token that reads writers.
type gitHubIssueTextTokens interface {
	CreateGitHubInstallationTokenForInternalInstallation(ctx context.Context, installationID int64) (GitHubInstallationToken, error)
}

// GitHubTextStamper sets issueTextByMaintainerField on every issue, pull
// request, comment and review object of a signed event, and
// labelAppliedByMaintainerField on the label a labeled event applied, before
// any consumer reads it. Without one, both are false.
type GitHubTextStamper struct {
	api    *gitHubIssueTextAPI
	tokens gitHubIssueTextTokens
}

// NewGitHubTextStamper reads writers through the GitHub App.
func NewGitHubTextStamper(tokens gitHubIssueTextTokens) *GitHubTextStamper {
	return &GitHubTextStamper{tokens: tokens, api: &gitHubIssueTextAPI{
		api: &landingGitHubAPI{client: observability.NewHTTPClient(30 * time.Second), baseURL: githubAPIBaseURL}}}
}

// gitHubStampedKinds are the events a consumer reads text from.
var gitHubStampedKinds = map[string]bool{"issue": true, "issue_comment": true, "pull_request": true, "pull_request_review": true}

// gitHubStampedObjects are the event objects that carry text, in the order
// they are stamped.
var gitHubStampedObjects = []string{"issue", "pull_request", "comment", "review"}

// gitHubTextEvent is what the stamper reads of a signed event.
type gitHubTextEvent struct {
	Changes    map[string]json.RawMessage `json:"changes"`
	Sender     *gitHubActor               `json:"sender"`
	Repository struct {
		Name  string `json:"name"`
		Owner struct {
			Login string `json:"login"`
		} `json:"owner"`
	} `json:"repository"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
}

// gitHubTextObject is one stamped object: an issue or pull request (a title
// and a body) or a comment or review (a body).
type gitHubTextObject struct {
	Number int64            `json:"number"`
	Title  *string          `json:"title"`
	Body   *string          `json:"body"`
	User   gitHubActor      `json:"user"`
	ViaApp *json.RawMessage `json:"performed_via_github_app"`
}

// stampGitHubText returns payload with issueTextByMaintainerField set on each
// text object. Only a transient GitHub failure is an error.
func (s *GitHubTextStamper) stampGitHubText(ctx context.Context, eventType, action string, payload []byte) ([]byte, error) {
	kind := NormalizeTriggerName(eventType)
	if !gitHubStampedKinds[kind] {
		return payload, nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(payload, &raw) != nil {
		return payload, nil
	}
	if strings.TrimSpace(action) == "" {
		_ = json.Unmarshal(raw["action"], &action)
	}
	var event gitHubTextEvent
	_ = json.Unmarshal(payload, &event)
	run := &gitHubTextStamp{stamper: s, ctx: ctx, event: event}
	changed := false
	for _, name := range gitHubStampedObjects {
		var object map[string]json.RawMessage
		if len(raw[name]) == 0 || json.Unmarshal(raw[name], &object) != nil || object == nil {
			continue
		}
		var text gitHubTextObject
		_ = json.Unmarshal(raw[name], &text)
		byMaintainer, err := run.object(kind, action, name, text)
		if err != nil {
			return nil, err
		}
		object[issueTextByMaintainerField], _ = json.Marshal(byMaintainer)
		if raw[name], err = json.Marshal(object); err != nil {
			return nil, err
		}
		changed = true
	}
	if kind == "issue" && strings.EqualFold(action, "labeled") && len(raw["label"]) > 0 {
		var label map[string]json.RawMessage
		var applied struct {
			Name string `json:"name"`
		}
		var issue struct {
			Number    int64     `json:"number"`
			UpdatedAt time.Time `json:"updated_at"`
		}
		_ = json.Unmarshal(raw["issue"], &issue)
		if json.Unmarshal(raw["label"], &label) == nil && label != nil && json.Unmarshal(raw["label"], &applied) == nil {
			byMaintainer, err := run.labelApplication(applied.Name, issue.Number, issue.UpdatedAt)
			if err != nil {
				return nil, err
			}
			label[labelAppliedByMaintainerField], _ = json.Marshal(byMaintainer)
			if raw["label"], err = json.Marshal(label); err != nil {
				return nil, err
			}
			changed = true
		}
	}
	if !changed {
		return payload, nil
	}
	return json.Marshal(raw)
}

// labelApplication reads whether a labeled event's sender is a maintainer
// person who applied the label themselves, not through a GitHub App (the
// event names the user an app acted for; the issue's events name the app).
func (r *gitHubTextStamp) labelApplication(label string, number int64, appliedAt time.Time) (bool, error) {
	if r.stamper == nil || r.stamper.api == nil || r.stamper.tokens == nil || r.event.Installation.ID <= 0 || r.event.Sender == nil {
		return false, nil
	}
	owner, repo := r.event.Repository.Owner.Login, r.event.Repository.Name
	if ok, err := r.personIsMaintainer(owner, repo, r.event.Sender); err != nil || !ok {
		return false, err
	}
	token, err := r.installationToken()
	if err != nil {
		return false, err
	}
	return r.stamper.api.LabelAppliedByPerson(r.ctx, token, owner, repo, number, label, r.event.Sender.Login, appliedAt)
}

// gitHubTextStamp stamps one event; it mints at most one token.
type gitHubTextStamp struct {
	stamper *GitHubTextStamper
	ctx     context.Context
	event   gitHubTextEvent
	token   string
}

// object reads whether one object's text is a maintainer's. The sender wrote
// the parts the event itself wrote: every part of an opened issue or pull
// request, a created comment or a submitted review, and the parts an edited
// event names (whose sender must be a maintainer even when GitHub reports no
// change). An issue's or pull request's other parts are read from GitHub's
// history; a comment or review body the event did not write is not trusted.
func (r *gitHubTextStamp) object(kind, action, name string, text gitHubTextObject) (bool, error) {
	s := r.stamper
	if s == nil || s.api == nil || s.tokens == nil || r.event.Installation.ID <= 0 {
		return false, nil
	}
	sender := r.event.Sender
	if sender == nil {
		sender = &gitHubActor{}
	}
	owner, repo := r.event.Repository.Owner.Login, r.event.Repository.Name
	// Which object the event is about: an issues event writes its issue, an
	// issue_comment event its comment, and so on; other objects are context.
	own := map[string]string{"issue": "issue", "pull_request": "pull_request", "issue_comment": "comment",
		"pull_request_review": "review"}[kind] == name
	write := gitHubIssueTextWrite{Number: text.Number, Author: text.User,
		ViaApp: text.ViaApp != nil && string(*text.ViaApp) != "null"}
	if text.Title != nil {
		write.Title = *text.Title
	}
	if text.Body != nil {
		write.Body = *text.Body
	}
	titled := name == "issue" || name == "pull_request"
	switch {
	case own && (strings.EqualFold(action, "opened") || strings.EqualFold(action, "created") || strings.EqualFold(action, "submitted")):
		write.TitleWriter, write.BodyWriter = sender, sender
	case own && strings.EqualFold(action, "edited"):
		if ok, err := r.personIsMaintainer(owner, repo, sender); err != nil || !ok {
			return false, err
		}
		if _, ok := r.event.Changes["title"]; ok {
			write.TitleWriter = sender
		}
		if _, ok := r.event.Changes["body"]; ok {
			write.BodyWriter = sender
		}
	}
	if !titled {
		// A comment or review has a body only; GitHub's history of it is not
		// read, so a body this event did not write is not a maintainer's.
		if write.BodyWriter == nil {
			return false, nil
		}
		write.TitleWriter = write.BodyWriter
	}
	token, err := r.installationToken()
	if err != nil {
		return false, err
	}
	trusted, err := s.api.TextByMaintainer(r.ctx, token, owner, repo, write)
	if err != nil || !trusted || name != "pull_request" {
		return trusted, err
	}
	// A pull request event does not name the app that created it; its issue
	// does.
	viaApp, err := s.api.PullCreatedViaApp(r.ctx, token, owner, repo, text.Number)
	return err == nil && !viaApp, err
}

func (r *gitHubTextStamp) personIsMaintainer(owner, repo string, person *gitHubActor) (bool, error) {
	token, err := r.installationToken()
	if err != nil {
		return false, err
	}
	return r.stamper.api.personIsMaintainer(r.ctx, token, owner, repo, person)
}

func (r *gitHubTextStamp) installationToken() (string, error) {
	if r.token != "" {
		return r.token, nil
	}
	token, err := r.stamper.tokens.CreateGitHubInstallationTokenForInternalInstallation(r.ctx, r.event.Installation.ID)
	if err != nil || strings.TrimSpace(token.Token) == "" {
		return "", errGitHubIssueTextUnavailable
	}
	r.token = token.Token
	return r.token, nil
}
