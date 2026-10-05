package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// confirmTerminal is the owner's stage-1 terminal credential (token 77) on a
// branch, with Claude Code working in it.
func confirmTerminal(userID int64) context.Context {
	scopes := "read:repository,read:user,repo:1," + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "terminal", Branch: "5a1b0000-0000-4000-8000-0000000000b2",
		Profile: middleware.TerminalProfileS1, Session: "5e55-session"}), ",")
	return middleware.ContextWithAuthInfo(context.Background(), &middleware.AuthInfo{User: &db.User{ID: userID}, IsTokenAuth: true, TokenSystemIssued: true, TokenID: 77,
		RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes), ViaHint: "claude-code"})
}

func confirmCode(t *testing.T, err error) string {
	t.Helper()
	var control *TodoControlError
	if errors.As(err, &control) {
		return control.Code
	}
	var access *AccessError
	require.ErrorAs(t, err, &access)
	return access.Code
}

func (o *mythicalOrchestration) todoCount() int {
	o.t.Helper()
	var n int
	require.NoError(o.t, o.pool.QueryRow(context.Background(), `SELECT count(*) FROM mythical_items WHERE repository_id = $1`, o.repoID).Scan(&n))
	return n
}

// J6 3c (T-APP-04, spec §5.3.2a and §5.4): a terminal's TODO files nothing
// and waits as one pending confirmation for its member; the same request
// answers it again and another request under its key is refused; only its
// member presses it; Confirm files the TODO once, at the end of the stack,
// by Claude Code for the member; a second press files nothing more.
func TestConfirmationFilesTheTerminalTodoOnceForItsMember(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.fileTodo(session, "first")
	confirmations := NewApprovalsService(db.New(o.pool), WithConfirmedTodos(o.service))
	terminal := confirmTerminal(o.userID)
	ask := MythicalTodoInput{Title: "Follow-up", Prompt: "Add a farewell to t3.md", Request: "k-1"}

	receipt, err := confirmations.RequestConfirmation(terminal, o.repoID, o.userID, ask)
	require.NoError(t, err)
	require.Equal(t, "pending", receipt.State)
	again, err := confirmations.RequestConfirmation(terminal, o.repoID, o.userID, ask)
	require.NoError(t, err)
	require.Equal(t, receipt, again)
	other := ask
	other.Prompt = "Something else"
	_, err = confirmations.RequestConfirmation(terminal, o.repoID, o.userID, other)
	require.Equal(t, "idempotency_mismatch", confirmCode(t, err))
	before := ask
	before.Request, before.Place = "k-2", MythicalTodoPlace{Mode: "before", N: new(int64)}
	_, err = confirmations.RequestConfirmation(terminal, o.repoID, o.userID, before)
	require.Equal(t, "permission", confirmCode(t, err))
	_, err = confirmations.RequestConfirmation(session, o.repoID, o.userID, MythicalTodoInput{Title: "Mine", Prompt: "x", Request: "k-3"})
	require.Equal(t, "permission", confirmCode(t, err), "a browser session files directly; it never asks")
	_, err = confirmations.RequestConfirmation(terminal, o.repoID, o.userID, MythicalTodoInput{Title: "Nul\x00", Prompt: "x", Request: "k-4"})
	require.Equal(t, "invalid_todo", confirmCode(t, err))
	_, err = confirmations.RequestConfirmation(terminal, o.repoID, o.userID, MythicalTodoInput{Title: "No key", Prompt: "x"})
	require.Equal(t, "idempotency_key_required", confirmCode(t, err))
	require.Equal(t, 1, o.todoCount())

	list, err := confirmations.Confirmations(session, o.repoID, o.userID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	card, err := json.Marshal(list[0].Card)
	require.NoError(t, err)
	require.JSONEq(t, `{"kind":"one_click","action":{"tag":"todo.new","verb":"Commit"},"summary":"Commit Follow-up","subject":{"kind":"todo","ref":"Follow-up"},
		"text":"Add a farewell to t3.md","asked_by":{"kind":"agent","id":"agent-session-5e55-session","agent":"claude-code","session_id":"5e55-session",
		"avatar_url":"`+todoAvatar(db.User{})+`","for_member":{"login":"smithers-canary","name":"smithers-canary","avatar_url":"`+todoAvatar(db.User{})+`"},"color_index":0}}`, string(card))
	require.Equal(t, []ConfirmationReceipt{receipt}, ConfirmationReceipts(list, 77))
	require.Empty(t, ConfirmationReceipts(list, 78), "another credential reads none of them")

	ben, _ := o.person("ben")
	_, err = confirmations.ApproveConfirmation(session, o.repoID, ben, receipt.Confirmation)
	require.Equal(t, "permission", confirmCode(t, err))
	_, err = confirmations.DenyConfirmation(session, o.repoID, ben, receipt.Confirmation)
	require.Equal(t, "permission", confirmCode(t, err))
	_, err = confirmations.ApproveConfirmation(session, o.repoID, o.userID, "not-a-uuid")
	require.Equal(t, "confirmation_not_found", confirmCode(t, err))
	require.Equal(t, 1, o.todoCount())

	first, err := confirmations.ApproveConfirmation(session, o.repoID, o.userID, receipt.Confirmation)
	require.NoError(t, err)
	require.Equal(t, "approved", first.State)
	require.Equal(t, int64(2), first.Todo)
	require.Equal(t, "Committed T2", first.Card["receipt"].(map[string]any)["text"])
	second, err := confirmations.ApproveConfirmation(session, o.repoID, o.userID, receipt.Confirmation)
	require.NoError(t, err)
	require.Equal(t, first.Todo, second.Todo)
	require.Equal(t, 2, o.todoCount(), "the second press files nothing")
	_, err = confirmations.DenyConfirmation(session, o.repoID, o.userID, receipt.Confirmation)
	require.Equal(t, "confirmation_decided", confirmCode(t, err))
	replayed, err := confirmations.RequestConfirmation(terminal, o.repoID, o.userID, ask)
	require.NoError(t, err)
	require.Equal(t, ConfirmationReceipt{Confirmation: receipt.Confirmation, State: "approved"}, replayed, "the agent's retry learns it was confirmed and asks nothing new")
	var rows int
	require.NoError(t, o.pool.QueryRow(context.Background(), `SELECT count(*) FROM approvals`).Scan(&rows))
	require.Equal(t, 1, rows)

	item, err := db.New(o.pool).GetMythicalItemByNumber(context.Background(), o.repoID, first.Todo)
	require.NoError(t, err)
	require.Equal(t, []int64{1, 2}, o.stackOrder())
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(item.Revisions, &revisions))
	require.Equal(t, "Add a farewell to t3.md", revisions[0]["text"])
	by := revisions[0]["by"].(map[string]any)
	require.Equal(t, "claude-code", by["agent"])
	require.Equal(t, "5e55-session", by["session_id"])
	created := o.facts(item, "todo.created")
	require.Len(t, created, 1)
	require.Equal(t, map[string]any{"person": "smithers-canary", "via": "claude-code", "session": "5e55-session"}, created[0]["by"])
	require.Equal(t, receipt.Confirmation, created[0]["confirmation"])
}

