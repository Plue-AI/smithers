package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// MythicalTodoInput is a TODO a person files through Smithers. Request,
// when given, names the filing: the same request again answers the TODO it
// filed instead of opening another issue.
type MythicalTodoInput struct {
	Prompt     string            `json:"prompt"`
	Acceptance []string          `json:"acceptance"`
	Place      MythicalTodoPlace `json:"place"`
	Title      string            `json:"title"`
	Request    string            `json:"-"`
}

// MythicalTodoPlace is where a new TODO goes on the stack: the Draft's place
// {mode: append|before|amend, n?}. The zero value (no place) appends.
type MythicalTodoPlace struct {
	Mode string `json:"mode"`
	N    *int64 `json:"n,omitempty"`
}

func invalidTodoPlace(message string) error {
	return &TodoControlError{400, "invalid_place", "user", message}
}

// UnmarshalJSON admits only the object {mode, n?}; any other value is
// invalid_place, never a generic decode failure.
func (p *MythicalTodoPlace) UnmarshalJSON(data []byte) error {
	type plain MythicalTodoPlace
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || value.Mode == "" {
		return invalidTodoPlace("place must be {mode, n?}")
	}
	*p = MythicalTodoPlace(value)
	return nil
}

// FileTodo appends the person's prompt directly to the existing stack. No
// GitHub issue or machine launch is performed in the HTTP transaction.
func (s *MythicalService) FileTodo(ctx context.Context, repositoryID, userID int64, input MythicalTodoInput) (MythicalItemView, error) {
	if err := middleware.RequirePerson(ctx, "make a TODO"); err != nil {
		return MythicalItemView{}, err
	}
	if s == nil || s.store == nil {
		return MythicalItemView{}, issueTodoUnavailable()
	}
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.IsTokenAuth || info.SessionHash == "" || info.User == nil || info.User.ID != userID {
		return MythicalItemView{}, &TodoControlError{403, "permission", "permission", "Install owner session required"}
	}
	owner, err := s.queries().GetSelfHostOwner(ctx)
	if err != nil || owner.ID != userID {
		return MythicalItemView{}, &TodoControlError{403, "permission", "permission", "Install owner session required"}
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || strings.TrimSpace(input.Prompt) == "" || len(input.Title) > 256 || len(input.Prompt) > 64<<10 || input.Request == "" || len(input.Request) > 256 {
		return MythicalItemView{}, &TodoControlError{400, "invalid_todo", "user", "Title, prompt and Idempotency-Key are required"}
	}
	switch place := input.Place; {
	case place.Mode == "before" || place.Mode == "amend":
		return MythicalItemView{}, invalidTodoPlace("Only append is available; before and amend arrive with T-STK-02")
	case place.N != nil || place.Mode != "" && place.Mode != "append":
		return MythicalItemView{}, invalidTodoPlace("place must be {mode, n?}")
	}
	input.Place = MythicalTodoPlace{Mode: "append"}
	if input.Acceptance == nil {
		input.Acceptance = []string{}
	}
	canonical, _ := json.Marshal(input)
	var item db.MythicalItem
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repositoryID); err != nil {
			return err
		}
		existing, err := q.GetMythicalTodoRequest(ctx, repositoryID, info.SessionHash, input.Request)
		if err == nil {
			held := mythicalChecksOf(existing)
			if held.CreationPayload != string(canonical) {
				return &TodoControlError{409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}
			}
			item = existing
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, repositoryID)
		if err != nil || stack.State != "active" {
			return &TodoControlError{503, "stack_unavailable", "infra", "Repository stack is not ready"}
		}
		revision, _ := json.Marshal([]map[string]any{{"text": input.Prompt, "acceptance": input.Acceptance, "by": map[string]any{"kind": "person", "login": owner.Username, "name": owner.DisplayName, "avatar_url": todoAvatar(owner), "color_index": 0}, "at": s.now().UTC().Format(time.RFC3339Nano)}})
		checks := mythicalChecks{Todo: true, FiledRequest: input.Request, CreationSession: info.SessionHash, CreationPayload: string(canonical)}
		item, err = q.InsertMythicalTodo(ctx, repositoryID, userID, input.Title, input.Prompt, revision, checks.encode())
		if err != nil {
			return err
		}
		fact, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "attempt": item.Attempt, "from": "draft", "to": "queued", "actor": userID})
		if _, err = jobs.RecordFactInTx(ctx, tx, todoOperationScope(item), uuid.NewString(), "todo.created", "queued", fact); err != nil {
			return err
		}
		if _, err = q.RequestMythicalStack(ctx, repositoryID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return MythicalItemView{}, err
	}
	return mythicalItemView(item), nil
}

func todoOperationScope(item db.MythicalItem) jobs.Scope {
	return jobs.Scope{TenantID: strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "todo:" + uuidString(item.ID)}
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
