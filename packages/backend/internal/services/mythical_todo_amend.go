package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// TodoAmendInput is Amend Tn (PATCH /api/todos/{n}): the follow-up prompt
// and acceptance of the same TODO. Repository, Actor and Request are set
// only by the route, from the request it authorized: the install's
// repository, the person and the request's Idempotency-Key.
type TodoAmendInput struct {
	Prompt     string   `json:"prompt"`
	Acceptance []string `json:"acceptance,omitempty"`
	Repository int64    `json:"-"`
	Actor      int64    `json:"-"`
	Request    string   `json:"-"`
}

// TodoAmendReceipt is a recorded amendment: TODO n's revision rev (revision
// 1 is the TODO as filed, so an amendment's rev is 2 or more and the card
// shows it as "+rev-1").
type TodoAmendReceipt struct {
	State string `json:"state"`
	N     int64  `json:"n"`
	Rev   int    `json:"rev"`
}

// todoAmendRequestBytes bounds an amendment's Idempotency-Key, as FileTodo
// bounds a filing's.
const todoAmendRequestBytes = 256

func invalidAmendment(message string) error {
	return &TodoControlError{http.StatusBadRequest, "invalid_amendment", "user", message}
}

// validate admits a prompt with text and acceptance lines with text, all
// valid UTF-8, within mythicalPromptBytes as the steer renders them
// (todoAmendmentSteer, less its revision header), so one amendment always
// fits a steer's feedback bound (todoFeedbackBytes).
func (input TodoAmendInput) validate() error {
	if strings.TrimSpace(input.Prompt) == "" || !utf8.ValidString(input.Prompt) {
		return invalidAmendment("An amendment needs a prompt")
	}
	size := len(input.Prompt)
	if len(input.Acceptance) > 0 {
		size += len(todoAcceptanceHeading)
	}
	for _, line := range input.Acceptance {
		if strings.TrimSpace(line) == "" || !utf8.ValidString(line) {
			return invalidAmendment("Each acceptance line needs text")
		}
		size += len(todoAcceptanceLine) + len(line)
	}
	if size > mythicalPromptBytes {
		return invalidAmendment(fmt.Sprintf("An amendment is at most %d bytes", mythicalPromptBytes))
	}
	return nil
}

