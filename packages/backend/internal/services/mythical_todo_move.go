package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// todoMoveNamespace identifies historical unscoped move receipts. They remain
// readable, but cannot authorize replay for an unknown credential.
var todoMoveNamespace = uuid.MustParse("5b0d6a3e-8f43-4c1e-9d7a-2e61c4b8f0a9")

// moveTodo is Move up or Move down on TODO n (spec §6.3, mvp.md §4.2
// Merging): n trades places with the nearest item still on the stack above
// or below it, so the stack admits, builds on and merges in the new order. It
// holds FileTodo's placement lock (pg_advisory_xact_lock on the repository),
// then the stack row, then the stack's item rows. A merging TODO or neighbor
// is 409 merging; the first item moving up or the last moving down is 409.
// Each later item whose prefix the move changed loses its verification in
// the same transaction (reorderPrefixes). The same Idempotency-Key again
// answers the move it made; one todo.moved fact records each move.
func (s *MythicalService) moveTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if err := middleware.RequirePerson(ctx, "move a TODO"); err != nil {
		return TodoControlReceipt{}, &TodoControlError{http.StatusForbidden, "permission", "permission", "Only a person moves a TODO"}
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "stack.move", input)
		if err != nil {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, input.Repository)
		if err != nil {
			return err
		}
		item, err := q.GetMythicalItemByNumber(ctx, input.Repository, number)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
		}
		if err != nil {
			return err
		}
		if prior, found, err := todoControlReplay(ctx, tx, q, item, input, credential, "todo.moved"); found || err != nil {
			receipt = prior
			return err
		}
		legacy := uuid.NewSHA1(todoMoveNamespace, []byte(uuidString(item.ID)+"\x00"+input.Request)).String()
		var recorded bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests WHERE id=$1)`, legacy).Scan(&recorded); err != nil {
			return err
		}
		if recorded {
			return todoControlUnavailable()
		}
		order, err := q.LockMythicalStackOrder(ctx, input.Repository)
		if err != nil {
			return err
		}
		at := slices.IndexFunc(order, func(other db.MythicalItem) bool { return other.ID == item.ID })
		if at >= 0 {
			item = order[at]
		}
		if err := todoControlGuard(item, input, todoControlFacts{}); err != nil {
			return err
		}
		if at < 0 {
			return todoControlConflict("TODO is not on the stack")
		}
		to, edge := at-1, "first"
		if input.Direction == "down" {
			to, edge = at+1, "last"
		}
		if to < 0 || to >= len(order) {
			return todoControlConflict(fmt.Sprintf("T%d is already %s", number, edge))
		}
		neighbor := order[to]
		if mythicalMergeFenced(neighbor) {
			return &TodoControlError{http.StatusConflict, "merging", "conflict", fmt.Sprintf("T%d is merging", neighbor.Number.Int64)}
		}
		from, place := item.StackPosition.Int64, neighbor.StackPosition.Int64
		moved := slices.Clone(order)
		if moved[to], err = q.PlaceMythicalItem(ctx, item.ID, place); err != nil {
			return err
		}
		if moved[at], err = q.PlaceMythicalItem(ctx, neighbor.ID, from); err != nil {
			return err
		}
		rebased, err := reorderPrefixes(ctx, q, stack, order, moved, s.now())
		if err != nil {
			return err
		}
		receipt = TodoControlReceipt{State: "accepted", Place: place}
		if err := recordTodoControl(ctx, tx, moved[to], input, credential, "todo.moved", receipt, map[string]any{
			"item": uuidString(item.ID), "n": number, "direction": input.Direction, "from": from, "to": place,
			"past": neighbor.Number.Int64, "rebase": len(rebased), "actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username},
		}); err != nil {
			return err
		}
		for _, changed := range append([]db.MythicalItem{moved[to], moved[at]}, rebased...) {
			s.itemChanged(ctx, q, stack, changed.ID)
		}
		return nil
	})
	return receipt, err
}

// reorderPrefixes applies the stack worker's prefix rule
// (mythicalItemStep.prefix) to the stack's order before and after a
// reorder. Each item still on the stack whose verified candidate was built on
// its old prefix, and whose prefix the reorder changed, loses that
// verification (invalidatePrefix) in the caller's transaction and waits for
// its rebase onto the new prefix, which the stack's integrate step runs.
// before and after hold the same items, after in the new order; it answers
// the items it saved.
func reorderPrefixes(ctx context.Context, q *db.Queries, stack db.MythicalStack, before, after []db.MythicalItem, now time.Time) ([]db.MythicalItem, error) {
	run := &mythicalRun{row: stack, mainTip: stack.LandedMain}
	was, is := &mythicalItemStep{r: run, items: before, now: now}, &mythicalItemStep{r: run, items: slices.Clone(after), now: now}
	var rebased []db.MythicalItem
	for i, item := range is.items {
		if mythicalSettledStates[item.State] || !item.CandidateVerified || len(item.PendingOp) > 0 {
			continue
		}
		if prefix := is.prefix(item); prefix == item.CandidateBase || was.prefix(item) != item.CandidateBase {
			continue
		}
		saved, err := q.SaveMythicalItem(ctx, *is.invalidatePrefix(item))
		if err != nil {
			return nil, err
		}
		is.items[i] = saved
		rebased = append(rebased, saved)
	}
	return rebased, nil
}
