package services

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MythicalTodoInput is a TODO a person files through Smithers. Request,
// when given, names the filing: the same request again answers the TODO it
// filed instead of opening another issue.
type MythicalTodoInput struct {
	Title   string `json:"title"`
	Body    string `json:"body"`
	Request string `json:"request,omitempty"`
}

// FileTodo retains the old transport boundary while admission is dark. It no
// longer creates a GitHub issue: the issue snapshot and its author-bound digest
// must come from the install dispatcher before a TODO can be committed.
func (s *MythicalService) FileTodo(ctx context.Context, repositoryID, userID int64, input MythicalTodoInput) (MythicalItemView, error) {
	if err := middleware.RequirePerson(ctx, "make a TODO"); err != nil {
		return MythicalItemView{}, err
	}
	return MythicalItemView{}, issueTodoUnavailable()
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
