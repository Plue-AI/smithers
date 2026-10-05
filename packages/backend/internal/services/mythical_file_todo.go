package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
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
// filed instead of opening another issue. Issue, IssueDigest and Fixes come
// together from Make TODO (/todo.from-issue): the GitHub issue the Draft was
// made from, the digest of the title and body the member read, and whether
// the TODO closes the issue when it merges (absent: it does).
type MythicalTodoInput struct {
	Prompt      string            `json:"prompt"`
	Acceptance  []string          `json:"acceptance"`
	Place       MythicalTodoPlace `json:"place"`
	Title       string            `json:"title"`
	Issue       *int64            `json:"issue,omitempty"`
	IssueDigest string            `json:"issue_digest,omitempty"`
	Fixes       *bool             `json:"fixes,omitempty"`
	Request     string            `json:"-"`
}

// MythicalTodoPlace is where a new TODO goes on the stack: the Draft's place
// {mode: append|before|amend, n?}. The zero value (no place) appends; before
// names the TODO n it goes before.
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

// FileTodo puts the person's prompt on the existing stack: appended, or
// before Tn, where it takes Tn's place and Tn and every later item move one
// place later, so the stack admits it first. No GitHub issue or machine
// launch is performed in the HTTP transaction. A
// Draft made from an issue (Make TODO) commits as that issue's TODO:
// revision 1 is the Draft's text with reason from-issue and the issue's
// digest, and an issue holds one unmerged TODO. The TODO owes its issue the
// App's todo label and one "Committed as Tn" comment, which the stack's next
// pass posts (deliverNotice).
func (s *MythicalService) FileTodo(ctx context.Context, repositoryID, userID int64, input MythicalTodoInput) (MythicalItemView, error) {
	if err := middleware.RequirePerson(ctx, "make a TODO"); err != nil {
		return MythicalItemView{}, err
	}
	if s == nil || s.store == nil {
		return MythicalItemView{}, issueTodoUnavailable()
	}
	decision, err := Authorize(ctx, s.queries(), "todo.new")
	if err != nil {
		return MythicalItemView{}, err
	}
	if decision.UserID != userID {
		return MythicalItemView{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Sign in with a browser session"}
	}
	info := middleware.AuthInfoFromContext(ctx)
	// The first revision is the person's own text, by them.
	person, err := s.queries().GetUserByID(ctx, userID)
	if err != nil {
		return MythicalItemView{}, err
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || strings.TrimSpace(input.Prompt) == "" || len(input.Title) > 256 || len(input.Prompt) > 64<<10 || input.Request == "" || len(input.Request) > 256 {
		return MythicalItemView{}, &TodoControlError{400, "invalid_todo", "user", "Title, prompt and Idempotency-Key are required"}
	}
	switch place := input.Place; {
	case place.Mode == "amend":
		return MythicalItemView{}, invalidTodoPlace("Amend arrives with T-STK-06")
	case place.Mode == "before" && (place.N == nil || *place.N <= 0):
		return MythicalItemView{}, invalidTodoPlace("Before needs the TODO it goes before")
	case place.Mode == "before":
	case place.N != nil || place.Mode != "" && place.Mode != "append":
		return MythicalItemView{}, invalidTodoPlace("place must be {mode, n?}")
	default:
		input.Place = MythicalTodoPlace{Mode: "append"}
	}
	if input.Acceptance == nil {
		input.Acceptance = []string{}
	}
	if input.Issue == nil && (input.IssueDigest != "" || input.Fixes != nil) ||
		input.Issue != nil && (*input.Issue <= 0 || !mythicalDigestPattern.MatchString(input.IssueDigest)) {
		return MythicalItemView{}, &TodoControlError{400, "invalid_todo", "user", "issue, issue_digest and fixes go together"}
	}
	if input.Issue != nil && input.Fixes == nil {
		fixes := true
		input.Fixes = &fixes
	}
	canonical, _ := json.Marshal(input)
	// Make TODO reads the issue once, before the transaction and only for a
	// new request: a replay answers the TODO it filed, whatever the issue
	// says now.
	var issue *db.MythicalTodoIssue
	link := ""
	if input.Issue != nil {
		if _, err = s.queries().GetMythicalRequest(ctx, repositoryID, info.SessionHash, input.Request); errors.Is(err, pgx.ErrNoRows) {
			if issue, err = s.readTodoIssue(ctx, repositoryID, decision.Role, *input.Issue, input.IssueDigest); err != nil {
				return MythicalItemView{}, err
			}
			issue.Fixes = *input.Fixes
			if repository, owner, err := s.repository(ctx, repositoryID); err == nil && s.origin() != "" {
				link = s.origin() + "/" + owner + "/" + repository.Name
			}
		} else if err != nil {
			return MythicalItemView{}, err
		}
	}
	var item db.MythicalItem
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repositoryID); err != nil {
			return err
		}
		existing, err := q.GetMythicalRequest(ctx, repositoryID, info.SessionHash, input.Request)
		if err == nil {
			// The same key may have approved a merge instead: a different request.
			held := mythicalChecksOf(existing)
			if held.FiledRequest != input.Request || held.CreationSession != info.SessionHash || held.CreationPayload != string(canonical) {
				return &TodoControlError{409, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}
			}
			item = existing
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if input.Issue != nil && issue == nil {
			return &TodoControlError{409, "idempotency_mismatch", "conflict", "Commit the Draft again"}
		}
		stack, err := q.GetMythicalStack(ctx, repositoryID)
		if err != nil || stack.State != "active" {
			return &TodoControlError{503, "stack_unavailable", "infra", "Repository stack is not ready"}
		}
		// Before Tn takes Tn's place: Tn must still be on the stack and not
		// merging (spec §10.2.2).
		var before db.MythicalItem
		if input.Place.Mode == "before" {
			order, err := q.LockMythicalStackOrder(ctx, repositoryID)
			if err != nil {
				return err
			}
			at := slices.IndexFunc(order, func(item db.MythicalItem) bool { return item.Number.Int64 == *input.Place.N })
			if at < 0 {
				return invalidTodoPlace(fmt.Sprintf("T%d is not on the stack", *input.Place.N))
			}
			if before = order[at]; mythicalMergeFenced(before) {
				return &TodoControlError{409, "merging", "conflict", fmt.Sprintf("T%d is merging", *input.Place.N)}
			}
		}
		first := map[string]any{"text": input.Prompt, "acceptance": input.Acceptance, "by": map[string]any{"kind": "person", "login": person.Username, "name": person.DisplayName, "avatar_url": todoAvatar(person), "color_index": 0}, "at": s.now().UTC().Format(time.RFC3339Nano)}
		if issue != nil {
			first["reason"], first["issue_digest"] = "from-issue", issue.Digest
		}
		revision, _ := json.Marshal([]map[string]any{first})
		checks := mythicalChecks{Todo: true, FiledRequest: input.Request, CreationSession: info.SessionHash, CreationPayload: string(canonical)}
		item, err = q.InsertMythicalIssueTodo(ctx, repositoryID, userID, input.Title, input.Prompt, revision, checks.encode(), issue)
		if issue != nil && errors.Is(err, pgx.ErrNoRows) {
			held, _ := q.GetActiveMythicalItemByIssue(ctx, repositoryID, issue.Number)
			return &TodoControlError{409, "issue_has_todo", "conflict", fmt.Sprintf("Issue #%d already has T%d", issue.Number, held.Number.Int64)}
		}
		if err != nil {
			return err
		}
		if before.StackPosition.Valid {
			// Tn and every item after it move one place later. A new TODO has
			// no verified candidate, so no later item's prefix changes yet.
			if err := q.MakeMythicalPlace(ctx, repositoryID, before.StackPosition.Int64, item.ID); err != nil {
				return err
			}
			if item, err = q.PlaceMythicalItem(ctx, item.ID, before.StackPosition.Int64); err != nil {
				return err
			}
		}
		if issue != nil {
			committed := mythicalChecksOf(item)
			notice := mythicalCommittedNotice(item.Number.Int64, link)
			committed.Notice = &notice
			item.Checks = committed.encode()
			if item, err = q.SaveMythicalItem(ctx, item); err != nil {
				return err
			}
		}
		created := map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "attempt": item.Attempt, "from": "draft", "to": "queued", "actor": userID,
			"place": item.StackPosition.Int64}
		if before.Number.Valid {
			created["before"] = before.Number.Int64
		}
		if issue != nil {
			created["issue"] = issue.Number
		}
		fact, _ := json.Marshal(created)
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

var mythicalDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// mythicalCommittedKeyPrefix keys the notice a Make TODO owes its issue: the
// App's todo label and one comment per TODO, which a retry edits rather than
// repeats.
const mythicalCommittedKeyPrefix = "todo-committed:"

// mythicalCommittedNotice is that notice for TODO number: "Committed as Tn",
// linking the repository in Smithers when the install has an address.
func mythicalCommittedNotice(number int64, link string) mythicalNotice {
	body := fmt.Sprintf("Committed as T%d ↗", number)
	if link != "" {
		body = fmt.Sprintf("Committed as [T%d ↗](%s)", number, link)
	}
	return mythicalNotice{Key: mythicalCommittedKeyPrefix + strconv.FormatInt(number, 10), Body: body, Label: todoLabel}
}

// readTodoIssue is Make TODO's read of the issue a Draft names, as GitHub
// answers it now. The Draft carries the digest of the title and body its
// author read (mythicalIssueDigest); an issue changed since then is refused,
// so the TODO never keeps issue text nobody read (spec §10.2.1b). The read
// goes through the install's App as the stack's actor, as the issue card
// reads it: the person's own GitHub credential plays no part. A maintainer
// or the owner may make a TODO from an outsider's text, which marks the
// TODO outsider like a maintainer's label; a Member may not (§10.2.1).
func (s *MythicalService) readTodoIssue(ctx context.Context, repositoryID int64, role InstallRole, number int64, digest string) (*db.MythicalTodoIssue, error) {
	unavailable := &TodoControlError{503, "github_unavailable", "infra", fmt.Sprintf("Could not read issue #%d from GitHub", number)}
	if s.github == nil {
		return nil, unavailable
	}
	gh, err := s.stackGitHub(ctx, repositoryID)
	if err != nil {
		s.logger.Warn("mythical.todo_issue_unavailable", "repository_id", repositoryID, "issue", number, "error", err)
		return nil, unavailable
	}
	issue, err := s.github.Issue(ctx, gh, number)
	if err != nil {
		s.logger.Warn("mythical.todo_issue_unavailable", "repository_id", repositoryID, "issue", number, "error", err)
		return nil, unavailable
	}
	switch {
	case issue.Number != number || issue.PullRequest:
		return nil, &TodoControlError{400, "invalid_todo", "user", fmt.Sprintf("#%d is not an issue", number)}
	case !strings.EqualFold(issue.State, "open"):
		return nil, &TodoControlError{409, "issue_closed", "conflict", fmt.Sprintf("Issue #%d is closed", number)}
	case mythicalIssueDigest(issue) != digest:
		return nil, &TodoControlError{409, "issue_changed", "conflict", fmt.Sprintf("Issue #%d changed after the Draft was made. Make the TODO again.", number)}
	}
	byMaintainer, err := s.github.IssueTextByMaintainer(ctx, gh, issue)
	if err != nil {
		s.logger.Warn("mythical.todo_issue_unavailable", "repository_id", repositoryID, "issue", number, "error", err)
		return nil, unavailable
	}
	if !byMaintainer && role.rank() < InstallMaintainer.rank() {
		return nil, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only a maintainer can make a TODO from this issue"}
	}
	body := issue.Body
	if len(body) > mythicalPromptBytes {
		body = body[:mythicalPromptBytes]
	}
	return &db.MythicalTodoIssue{Number: number, Title: issue.Title, Body: body, URL: issue.URL, Digest: digest, Outsider: !byMaintainer}, nil
}

func todoOperationScope(item db.MythicalItem) jobs.Scope {
	return jobs.Scope{TenantID: strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "todo:" + uuidString(item.ID)}
}

// personGitHubID is the numeric id of the GitHub account the person signed
// in with (mythicalLinkedGitHub). A login is never trusted from the
// profile: it can be renamed.
func (s *MythicalService) personGitHubID(ctx context.Context, userID int64, act string) (int64, error) {
	accounts, err := s.queries().ListUserOAuthAccounts(ctx, userID)
	if err != nil {
		return 0, err
	}
	if id, ok := mythicalLinkedGitHub(accounts); ok {
		return id, nil
	}
	return 0, pkgerrors.Forbidden("connect your GitHub account to " + act)
}

// mythicalLinkedGitHub is the GitHub account id among a person's linked
// accounts: a "github" account, else the GitHub sign-in's historical
// "workos" row (resolveUserGitHubAccessToken's order).
func mythicalLinkedGitHub(accounts []db.OauthAccount) (int64, bool) {
	for _, provider := range []string{"github", "workos"} {
		for _, account := range accounts {
			if !strings.EqualFold(strings.TrimSpace(account.Provider), provider) {
				continue
			}
			if id, err := strconv.ParseInt(strings.TrimSpace(account.ProviderUserID), 10, 64); err == nil && id > 0 {
				return id, true
			}
		}
	}
	return 0, false
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
