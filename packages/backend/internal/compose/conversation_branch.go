package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The source service owns transaction/state projection; composition supplies
// the existing journal writer without a services/chat import cycle.
func publishConversationSubject(ctx context.Context, tx pgx.Tx, item db.MythicalItem, event jobs.Event, card map[string]any) error {
	owner, err := db.New(tx).GetSelfHostOwner(ctx)
	if err != nil {
		return err
	}
	author := owner.ID
	if item.OwnerID.Valid {
		author = item.OwnerID.Int64
	}
	state, _ := card["state"].(string)
	var attention bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mythical_stacks s, jsonb_array_elements(s.attention) a WHERE s.repository_id=$1 AND a->>'kind' IN ('order','force_push') AND (a->>'settled_at') IS NULL)`, item.RepositoryID).Scan(&attention); err != nil {
		return err
	}
	subject := chat.SubjectEntry{Number: item.Number.Int64, Title: item.Title.String, State: state, Tone: chat.SubjectTone(state, attention)}
	for _, branch := range []string{"main", item.WorkspaceID} {
		if branch == "" || branch == "main" && item.WorkspaceID == "main" {
			continue
		}
		id := fmt.Sprintf("todo:%d", subject.Number)
		entryCard, err := json.Marshal(map[string]any{"id": id, "kind": "todo", "title": subject.Title, "payload": map[string]any{"model": card, "n": subject.Number, "requests": []any{}}, "status": "active", "createdAt": event.RecordedAt.UnixMilli(), "ordinal": event.RepositorySequence})
		if err != nil {
			return err
		}
		if err := chat.PublishSubjectTx(ctx, tx, chat.Scope{RepositoryID: item.RepositoryID, UserID: author, Owner: fmt.Sprint(author)}, branch, event.EventID, subject, entryCard); err != nil {
			return err
		}
	}
	return nil
}

// The installed repository's main conversation exists before any machine.
// Every other branch uses the same authorized workspace binding as presence
// and files; reading it neither wakes a machine nor executes repository code.
func conversationBranchResolver(branches *services.WorkspaceService) func(context.Context, chat.Scope, string) (string, error) {
	return func(ctx context.Context, scope chat.Scope, branch string) (string, error) {
		if branch == "main" {
			return "main", nil
		}
		row, err := branches.PresenceBranch(ctx, branch, scope.RepositoryID, scope.UserID)
		if err != nil {
			return "", conversationRefusal(branch, err)
		}
		if row.TargetBookmark == "main" {
			return "main", nil
		}
		return row.ID, nil
	}
}

// conversationRefused is a conversation the person cannot address: no branch
// has that name, or they cannot read it. TODO-family doors (todoRouteError)
// answer its 4xx and cause instead of "unavailable"; the chat routes still
// write the branch store's own refusal.
type conversationRefused struct {
	*services.TodoControlError
	store *pkgerrors.APIError
}

func (e *conversationRefused) Unwrap() []error { return []error{e.TodoControlError, e.store} }

// conversationRefusal types the branch store's 4xx refusals. Anything else
// (a database or service fault) is left as it is.
func conversationRefusal(branch string, err error) error {
	var refusal *pkgerrors.APIError
	if !errors.As(err, &refusal) || refusal.Status < 400 || refusal.Status >= 500 {
		return err
	}
	typed := &services.TodoControlError{Status: refusal.Status, Code: "conversation_refused", Class: "user", Message: refusal.Message}
	switch refusal.Status {
	case http.StatusNotFound:
		typed.Code, typed.Message = "conversation_not_found", "Conversation "+strconv.Quote(branch)+" not found"
	case http.StatusUnauthorized, http.StatusForbidden:
		typed.Class = "permission"
	}
	return &conversationRefused{TodoControlError: typed, store: refusal}
}

// The live member topic and the install composition use the same persisted,
// credential-bound reader; resolving a view never launches a machine.
func conversationLiveViewState(queries *db.Queries, store *chat.Store, branches *services.WorkspaceService) func(context.Context, int64, string) (json.RawMessage, error) {
	resolveBranch := conversationBranchResolver(branches)
	return func(ctx context.Context, member int64, branch string) (json.RawMessage, error) {
		repository, _, err := installRepository(ctx, queries)
		if err != nil {
			return nil, err
		}
		canonical, err := resolveBranch(ctx, chat.Scope{RepositoryID: repository, UserID: member}, branch)
		if err != nil {
			return nil, err
		}
		return store.ReadMemberViewState(ctx, member, canonical)
	}
}
