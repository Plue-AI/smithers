package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A terminal repair cannot accept another signal. Its native conflict still
// belongs to the original attempt and is repairable by a person, without
// restarting the engine or replenishing the reserved budget.
func manualConflictWait(item db.MythicalItem, now time.Time) (TodoWait, bool) {
	checks := mythicalChecksOf(item)
	r := checks.ConflictReservation
	_, pinned := mythicalPinOf(item)
	if item.State != "integrating" || item.Reason != "rebase_conflict_pending" || !pinned || !checks.RunLaunched || !checks.RunAttached || item.WorkspaceID == "" || item.RequestRunID == "" ||
		r == nil || !r.Dispatched || r.Run != item.RequestRunID || r.Outcome == "" || r.Outcome == "completed" ||
		checks.Rebase == nil || checks.Rebase.Onto != r.Onto || checks.Rebase.Native == nil ||
		!checks.Rebase.Native.Inspected || checks.Rebase.Native.Head != r.Change || len(checks.Rebase.Native.Paths) == 0 {
		return TodoWait{}, false
	}
	var retained struct {
		Conflict struct {
			Head, Onto string
			Paths      []string
		}
	}
	if json.Unmarshal(item.Integration, &retained) != nil || retained.Conflict.Head != r.Change || retained.Conflict.Onto != r.Onto || len(retained.Conflict.Paths) == 0 || !slices.Equal(retained.Conflict.Paths, checks.Rebase.Native.Paths) {
		return TodoWait{}, false
	}
	sum := sha256.Sum256([]byte(item.RequestRunID + "\x00" + r.Change + "\x00" + r.Onto))
	return TodoWait{ID: "c-" + hex.EncodeToString(sum[:8]), Kind: "conflict", ConflictChange: r.Change, OntoRevision: r.Onto, Paths: append([]string(nil), retained.Conflict.Paths...), Since: now}, true
}

func manualConflictWaitBound(item db.MythicalItem, wait TodoWait) bool {
	bound, ok := manualConflictWait(item, wait.Since)
	return ok && wait.Signal == nil && wait.ID == bound.ID && wait.Kind == bound.Kind && wait.ConflictChange == bound.ConflictChange && wait.OntoRevision == bound.OntoRevision
}

func projectManualConflictWait(item *db.MythicalItem, now time.Time) {
	wait, ok := manualConflictWait(*item, now)
	if !ok {
		return
	}
	checks := mythicalChecksOf(*item)
	for i := range checks.Waits {
		old := &checks.Waits[i]
		if old.Kind == wait.Kind && old.ConflictChange == wait.ConflictChange && old.OntoRevision == wait.OntoRevision {
			// An answer to the terminal engine is no longer deliverable.
			// Retain an admitted manual answer only when its capture authority
			// was durably recorded with it.
			if checks.ConflictReservation.Done == nil {
				old.SettledAt, old.AnsweredBy, old.Answer, old.By = nil, "", "", nil
			}
			old.Signal = nil
			item.Checks = checks.encode()
			return
		}
	}
	checks.Waits = append(checks.Waits, wait)
	item.Checks = checks.encode()
}

func (s *MythicalService) conflictDoneAuthorized(ctx context.Context, q *db.Queries, item db.MythicalItem) bool {
	r := mythicalChecksOf(item).ConflictReservation
	return r != nil && r.Done != nil && r.Run == item.RequestRunID && r.Done.Head == item.CandidateHead && r.Done.Generation == item.Generation &&
		(r.DoneCommand == "todo.answer" || r.DoneCommand == "branch.rebase") && s.storedBranchRequestAuthorized(ctx, q, item, r.Done, r.DoneCommand)
}