// AmendTodo is Amend Tn (spec §10.2.2, §10.7.3; mvp.md J7.1): under the
// stack's row lock it appends revision n+1 {n, reason amend, text,
// acceptance, by, at} to the TODO's revisions and delivers it to the TODO's
// coding agent as a steer, as Steer does (placeTodoSteer): sent at once to a
// working attempt's live run, which takes it at its next feedback boundary
// and plans again with it; held for the next attempt while the TODO is
// queued, for the run to attach while it starts, and for Resume while it is
// paused; past its coding run (in review) the attempt's runs are cancelled
// and the next attempt starts with it. A failed TODO is retried with it. No
// TODO, number, branch or pull request is made. The run's prompt stays
// revision 1 (todoPrompt); later revisions reach it only as steers
// (§10.4.2).
//
// The same Idempotency-Key with the same amendment answers the same receipt
// and sends nothing again; with another amendment it is 409. A merging TODO
// is 409 merging and a merged or dropped one 409 todo_closed, before any
// revision, fact or signal. Only a person in their browser amends: a
// delegated credential's Amend waits for its person's Confirm in the app,
// which the install does not serve yet (T-APP-04).
func (s *MythicalService) AmendTodo(ctx context.Context, number int64, input TodoAmendInput) (TodoAmendReceipt, error) {
	if number <= 0 {
		return TodoAmendReceipt{}, &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number"}
	}
	if err := input.validate(); err != nil {
		return TodoAmendReceipt{}, err
	}
	if input.Request == "" || len(input.Request) > todoAmendRequestBytes {
		return TodoAmendReceipt{}, &TodoControlError{http.StatusBadRequest, "idempotency_key_required", "user", "Idempotency-Key is required"}
	}
	if s == nil || s.store == nil {
		return TodoAmendReceipt{}, todoControlUnavailable()
	}
	signaler, _ := s.launcher.(mythicalSignaler)
	if signaler == nil {
		return TodoAmendReceipt{}, todoControlUnavailable()
	}
	info := middleware.AuthInfoFromContext(ctx)
	if _, delegated := info.Delegation(); delegated {
		return TodoAmendReceipt{}, &TodoControlError{http.StatusServiceUnavailable, "confirmation_unavailable", "infra", "Confirm in the app"}
	}
	if err := middleware.RequirePerson(ctx, "amend a TODO"); err != nil {
		return TodoAmendReceipt{}, &TodoControlError{http.StatusForbidden, "permission", "permission", "Only a person amends a TODO"}
	}
	person, err := s.queries().GetUserByID(ctx, input.Actor)
	if err != nil {
		return TodoAmendReceipt{}, err
	}
	by := todoActor(ctx, person)
	if input.Acceptance == nil {
		input.Acceptance = []string{}
	}
	key := todoAmendKey(input.Request)
	var receipt TodoAmendReceipt
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, input.Repository); err != nil {
			return err
		}
		q := db.New(tx)
		stack, err := q.GetMythicalStack(ctx, input.Repository)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		for range 3 {
			item, err := q.GetMythicalItemByNumber(ctx, input.Repository, number)
			if errors.Is(err, pgx.ErrNoRows) {
				return &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
			}
			if err != nil {
				return err
			}
			if done, ok := todoAmended(item, key); ok {
				if done.Text != todoAmendmentSteer(int(done.Revision), input.Prompt, input.Acceptance) {
					return &TodoControlError{http.StatusConflict, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different amendment"}
				}
				receipt = TodoAmendReceipt{State: "accepted", N: number, Rev: int(done.Revision)}
				return nil
			}
			if err := todoAmendGuard(item); err != nil {
				return err
			}
			var revisions []json.RawMessage
			if len(item.Revisions) > 0 {
				if err := json.Unmarshal(item.Revisions, &revisions); err != nil {
					return fmt.Errorf("TODO %d revisions: %w", number, err)
				}
			}
			now, rev := s.now().UTC(), len(revisions)+1
			steer := todoSteer{Text: todoAmendmentSteer(rev, input.Prompt, input.Acceptance), By: by, At: now, Request: key, Revision: int32(rev)}
			var next db.MythicalItem
			delivery := "retry"
			if item.State == "blocked" {
				// A failed TODO starts attempt n+1 with the amendment first
				// (spec §10.7.3), as Retry with a steer does.
				if len(item.PendingOp) > 0 {
					return todoControlConflict("A GitHub write on this TODO is settling; amend it again in a moment")
				}
				if next, err = mythicalRetried(ctx, item); err != nil {
					return err
				}
				steer.Attempt = item.Attempt + 1
				retried := mythicalChecksOf(next)
				retried.Steers = append(retried.Steers, steer)
				next.Checks = retried.encode()
			} else if next, steer, delivery, err = s.placeTodoSteer(ctx, tx, stack, item, steer, "amend it again"); err != nil {
				return err
			}
			revision, _ := json.Marshal(map[string]any{"n": rev, "reason": "amend", "text": input.Prompt, "acceptance": input.Acceptance,
				"by": by, "at": now.Format(time.RFC3339Nano)})
			next.Revisions, _ = json.Marshal(append(revisions, revision))
			saved, err := q.SaveMythicalItem(ctx, next)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			fact, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "rev": rev, "attempt": steer.Attempt, "delivery": delivery,
				"actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username}, "by": todoActorRef(ctx, person), "from": todoState(item), "to": todoState(saved)})
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.amended", todoState(saved), fact); err != nil {
				return err
			}
			if steer.Run != "" {
				scope, target := todoRunTarget(stack, saved)
				if _, err := signaler.SignalInTx(ctx, tx, todoSteerSignal(uuidString(saved.ID), scope, target, "coding/request", steer.Run, steer)); err != nil {
					return err
				}
			}
			if stack.RepositoryID == input.Repository {
				s.itemChanged(ctx, q, stack, saved.ID)
			}
			receipt = TodoAmendReceipt{State: "accepted", N: number, Rev: rev}
			return nil
		}
		return &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is busy; amend it again"}
	})
	return receipt, err
}

// todoAmendGuard refuses an amendment the TODO cannot take: a merge in
// flight (§10.6.2b), a settled TODO, and an item with no prompt of its own
// (a legacy issue item runs from the issue's approved text).
func todoAmendGuard(item db.MythicalItem) error {
	if mythicalMergeFenced(item) {
		return &TodoControlError{http.StatusConflict, "merging", "conflict", "TODO is merging"}
	}
	switch item.State {
	case "landed", "cancelled", "rejected", "declined":
		return &TodoControlError{http.StatusConflict, "todo_closed", "conflict", "TODO is closed"}
	}
	if !mythicalTodo(item) {
		return todoControlConflict("This item has no prompt to amend")
	}
	return nil
}

// todoAmendKey is an amendment's steer identity: its Idempotency-Key, kept
// apart from a steer press's own keys.
func todoAmendKey(request string) string { return "amend:" + request }

// todoAmended is the steer an earlier amendment with key filed.
func todoAmended(item db.MythicalItem, key string) (todoSteer, bool) {
	for _, steer := range mythicalChecksOf(item).Steers {
		if steer.Revision > 0 && steer.Request == key {
			return steer, true
		}
	}
	return todoSteer{}, false
}

// todoAmendmentSteer is revision rev as the coding agent receives it, a
// steer: the revision's text, then its acceptance lines (§10.4.2).
func todoAmendmentSteer(rev int, text string, acceptance []string) string {
	var b strings.Builder
	b.WriteString("Amendment (revision " + strconv.Itoa(rev) + "):\n" + text)
	if len(acceptance) > 0 {
		b.WriteString(todoAcceptanceHeading)
		for _, line := range acceptance {
			b.WriteString(todoAcceptanceLine + line)
		}
	}
	return b.String()
}

// The acceptance part of an amendment's steer: its heading, then one
// bulleted line each.
const (
	todoAcceptanceHeading = "\n\nAcceptance:"
	todoAcceptanceLine    = "\n- "
)
