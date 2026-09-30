package services

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Bounds on a TODO filed through Smithers: GitHub's own title limit, and the
// text a lane reads (mythicalPromptBytes).
const (
	mythicalTodoTitleRunes = 256
	mythicalTodoBodyBytes  = mythicalPromptBytes
)

// MythicalTodoInput is a TODO a person files through Smithers. Request,
// when given, names the filing: the same request again answers the TODO it
// filed instead of opening another issue.
type MythicalTodoInput struct {
	Title   string `json:"title"`
	Body    string `json:"body"`
	Request string `json:"request,omitempty"`
}

var mythicalTodoRequest = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// FileTodo files a TODO on the repository's GitHub issues for a maintainer
// person and admits it to the stack at once: the same TODO a maintainer's
// own GitHub issue labeled todo is, from the same one trust rule. The
// person is read through their linked GitHub account as it stands now; the
// policy must name that login (or name no one) and GitHub must count it a
// maintainer. The App opens the issue, so GitHub names the App: the text is
// the person's only while it stays exactly as filed, and an edit needs a
// maintainer's todo label as any outsider text does. The factory puts the
// todo label on it; a maintainer taking it off opts it out.
func (s *MythicalService) FileTodo(ctx context.Context, repositoryID, userID int64, input MythicalTodoInput) (MythicalItemView, error) {
	if err := middleware.RequirePerson(ctx, "file a TODO"); err != nil {
		return MythicalItemView{}, err
	}
	title, body := strings.TrimSpace(input.Title), strings.TrimSpace(input.Body)
	switch {
	case title == "":
		return MythicalItemView{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "title", Code: "missing_field"})
	case utf8.RuneCountInString(title) > mythicalTodoTitleRunes || strings.ContainsAny(title, "\r\n"):
		return MythicalItemView{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "title", Code: "invalid"})
	case len(body) > mythicalTodoBodyBytes || !utf8.ValidString(body):
		return MythicalItemView{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "body", Code: "invalid"})
	case input.Request != "" && !mythicalTodoRequest.MatchString(input.Request):
		return MythicalItemView{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "request", Code: "invalid"})
	}
	if s.github == nil {
		return MythicalItemView{}, pkgerrors.Internal("GitHub is not configured for the mythical stack")
	}
	q := s.queries()
	if _, err := q.GetMythicalStack(ctx, repositoryID); errors.Is(err, pgx.ErrNoRows) {
		return MythicalItemView{}, pkgerrors.NotFound("this repository has no history yet")
	} else if err != nil {
		return MythicalItemView{}, err
	}
	if input.Request != "" {
		items, err := q.ListMythicalItems(ctx, repositoryID, 1000)
		if err != nil {
			return MythicalItemView{}, err
		}
		for _, item := range items {
			if mythicalChecksOf(item).FiledRequest == input.Request {
				return mythicalItemView(item), nil
			}
		}
	}
	gh, account, err := s.maintainerPerson(ctx, repositoryID, userID, "file a TODO")
	if err != nil {
		return MythicalItemView{}, err
	}
	issue, err := s.github.CreateIssue(ctx, gh, title, body)
	if err != nil {
		return MythicalItemView{}, err
	}
	if err := s.ObserveIssue(ctx, repositoryID, issue, gitHubLabelApplication{
		AutoTodo: "filed by " + account.Login + ", a maintainer", FiledBy: account.Login, FiledRequest: input.Request,
	}); err != nil {
		return MythicalItemView{}, err
	}
	s.labelAutoTodo(ctx, repositoryID, issue)
	item, err := q.GetMythicalItemByIssue(ctx, repositoryID, issue.Number)
	if err != nil {
		return MythicalItemView{}, err
	}
	return mythicalItemView(item), nil
}

// personGitHubID is the numeric id of the GitHub account the person signed
// in with: a "github" account, else the GitHub sign-in's historical
// "workos" row (resolveUserGitHubAccessToken's order). A login is never
// trusted from the profile: it can be renamed.
func (s *MythicalService) personGitHubID(ctx context.Context, userID int64, act string) (int64, error) {
	accounts, err := s.queries().ListUserOAuthAccounts(ctx, userID)
	if err != nil {
		return 0, err
	}
	for _, provider := range []string{"github", "workos"} {
		for _, account := range accounts {
			if !strings.EqualFold(strings.TrimSpace(account.Provider), provider) {
				continue
			}
			if id, err := strconv.ParseInt(strings.TrimSpace(account.ProviderUserID), 10, 64); err == nil && id > 0 {
				return id, nil
			}
		}
	}
	return 0, pkgerrors.Forbidden("connect your GitHub account to " + act)
}

func (g *mythicalGitHubAPI) Account(ctx context.Context, gh mythicalGitHubRepo, id int64) (gitHubActor, error) {
	var account gitHubActor
	status, err := g.api.request(ctx, gh.Token, http.MethodGet, "/user/"+strconv.FormatInt(id, 10), nil, &account)
	if err != nil {
		return gitHubActor{}, err
	}
	if status != http.StatusOK {
		return gitHubActor{}, landingGitHubStatusError(status, gh.Owner, gh.Name, "read the account")
	}
	return account, nil
}

func (g *mythicalGitHubAPI) CreateIssue(ctx context.Context, gh mythicalGitHubRepo, title, body string) (mythicalIssue, error) {
	token, err := g.installationToken(ctx, gh, map[string]string{"issues": "write"})
	if err != nil {
		return mythicalIssue{}, err
	}
	var created mythicalGitHubIssue
	status, err := g.api.request(ctx, token, http.MethodPost, landingGitHubRepoPath(gh.Owner, gh.Name)+"/issues",
		map[string]string{"title": title, "body": body}, &created)
	if err != nil {
		return mythicalIssue{}, err
	}
	if status != http.StatusCreated {
		return mythicalIssue{}, landingGitHubStatusError(status, gh.Owner, gh.Name, "open issues")
	}
	// The answer is the App's own write: it names no maintainer text.
	created.TextByMaintainer = false
	return created.issue(), nil
}
