package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// todoSteer is one steer a person gave a TODO (spec §10.7.3): its text, its
// author as a TodoCard actor, when, and the attempt it is held for. It reaches
// that attempt and every later one as the run's first input (todoFeedback);
// the card lists every steer in order (steers[]).
type todoSteer struct {
	Attribution map[string]string `json:"attribution,omitempty"`
	Text        string            `json:"text"`
	By          json.RawMessage   `json:"by"`
	At          time.Time         `json:"at"`
	Attempt     int32             `json:"attempt"`
	// These fields are absent on historical Retry feedback. Request is scoped
	// to Credential; ID is the stable event/message identity for live or held input.
	ID       string `json:"id,omitempty"`
	Request  string `json:"request,omitempty"`
	Author   int64  `json:"author,omitempty"`
	Revision int    `json:"revision,omitempty"`
	// Credential scopes replay to the authenticated session or bound token.
	// Historical feedback without this identity remains readable, but cannot
	// authorize a replay using only its author's member id.
	Credential string `json:"credential,omitempty"`
	// ReleasePending records that a held input still needs its working-state
	// release, including invalidating a fenced candidate. Clearing it does not mean
	// the runtime accepted the message or the model consumed it.
	ReleasePending bool `json:"release_pending,omitempty"`
}

// todoRetry is one Retry a person pressed: its Idempotency-Key, who and when,
// and the attempt it starts. The same key again answers this receipt and
// starts nothing more.
type todoRetry struct {
	Request    string    `json:"request"`
	Credential string    `json:"credential,omitempty"`
	By         string    `json:"by"`
	At         time.Time `json:"at"`
	Attempt    int32     `json:"attempt"`
}

// todoFeedbackBytes bounds the steers an attempt receives as its coding
// request's feedback (flows/coding/schema.ts RequestInput.feedback: 32,768
// UTF-16 units, never fewer than this many UTF-8 bytes).
const todoFeedbackBytes = 32 << 10

// retryTodo is Retry on a failed TODO (spec §4.1 failed → queued, §10.7.1).
// Under the stack's row lock it applies the control guard, then retryItem's
// reset (mythicalRetried): the item queues again for a fresh set of plans and
// its next launch is attempt n+1 of the same pinned flow, so every earlier
// attempt and its evidence stay as they were. A steer is held for attempt
// n+1 and reaches it as its first input. The same Idempotency-Key again is
// the same retry; another press once the TODO left failed is 409. The stack
// takes the launch at once (itemChanged), not at its sweep.
func (s *MythicalService) retryTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if err := middleware.RequirePerson(ctx, "retry a TODO"); err != nil {
		return TodoControlReceipt{}, &TodoControlError{http.StatusForbidden, "permission", "permission", "Only a person retries a TODO"}
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "todo.retry", input)
		if err != nil {
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
			if prior, found, err := todoControlReplay(ctx, tx, q, item, input, credential, "todo.retried"); found || err != nil {
				receipt = prior
				return err
			}
			for _, done := range mythicalChecksOf(item).Retries {
				if done.Request == input.Request && done.Credential == "" {
					return todoControlUnavailable()
				}
			}
			if err := todoControlGuard(item, input, todoControlFacts{}); err != nil {
				return err
			}
			if len(item.PendingOp) > 0 {
				return todoControlConflict("A GitHub write on this TODO is settling; retry in a moment")
			}
			next, err := mythicalRetried(ctx, item)
			if err != nil {
				return err
			}
			now, attempt := s.now().UTC(), item.Attempt+1
			retried := mythicalChecksOf(next)
			if input.Steer != nil {
				retried.Steers = append(retried.Steers, todoSteer{Text: *input.Steer, By: todoActor(ctx, person), At: now, Attempt: attempt})
			}
			retried.Retries = append(retried.Retries, todoRetry{Request: input.Request, Credential: credential, By: person.Username, At: now, Attempt: attempt})
			next.Checks = retried.encode()
			saved, err := q.SaveMythicalItem(ctx, next)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			receipt = TodoControlReceipt{State: "accepted", Attempt: attempt}
			if err := recordTodoControl(ctx, tx, saved, input, credential, "todo.retried", receipt, map[string]any{
				"item": uuidString(saved.ID), "n": saved.Number.Int64, "attempt": attempt, "steer": input.Steer != nil,
				"actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username}, "from": todoState(item), "to": todoState(saved),
			}); err != nil {
				return err
			}
			if stack, err := q.GetMythicalStack(ctx, input.Repository); err == nil {
				s.itemChanged(ctx, q, stack, saved.ID)
			}
			return nil
		}
		return &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is busy; retry again"}
	})
	return receipt, err
}

// todoFeedback is what attempt receives as its first input: every steer held
// for it or an earlier attempt, in order, the latest kept whole when they
// exceed todoFeedbackBytes.
func todoFeedback(item db.MythicalItem, attempt int32) string {
	var held []string
	for _, steer := range mythicalChecksOf(item).Steers {
		if steer.Attempt <= attempt {
			held = append(held, steer.Text)
		}
	}
	feedback := strings.Join(held, "\n\n")
	if len(feedback) > todoFeedbackBytes {
		feedback = feedback[len(feedback)-todoFeedbackBytes:]
		for len(feedback) > 0 && !utf8.RuneStart(feedback[0]) {
			feedback = feedback[1:]
		}
	}
	return feedback
}

// todoSteers is the card's steers[] {text, by, at}, in the order given.
func todoSteers(item db.MythicalItem) []any {
	steers := []any{}
	for _, steer := range mythicalChecksOf(item).Steers {
		steers = append(steers, map[string]any{"text": steer.Text, "by": steer.By, "at": steer.At.UTC().Format(time.RFC3339Nano)})
	}
	return steers
}
