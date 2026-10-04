package services

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Todo returns the shared TodoCard contract from the canonical item. The
// legacy mythical snapshot retains its engine-state decoder for old sessions.
func (s *MythicalService) Todo(ctx context.Context, repositoryID, number int64) (map[string]any, error) {
	item, err := s.queries().GetMythicalItemByNumber(ctx, repositoryID, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &TodoControlError{404, "todo_not_found", "user", "TODO not found"}
	}
	if err != nil {
		return nil, err
	}
	return s.todoCard(ctx, item)
}
func (s *MythicalService) Todos(ctx context.Context, repositoryID int64) ([]map[string]any, error) {
	items, err := s.queries().ListMythicalItems(ctx, repositoryID, 500)
	if err != nil {
		return nil, err
	}
	views := []map[string]any{}
	for _, item := range items {
		view, err := s.todoCard(ctx, item)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}
func todoAvatar(user db.User) string {
	if strings.HasPrefix(user.AvatarUrl, "https://") || strings.HasPrefix(user.AvatarUrl, "http://") {
		return user.AvatarUrl
	}
	return "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"
}
func (s *MythicalService) todoCard(ctx context.Context, item db.MythicalItem) (map[string]any, error) {
	var owner db.User
	var err error
	if item.OwnerID.Valid {
		owner, err = s.queries().GetUserByID(ctx, item.OwnerID.Int64)
	} else {
		owner, err = s.queries().GetSelfHostOwner(ctx)
	}
	if err != nil {
		return nil, err
	}
	revisions := item.Revisions
	if len(revisions) == 0 {
		revisions = []byte(`[]`)
	}
	waits := []map[string]any{}
	for _, wait := range todoOpenWaits(item) {
		waits = append(waits, map[string]any{"id": wait.ID, "kind": wait.Kind, "prompt": wait.Prompt, "since": wait.Since, "actions": []any{}})
	}
	// There is no branch or machine before admission. Never invent an ID or
	// machine state for a queued item; TodoCard permits that absence.
	card := map[string]any{"n": item.Number.Int64, "title": item.Title.String, "state": todoState(item),
		"owner":            map[string]any{"login": owner.Username, "name": owner.DisplayName, "avatar_url": todoAvatar(owner)},
		"prompt_revisions": revisions, "steps": []any{}, "waits": waits, "steers": []any{}, "evidence": []any{},
		"merge": map[string]any{"state": "waiting", "reason": "state", "on_github": item.PRNumber.Valid}, "present": []any{}}
	if item.WorkspaceID != "" {
		workspace, err := s.queries().GetWorkspace(ctx, item.WorkspaceID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil && workspace.RepositoryID == item.RepositoryID {
			state := branchMachineState(workspace)
			if state == "provisioning" {
				state = "waking"
			}
			machine := map[string]any{"state": state}
			if state == "failed" {
				machine["error"] = map[string]any{"class": "infra", "message": workspace.FailureMessage.String}
			}
			card["branch"] = map[string]any{"id": workspace.ID, "name": workspace.Name, "machine": machine}
		}
	}
	if item.Attempt > 0 && item.RequestRunID != "" {
		card["run"] = map[string]any{"id": item.RequestRunID, "attempt": item.Attempt, "indicators": []any{}}
	}
	if item.StackPosition.Valid {
		card["place"] = item.StackPosition.Int64
	}
	if item.PRNumber.Valid && item.PRURL != "" {
		card["pr"] = map[string]any{"number": item.PRNumber.Int64, "url": item.PRURL, "head": item.PRHead, "draft": false, "included_items": []int64{item.Number.Int64}}
	}
	receipts := mythicalReceiptsView(item)
	if len(receipts) > 0 && item.Attempt > 0 {
		evidence := []map[string]any{}
		for _, receipt := range receipts {
			state := receipt.Status
			if state != "passed" && state != "failed" {
				state = "running"
			}
			evidence = append(evidence, map[string]any{"kind": "check", "name": receipt.Check, "state": state})
		}
		card["evidence"] = []map[string]any{{"attempt": item.Attempt, "revision": item.CandidateHead, "items": evidence}}
	}
	return card, nil
}
