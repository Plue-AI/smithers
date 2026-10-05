package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// todoPress is one Stop or Resume a person pressed: its Idempotency-Key, who
// and when. The same key again answers the same receipt.
type todoPress struct {
	Request string    `json:"request"`
	By      string    `json:"by"`
	At      time.Time `json:"at"`
}

// stopTodo is Stop on a working TODO (spec §4.1 working → paused, §10.7.1).
// Under the stack's row lock it applies the control guard (a run executing,
// no question or approval open, not already paused), cancels the attempt's
// runs in the same transaction and sets paused_at, so the card shows Paused
// and the stack takes no step for the TODO until Resume. The TODO keeps its
// lane, its working copy and every steer; a merge on GitHub still settles it.
// The same Idempotency-Key again answers the same receipt.
//
// The spec's Stop parks the TODO's one run in a durable pause wait and
// Resume continues it from its last finished step; that needs the todo
// composition's pause boundary (T-FLW-11). Until then the run is cancelled
// and Resume runs the same attempt again (resumeTodo).
func (s *MythicalService) stopTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	return s.pressTodo(ctx, number, input, "stop a TODO", "todo.stopped", func(ctx context.Context, tx pgx.Tx, stack db.MythicalStack, item db.MythicalItem, press todoPress) (db.MythicalItem, error) {
		if err := s.cancelAttempt(ctx, tx, stack, item); err != nil {
			return db.MythicalItem{}, err
		}
		next := item
		checks := mythicalChecksOf(item)
		checks.Stops = append(checks.Stops, press)
		next.Checks = checks.encode()
		next.PausedAt = pgtype.Timestamptz{Time: press.At, Valid: true}
		return next, nil
	})
}

// pressTodo runs one person's Stop or Resume of TODO n under the stack's row
// lock: the press's Idempotency-Key answers the same receipt again, the
// control guard reads the item's facts, and apply's item is saved with its
// fact (event) before the stack is woken.
func (s *MythicalService) pressTodo(ctx context.Context, number int64, input TodoControlInput, action, event string,
	apply func(context.Context, pgx.Tx, db.MythicalStack, db.MythicalItem, todoPress) (db.MythicalItem, error)) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if err := middleware.RequirePerson(ctx, action); err != nil {
		return TodoControlReceipt{}, &TodoControlError{http.StatusForbidden, "permission", "permission", "Only a person can " + action}
	}
	person, err := s.queries().GetUserByID(ctx, input.Actor)
	if err != nil {
		return TodoControlReceipt{}, err
	}
	var receipt TodoControlReceipt
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
			checks := mythicalChecksOf(item)
			pressed := checks.Stops
			if input.Op == "resume" {
				pressed = checks.Resumes
			}
			for _, done := range pressed {
				if input.Request != "" && done.Request == input.Request {
					receipt = TodoControlReceipt{State: "accepted"}
					return nil
				}
			}
			if err := todoControlGuard(item, input, todoFactsOf(item)); err != nil {
				return err
			}
			if len(item.PendingOp) > 0 {
				return todoControlConflict("A GitHub write on this TODO is settling; press it again in a moment")
			}
			next, err := apply(ctx, tx, stack, item, todoPress{Request: input.Request, By: person.Username, At: s.now().UTC()})
			if err != nil {
				return err
			}
			saved, err := q.SaveMythicalItem(ctx, next)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			fact, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "attempt": item.Attempt,
				"actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username}, "from": todoState(item), "to": todoState(saved)})
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), event, todoState(saved), fact); err != nil {
				return err
			}
			if stack.RepositoryID == input.Repository {
				s.itemChanged(ctx, q, stack, saved.ID)
			}
			receipt = TodoControlReceipt{State: "accepted"}
			return nil
		}
		return &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is busy; press it again"}
	})
	return receipt, err
}

// todoFactsOf reads the control guard's facts from the item (§4.1.0a): a run
// executing (its latest launch has no outcome, or its head's review no
// verdict), its pause, and the kinds of its open waits.
func todoFactsOf(item db.MythicalItem) todoControlFacts {
	facts := todoControlFacts{Executing: mythicalRunInFlight(item), Paused: item.PausedAt.Valid}
	for _, wait := range todoOpenWaits(item) {
		facts.Waits = append(facts.Waits, wait.Kind)
	}
	return facts
}
