package services

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHub's issue events carry the author's association with the repository,
// never the editor's, so who last wrote an issue's title and who last wrote
// its body are read separately: the sender of an opened or edited event for
// the parts it wrote, otherwise GitHub's edit history. A writer counts as a
// maintainer when it is a user who is the author or holds write access; an
// app, a bot, a deleted account or a triage user does not.

// gitHubIssueTextAPI reads issue writers and collaborator permissions.
type gitHubIssueTextAPI struct {
	api *landingGitHubAPI
}

// errGitHubIssueTextUnavailable is a transient failure: the caller retries.
var errGitHubIssueTextUnavailable = errors.New("GitHub did not answer who wrote the issue text")

// gitHubIssueText is an issue's current text, its author, and the last
// writer of each part (nil when GitHub names none, such as a deleted
// account).
type gitHubIssueText struct {
	Title, Body             string
	Author                  string
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
		text.Author, text.TitleWriter, text.BodyWriter = author.Login, author, author
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

// Maintainer reports whether login holds write access to the repository.
func (g *gitHubIssueTextAPI) Maintainer(ctx context.Context, token, owner, repo, login string) (bool, error) {
	var out struct {
		Permission string `json:"permission"`
	}
	status, err := g.api.request(ctx, token, http.MethodGet,
		landingGitHubRepoPath(owner, repo)+"/collaborators/"+url.PathEscape(login)+"/permission", nil, &out)
	if err != nil || gitHubTransient(status) {
		return false, errGitHubIssueTextUnavailable
	}
	return status == http.StatusOK && (out.Permission == "admin" || out.Permission == "write"), nil
}

// gitHubUserWrote reports whether writer is a user and is the author.
func gitHubUserWrote(author gitHubActor, writer *gitHubActor) bool {
	if writer == nil || writer.Type != "User" {
		return false
	}
	return (author.ID != 0 && writer.ID == author.ID) ||
		(strings.TrimSpace(author.Login) != "" && strings.EqualFold(strings.TrimSpace(writer.Login), strings.TrimSpace(author.Login)))
}

// writerIsMaintainer applies the writer rule: a user who is the author, or a
// user with write access.
func (g *gitHubIssueTextAPI) writerIsMaintainer(ctx context.Context, token, owner, repo string, author gitHubActor, writer *gitHubActor) (bool, error) {
	if gitHubUserWrote(author, writer) {
		return true, nil
	}
	if writer == nil || writer.Type != "User" || strings.TrimSpace(writer.Login) == "" {
		return false, nil
	}
	return g.Maintainer(ctx, token, owner, repo, writer.Login)
}

// gitHubIssueTextWrite is what one event says about an issue's text: its
// current title and body, and the writer of each part the event itself wrote
// (nil: the event wrote it not, so GitHub's history names the writer).
type gitHubIssueTextWrite struct {
	Number                  int64
	Title, Body             string
	Author                  gitHubActor
	TitleWriter, BodyWriter *gitHubActor
}

// TextByMaintainer reports whether both parts of an issue's text were last
// written by maintainers. A part the event did not write is read from GitHub
// and must still be the event's text; text GitHub no longer shows is not a
// maintainer's.
func (g *gitHubIssueTextAPI) TextByMaintainer(ctx context.Context, token, owner, repo string, write gitHubIssueTextWrite) (bool, error) {
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
		if write.Author.Login == "" {
			write.Author.Login = current.Author
		}
	}
	for _, writer := range []*gitHubActor{write.TitleWriter, write.BodyWriter} {
		if ok, err := g.writerIsMaintainer(ctx, token, owner, repo, write.Author, writer); err != nil || !ok {
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
// request, comment and review object of a signed event before any consumer
// reads it. Without one, or for an untrusted author, the field is false.
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
	Number            int64       `json:"number"`
	Title             *string     `json:"title"`
	Body              *string     `json:"body"`
	AuthorAssociation string      `json:"author_association"`
	User              gitHubActor `json:"user"`
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
	if !changed {
		return payload, nil
	}
	return json.Marshal(raw)
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
	if s == nil || s.api == nil || s.tokens == nil || r.event.Installation.ID <= 0 ||
		!trustedGitHubAuthorAssociation(text.AuthorAssociation) {
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
	write := gitHubIssueTextWrite{Number: text.Number, Author: text.User}
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
		if ok, err := r.writerIsMaintainer(owner, repo, write.Author, sender); err != nil || !ok {
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
	if gitHubUserWrote(write.Author, write.TitleWriter) && gitHubUserWrote(write.Author, write.BodyWriter) {
		return true, nil
	}
	token, err := r.installationToken()
	if err != nil {
		return false, err
	}
	return s.api.TextByMaintainer(r.ctx, token, owner, repo, write)
}

func (r *gitHubTextStamp) writerIsMaintainer(owner, repo string, author gitHubActor, writer *gitHubActor) (bool, error) {
	if gitHubUserWrote(author, writer) {
		return true, nil
	}
	token, err := r.installationToken()
	if err != nil {
		return false, err
	}
	return r.stamper.api.writerIsMaintainer(r.ctx, token, owner, repo, author, writer)
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