// A Cancel runs nothing and settles the confirmation; an expired one cannot
// be pressed and reads as expired; without a TODO filer nothing is recorded.
func TestConfirmationCancelExpiryAndUnavailable(t *testing.T) {
	o, session := newTodoAdmission(t)
	confirmations := NewApprovalsService(db.New(o.pool), WithConfirmedTodos(o.service))
	terminal := confirmTerminal(o.userID)

	cancelled, err := confirmations.RequestConfirmation(terminal, o.repoID, o.userID, MythicalTodoInput{Title: "One", Prompt: "one", Request: "k-1"})
	require.NoError(t, err)
	denied, err := confirmations.DenyConfirmation(session, o.repoID, o.userID, cancelled.Confirmation)
	require.NoError(t, err)
	require.Equal(t, "rejected", denied.State)
	require.Equal(t, "cancelled", denied.Card["receipt"].(map[string]any)["result"])
	again, err := confirmations.DenyConfirmation(session, o.repoID, o.userID, cancelled.Confirmation)
	require.NoError(t, err)
	require.Equal(t, "rejected", again.State)
	_, err = confirmations.ApproveConfirmation(session, o.repoID, o.userID, cancelled.Confirmation)
	require.Equal(t, "confirmation_decided", confirmCode(t, err))

	expired, err := confirmations.RequestConfirmation(terminal, o.repoID, o.userID, MythicalTodoInput{Title: "Two", Prompt: "two", Request: "k-2"})
	require.NoError(t, err)
	_, err = o.pool.Exec(context.Background(), `UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`, expired.Confirmation)
	require.NoError(t, err)
	_, err = confirmations.ApproveConfirmation(session, o.repoID, o.userID, expired.Confirmation)
	require.Equal(t, "confirmation_expired", confirmCode(t, err))
	replay, err := confirmations.RequestConfirmation(terminal, o.repoID, o.userID, MythicalTodoInput{Title: "Two", Prompt: "two", Request: "k-2"})
	require.NoError(t, err)
	require.Equal(t, ConfirmationReceipt{Confirmation: expired.Confirmation, State: "expired"}, replay)
	list, err := confirmations.Confirmations(session, o.repoID, o.userID)
	require.NoError(t, err)
	require.Equal(t, []string{"expired", "rejected"}, []string{list[0].State, list[1].State})
	require.Equal(t, "expired", list[0].Card["receipt"].(map[string]any)["result"])
	require.Equal(t, 0, o.todoCount())

	var rows int
	require.NoError(t, o.pool.QueryRow(context.Background(), `SELECT count(*) FROM approvals`).Scan(&rows))
	_, err = NewApprovalsService(db.New(o.pool)).RequestConfirmation(terminal, o.repoID, o.userID, MythicalTodoInput{Title: "Three", Prompt: "three", Request: "k-3"})
	require.Equal(t, "confirmation_unavailable", confirmCode(t, err))
	_, err = (*ApprovalsService)(nil).Confirmations(session, o.repoID, o.userID)
	require.Equal(t, "confirmation_unavailable", confirmCode(t, err))
	var after int
	require.NoError(t, o.pool.QueryRow(context.Background(), `SELECT count(*) FROM approvals`).Scan(&after))
	require.Equal(t, rows, after)
}
