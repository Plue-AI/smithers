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

// GitHubIssueTextStamper sets issueTextByMaintainerField on a signed issue
// event before any consumer reads it. Without one, or for an untrusted
// author, the field is false.
type GitHubIssueTextStamper struct {
	api    *gitHubIssueTextAPI
	tokens gitHubIssueTextTokens
}

// NewGitHubIssueTextStamper reads writers through the GitHub App.
func NewGitHubIssueTextStamper(tokens gitHubIssueTextTokens) *GitHubIssueTextStamper {
	return &GitHubIssueTextStamper{tokens: tokens, api: &gitHubIssueTextAPI{
		api: &landingGitHubAPI{client: observability.NewHTTPClient(30 * time.Second), baseURL: githubAPIBaseURL}}}
}

// stampGitHubIssueText returns payload with the issue's
// issueTextByMaintainerField set. Only a transient GitHub failure is an error.
func (s *GitHubIssueTextStamper) stampGitHubIssueText(ctx context.Context, eventType, action string, payload []byte) ([]byte, error) {
	kind := NormalizeTriggerName(eventType)
	if kind != "issue" && kind != "issue_comment" {
		return payload, nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(payload, &raw) != nil || len(raw["issue"]) == 0 {
		return payload, nil
	}
	var issue map[string]json.RawMessage
	if json.Unmarshal(raw["issue"], &issue) != nil || issue == nil {
		return payload, nil
	}
	if strings.TrimSpace(action) == "" {
		_ = json.Unmarshal(raw["action"], &action)
	}
	byMaintainer, err := s.textByMaintainer(ctx, kind, action, payload)
	if err != nil {
		return nil, err
	}
	issue[issueTextByMaintainerField], _ = json.Marshal(byMaintainer)
	if raw["issue"], err = json.Marshal(issue); err != nil {
		return nil, err
	}
	return json.Marshal(raw)
}

func (s *GitHubIssueTextStamper) textByMaintainer(ctx context.Context, kind, action string, payload []byte) (bool, error) {
	var event struct {
		Issue struct {
			Number            int64       `json:"number"`
			Title             string      `json:"title"`
			Body              *string     `json:"body"`
			AuthorAssociation string      `json:"author_association"`
			User              gitHubActor `json:"user"`
		} `json:"issue"`
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
	if s == nil || s.api == nil || s.tokens == nil || json.Unmarshal(payload, &event) != nil ||
		!trustedGitHubAuthorAssociation(event.Issue.AuthorAssociation) || event.Installation.ID <= 0 {
		return false, nil
	}
	write := gitHubIssueTextWrite{Number: event.Issue.Number, Title: event.Issue.Title, Author: event.Issue.User}
	if event.Issue.Body != nil {
		write.Body = *event.Issue.Body
	}
	sender := event.Sender
	if sender == nil {
		sender = &gitHubActor{}
	}
	switch {
	case kind == "issue" && strings.EqualFold(action, "opened"):
		write.TitleWriter, write.BodyWriter = sender, sender
	case kind == "issue" && strings.EqualFold(action, "edited"):
		// The event names the parts it changed; its sender wrote them, and
		// must be a maintainer even when GitHub reports no change.
		if ok, err := s.maintainerSender(ctx, event.Installation.ID, event.Repository.Owner.Login, event.Repository.Name, write.Author, sender); err != nil || !ok {
			return false, err
		}
		if _, ok := event.Changes["title"]; ok {
			write.TitleWriter = sender
		}
		if _, ok := event.Changes["body"]; ok {
			write.BodyWriter = sender
		}
	}
	if gitHubUserWrote(write.Author, write.TitleWriter) && gitHubUserWrote(write.Author, write.BodyWriter) {
		return true, nil
	}
	token, err := s.token(ctx, event.Installation.ID)
	if err != nil {
		return false, err
	}
	return s.api.TextByMaintainer(ctx, token, event.Repository.Owner.Login, event.Repository.Name, write)
}

func (s *GitHubIssueTextStamper) maintainerSender(ctx context.Context, installationID int64, owner, repo string, author gitHubActor, sender *gitHubActor) (bool, error) {
	if gitHubUserWrote(author, sender) {
		return true, nil
	}
	token, err := s.token(ctx, installationID)
	if err != nil {
		return false, err
	}
	return s.api.writerIsMaintainer(ctx, token, owner, repo, author, sender)
}

func (s *GitHubIssueTextStamper) token(ctx context.Context, installationID int64) (string, error) {
	token, err := s.tokens.CreateGitHubInstallationTokenForInternalInstallation(ctx, installationID)
	if err != nil || strings.TrimSpace(token.Token) == "" {
		return "", errGitHubIssueTextUnavailable
	}
	return token.Token, nil
}
