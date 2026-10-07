package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"net/http"
)

// Keep answers the choice once but leaves the branch fact and its wait open.
// Only an authenticated metadata return event settles that independent wait.
func (s *MythicalService) keepMovedTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	return s.answerMovedTodo(ctx, number, input)
}
func (s *MythicalService) returnMovedTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s.movedReturn == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	// Never acquire the registry while holding stack/workspace row locks: the
	// authenticated event writer fences registry replacement through SQL commit.
	// Readiness is advisory here; the worker rechecks it before the real effect.
	item, err := s.queries().GetMythicalItemByNumber(ctx, input.Repository, number)
	if err != nil {
		return TodoControlReceipt{}, err
	}
	if s.movedReturn.RequireReady(item.WorkspaceID) != nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	return s.answerMovedTodo(ctx, number, input)
}
func (s *MythicalService) answerMovedTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		command, _ := TodoControlCommand(input.Op)
		person, credential, err := lockTodoRequest(ctx, tx, q, command, input)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, input.Repository); err != nil {
			return err
		}
		item, err := q.GetMythicalItemByNumber(ctx, input.Repository, number)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
		}
		if err != nil {
			return err
		}
		if err = todoControlGuard(item, input, todoControlFacts{}); err != nil {
			return err
		}
		checks := mythicalChecksOf(item)
		index := -1
		for i := range checks.Waits {
			if checks.Waits[i].ID == input.Wait && checks.Waits[i].Kind == "moved_off" {
				index = i
			}
		}
		if index < 0 {
			return &TodoControlError{http.StatusNotFound, "wait_not_found", "user", "Wait not found"}
		}
		wait := &checks.Waits[index]
		if wait.AnsweredBy != "" {
			if input.Op == "return-to-item" && wait.Answer == input.Op && wait.Return != nil && wait.Return.User == person.ID && wait.Return.Error != "" && wait.SettledAt == nil {
				// Retry the winning person's choice with current credentials.
				// Reauthentication cannot transfer that choice to someone else.
				info := middleware.AuthInfoFromContext(ctx)
				wait.Return = &TodoReturnRequest{User: person.ID, Credential: middleware.CredentialOf(info), RawScopes: info.RawScopes, Via: info.ViaHint}
				wait.DecisionRequest, wait.DecisionCredential = input.Request, credential
				item.Checks = checks.encode()
				saved, err := q.SaveMythicalItem(ctx, item)
				if err != nil {
					return err
				}
				receipt = TodoControlReceipt{State: "accepted", Number: number}
				if err = s.recordTodoControl(ctx, tx, saved, input, credential, "todo.return-retried", receipt, map[string]any{"item": uuidString(saved.ID), "n": number, "wait": input.Wait, "answered_by": wait.AnsweredBy}); err != nil {
					return err
				}
				_, err = q.RequestMythicalStack(ctx, input.Repository)
				return err
			}
			if wait.Answer == input.Op && wait.DecisionRequest == input.Request && wait.DecisionCredential == credential {
				receipt = TodoControlReceipt{State: "accepted", Number: number}
				return nil
			}
			return &TodoAnsweredError{AnsweredBy: wait.AnsweredBy}
		}
		if wait.SettledAt != nil {
			return todoControlConflict("Wait is settled")
		}
		var raw []byte
		if err = tx.QueryRow(ctx, `SELECT w.moved_off FROM workspaces w JOIN mythical_lanes l ON l.workspace_id=w.id::text AND l.retired_at IS NULL WHERE l.item_id=$1 AND w.repository_id=$2 FOR UPDATE OF w`, item.ID, input.Repository).Scan(&raw); err != nil {
			return err
		}
		var moved workspaceMovedOff
		if json.Unmarshal(raw, &moved) != nil || moved.Wait != wait.ID || moved.Item != uint64(number) || moved.PreMoveCommit != wait.SHA {
			return todoControlConflict("Branch is no longer moved off")
		}
		if input.Op == "return-to-item" {
			if s.movedReturn == nil {
				return todoControlUnavailable()
			}
			info := middleware.AuthInfoFromContext(ctx)
			wait.Return = &TodoReturnRequest{User: person.ID, Credential: middleware.CredentialOf(info), RawScopes: info.RawScopes, Via: info.ViaHint}
		}
		wait.AnsweredBy, wait.Answer, wait.DecisionRequest, wait.DecisionCredential = person.Username, input.Op, input.Request, credential
		item.Checks = checks.encode()
		saved, err := q.SaveMythicalItem(ctx, item)
		if err != nil {
			return err
		}
		receipt = TodoControlReceipt{State: "accepted", Number: number}
		kind := "todo.kept-moved"
		if input.Op == "return-to-item" {
			kind = "todo.return-requested"
		}
		if err = s.recordTodoControl(ctx, tx, saved, input, credential, kind, receipt, map[string]any{"item": uuidString(saved.ID), "n": number, "wait": input.Wait, "answered_by": person.Username}); err != nil {
			return err
		}
		if input.Op == "return-to-item" {
			_, err = q.RequestMythicalStack(ctx, input.Repository)
		}
		return err
	})
	return receipt, err
}
