package services

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ConflictValidation binds native unresolved-path inspection to the retained
// change, target and attempt. A provider must inspect jj's conflict state in
// the authenticated guest under its mutation lock, never grep host files.
type ConflictValidation struct {
	Workspace, Change, Onto, Run, Digest string
}

type ConflictValidator interface {
	UnresolvedPaths(context.Context, ConflictValidation) ([]string, error)
}

// SetConflictValidator is deliberately separate from file reads: a readable
// working copy does not establish native conflict validation or writer fencing.
func (s *MythicalService) SetConflictValidator(provider ConflictValidator) {
	s.conflictValidator = provider
}

func (s *MythicalService) validateConflictDone(ctx context.Context, item db.MythicalItem, wait TodoWait, answer string) error {
	if answer != "done" {
		return &TodoControlError{400, "invalid_answer", "user", "Press Done after resolving the conflict"}
	}
	checks := mythicalChecksOf(item)
	var integration struct {
		Conflict struct{ Head, Onto string } `json:"conflict"`
	}
	if json.Unmarshal(item.Integration, &integration) != nil || wait.ConflictChange == "" || wait.OntoRevision == "" ||
		integration.Conflict.Head != wait.ConflictChange || integration.Conflict.Onto != wait.OntoRevision ||
		checks.Rebase == nil || checks.Rebase.Onto != wait.OntoRevision {
		return &TodoControlError{409, "stale_conflict", "conflict", "The conflict target changed"}
	}
	pin, pinned := mythicalPinOf(item)
	if s.conflictValidator == nil || item.WorkspaceID == "" || !pinned || item.RequestRunID == "" || wait.Signal == nil || wait.Signal.Run != item.RequestRunID || wait.Signal.Flow != pin.Flow || wait.Signal.Name == "" || !conflictSignalBound(item, wait.Signal) {
		return &TodoControlError{503, "conflict_validation_unavailable", "infra", "Conflict validation unavailable"}
	}
	stack, err := s.queries().GetMythicalStack(ctx, item.RepositoryID)
	if err != nil || !stack.ActorUserID.Valid || wait.Signal.Scope.PrincipalID != "user:"+strconv.FormatInt(stack.ActorUserID.Int64, 10) {
		return &TodoControlError{503, "conflict_validation_unavailable", "infra", "Conflict validation unavailable"}
	}
	paths, err := s.conflictValidator.UnresolvedPaths(ctx, ConflictValidation{Workspace: item.WorkspaceID, Change: wait.ConflictChange,
		Onto: wait.OntoRevision, Run: item.RequestRunID, Digest: item.FlowDigest.String})
	if err != nil {
		return &TodoControlError{503, "conflict_validation_unavailable", "infra", "Conflict validation unavailable"}
	}
	if len(paths) != 0 {
		return &TodoControlError{409, "still_conflicted", "conflict", "Resolve the remaining conflicts"}
	}
	return nil
}

// Native inspection must not run for a signal addressed to another branch or
// item. A matching run name alone does not establish its runtime authority.
func conflictSignalBound(item db.MythicalItem, signal *TodoWaitSignal) bool {
	if signal == nil {
		return false
	}
	tenant := "repository:" + strconv.FormatInt(item.RepositoryID, 10)
	return signal.Scope.TenantID == tenant && signal.Scope.PrincipalID != "" &&
		signal.Target.TenantID == tenant && signal.Target.PrincipalID == signal.Scope.PrincipalID &&
		signal.Target.WorkspaceID == item.WorkspaceID && signal.Target.BindingKind == mythicalBindingKind &&
		signal.Target.BindingID == uuidString(item.ID)
}
