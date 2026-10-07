package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A run may expose only the conflict the stack retained for this attempt.
// Paths come from the retained native result, never from a model's request.
// Disappearing from a runtime checkpoint does not resolve a conflict; only
// Done's bound native validation settles it.
func todoConflictWait(item db.MythicalItem, wait flowruntime.PendingWait, update flowdispatch.ProjectionUpdate, now time.Time) (TodoWait, bool) {
	var request struct {
		Kind   string `json:"kind"`
		Change string `json:"conflict_change"`
		Onto   string `json:"onto_revision"`
	}
	raw := wait.Request
	var text string
	if json.Unmarshal(raw, &text) == nil {
		raw = json.RawMessage(text)
	}
	if json.Unmarshal(raw, &request) != nil || request.Kind != "conflict" || wait.Token == "" || wait.Name == "" || wait.RunID == "" {
		return TodoWait{}, false
	}
	checks := mythicalChecksOf(item)
	reservation := checks.ConflictReservation
	if reservation == nil || reservation.Run != item.RequestRunID || reservation.Change != request.Change || reservation.Onto != request.Onto || checks.Rebase == nil || checks.Rebase.Onto != request.Onto {
		return TodoWait{}, false
	}
	var retained struct {
		Conflict struct {
			Head, Onto string
			Paths      []string
		} `json:"conflict"`
	}
	if json.Unmarshal(item.Integration, &retained) != nil || retained.Conflict.Head != request.Change || retained.Conflict.Onto != request.Onto || len(retained.Conflict.Paths) == 0 {
		return TodoWait{}, false
	}
	pin, pinned := mythicalPinOf(item)
	signal := &TodoWaitSignal{Scope: update.Scope, Target: update.Checkpoint.Target, Flow: update.Checkpoint.FlowID, Run: update.Checkpoint.RunID, Name: wait.Name}
	if !pinned || !checks.RunLaunched || !checks.RunAttached || signal.Run != item.RequestRunID || signal.Flow != pin.Flow || !conflictSignalBound(item, signal) {
		return TodoWait{}, false
	}
	sum := sha256.Sum256([]byte(wait.RunID + "\x00" + wait.Token))
	return TodoWait{ID: "c-" + hex.EncodeToString(sum[:8]), Kind: "conflict", Paths: append([]string(nil), retained.Conflict.Paths...), ConflictChange: request.Change, OntoRevision: request.Onto, Since: now, Signal: signal}, true
}

// A reservation is durable intent, not evidence that a model executed. The
// eventual guest continuation must use this identity for replay admission.
type todoConflictReservation struct {
	Change   string `json:"change"`
	Onto     string `json:"onto"`
	Limit    int    `json:"limit"`
	Reserved int    `json:"reserved"`
	Run      string `json:"run"`
}

func conflictAttemptLimit(raw []byte) (int, error) {
	var config map[string]json.RawMessage
	if json.Unmarshal(raw, &config) != nil || config == nil {
		return 0, fmt.Errorf("invalid conflict configuration")
	}
	value, found := config["conflictAttempts"]
	if !found {
		return 1, nil
	}
	var limit int
	if string(value) == "null" || json.Unmarshal(value, &limit) != nil || limit < 0 || limit > 8 {
		return 0, fmt.Errorf("conflictAttempts must be an integer from 0 through 8")
	}
	return limit, nil
}

func (st *mythicalItemStep) reserveConflict(ctx context.Context, item db.MythicalItem, change, onto string) (*todoConflictReservation, error) {
	if prior := mythicalChecksOf(item).ConflictReservation; prior != nil && prior.Change == change && prior.Onto == onto && prior.Run == item.RequestRunID {
		return prior, nil
	}
	stored := []byte(`{}`)
	row, err := st.s.queries().GetInstallSetting(ctx, InstallCodingProjectKey)
	if err == nil {
		stored = row.Value
	} else if err != pgx.ErrNoRows {
		return nil, err
	}
	// Read configuration as data at the attempt's source pin. Never execute a
	// repository loader or reread the member's mutable working copy.
	source := mythicalChecksOf(item).FlowSource
	if source == "" {
		source = st.r.row.LandedMain
	}
	var overlay []byte
	if _, err := st.r.g.git(ctx, "cat-file", "-e", source+":"+mythicalWikiProject); err == nil {
		text, err := st.r.g.git(ctx, "show", source+":"+mythicalWikiProject)
		if err != nil {
			return nil, err
		}
		overlay = []byte(text)
	} else if !st.r.g.has(ctx, source) {
		return nil, err
	}
	merged, err := MergeCodingProject(stored, overlay)
	if err != nil {
		return nil, err
	}
	limit, err := conflictAttemptLimit(merged)
	if err != nil {
		return nil, err
	}
	reserved := 0
	if limit > 0 {
		reserved = 1
	}
	return &todoConflictReservation{Change: change, Onto: onto, Run: item.RequestRunID, Limit: limit, Reserved: reserved}, nil
}

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
	if !checks.RunLaunched || !checks.RunAttached || s.conflictValidator == nil || item.WorkspaceID == "" || !pinned || item.RequestRunID == "" || wait.Signal == nil || wait.Signal.Run != item.RequestRunID || wait.Signal.Flow != pin.Flow || wait.Signal.Name == "" || !conflictSignalBound(item, wait.Signal) {
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
