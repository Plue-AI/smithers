package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"net/http"
)

// takeoverTodo changes only ownership. It preserves placement, revisions,
// waits, machine and attempt, and records the authenticated person once.
func (s *MythicalService) takeoverTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "todo.takeover", input)
		if err != nil {
			return err
		}
		item, err := q.GetMythicalItemByNumber(ctx, input.Repository, number)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{Status: http.StatusNotFound, Code: "todo_not_found", Class: "user", Message: "TODO not found"}
		}
		if err != nil {
			return err
		}
		if prior, found, err := todoControlReplay(ctx, tx, q, item, input, credential, "todo.owner_changed"); found || err != nil {
			receipt = prior
			return err
		}
		if err := todoControlGuard(item, input, todoControlFacts{}); err != nil {
			return err
		}
		if !item.OwnerID.Valid {
			return todoControlConflict("TODO owner is active")
		}
		// Only a removed or suspended owner can be replaced.
		var active bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id
   WHERE c.repository_id=$1 AND c.user_id=$2 AND c.suspended_at IS NULL AND NOT u.prohibit_login)`, input.Repository, item.OwnerID.Int64).Scan(&active)
		if err != nil {
			return err
		}
		owner, err := q.GetSelfHostOwner(ctx)
		if err != nil {
			return err
		}
		if active || owner.ID == item.OwnerID.Int64 {
			return todoControlConflict("TODO owner is active")
		}
		previous := item.OwnerID.Int64
		if _, err := tx.Exec(ctx, `UPDATE mythical_items SET owner_id=$2, version=version+1, updated_at=NOW() WHERE id=$1`, item.ID, person.ID); err != nil {
			return err
		}
		item.OwnerID.Int64 = person.ID
		receipt = TodoControlReceipt{State: "accepted", Number: number}
		if err := recordTodoControl(ctx, tx, item, input, credential, "todo.owner_changed", receipt, map[string]any{
			"item": uuidString(item.ID), "n": number, "from": previous, "owner": person.Username,
			"actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username},
		}); err != nil {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, input.Repository)
		if err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, item.ID)
		return nil
	})
	return receipt, err
}
