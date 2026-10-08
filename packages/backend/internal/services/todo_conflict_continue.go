package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// The stack sequences one durable repair launch under the existing attempt
// pin. E-19 keeps the TODO composition finite; polling cannot relaunch repair.
func (st *mythicalItemStep) continueConflict(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	checks := mythicalChecksOf(item)
	reservation := checks.ConflictReservation
	if checks.Rebase != nil && checks.Rebase.Native == nil && reservation != nil && !reservation.Dispatched {
		return st.materializeRetainedConflict(ctx, item)
	}
	_, pinned := mythicalPinOf(item)
	if reservation == nil || !pinned || !checks.RunLaunched || !checks.RunAttached || reservation.Run != item.RequestRunID || item.WorkspaceID == "" || st.s.branchRebase == nil || st.s.conflictValidator == nil || checks.Rebase == nil || checks.Rebase.Onto != reservation.Onto || st.prefix(item) != reservation.Onto {
		return nil, false, nil
	}
	sum := sha256.Sum256([]byte(uuidString(item.ID) + "\x00" + item.RequestRunID + "\x00" + reservation.Change + "\x00" + reservation.Onto))
	name := "conflict#" + hex.EncodeToString(sum[:16])
	inspector, ok := st.s.conflictValidator.(interface {
		UnresolvedPathsForStack(context.Context, ConflictValidation) ([]string, error)
	})
	if !ok {
		return nil, false, errors.New("stack conflict inspection unavailable")
	}
	paths, err := inspector.UnresolvedPathsForStack(ctx, ConflictValidation{Workspace: item.WorkspaceID, Change: reservation.Change, Onto: reservation.Onto, Run: reservation.Run, Digest: item.FlowDigest.String})
	if err != nil {
		return nil, false, err
	}
	if len(paths) == 0 {
		if reservation.Dispatched && reservation.ResolutionRun == "" {
			return nil, false, nil
		}
		// Files may resolve before the engine projects its durable Done wait.
		// Never queue a signal whose alias has not yet been admitted.
		signalDone := false
		if reservation.Dispatched {
			boundWait := false
			for _, wait := range checks.Waits {
				if wait.Kind == "conflict" && wait.Signal != nil && wait.Signal.Run == reservation.ResolutionRun && wait.ConflictChange == reservation.Change && wait.OntoRevision == reservation.Onto {
					boundWait = true
					signalDone = signalDone || wait.SettledAt == nil
				}
			}
			if !boundWait && reservation.Outcome != "completed" {
				return nil, false, nil
			}
		}
		capture, err := st.s.branchRebase.Capture(ctx, item.WorkspaceID)
		if err != nil {
			return nil, false, err
		}
		current, err := st.s.queries().GetMythicalItem(ctx, item.ID)
		if err != nil {
			return nil, false, err
		}
		live := mythicalChecksOf(current)
		if current.RequestRunID != item.RequestRunID || current.WorkspaceID != item.WorkspaceID || current.Generation != item.Generation || live.ConflictReservation == nil || live.ConflictReservation.Change != reservation.Change || live.Rebase == nil || live.Rebase.Onto != reservation.Onto {
			return nil, false, db.ErrMythicalItemMoved
		}
		live.Rebase.Native = &machined.RewriteResult{Head: capture.Head, Inspected: true}
		err = pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
			if err := st.lockNativeRebase(ctx, tx, current, reservation.Onto); err != nil {
				return err
			}
			signaler, ok := st.s.launcher.(mythicalSignaler)
			if !ok && reservation.Dispatched {
				return errors.New("conflict continuation unavailable")
			}
			for i := range live.Waits {
				wait := &live.Waits[i]
				if wait.Kind == "conflict" && wait.ConflictChange == reservation.Change && wait.OntoRevision == reservation.Onto && wait.SettledAt == nil {
					wait.SettledAt = &st.now
				}
			}
			current.Checks = live.encode()
			current.Reason = ""
			var err error
			current, err = db.New(tx).SaveMythicalItem(ctx, current)
			if err != nil {
				return err
			}
			if !signalDone {
				return nil
			}
			scope := jobs.Scope{TenantID: "repository:" + strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(st.r.row.ActorUserID.Int64, 10)}
			target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: item.WorkspaceID, BindingKind: mythicalBindingKind, BindingID: uuidString(item.ID)}
			_, err = signaler.SignalInTx(ctx, tx, flowdispatch.SignalRequest{Scope: scope, Target: target, RequestID: "todo-resolved-" + name, FlowID: "coding/rebase-conflict", RunID: reservation.ResolutionRun, Name: name, Payload: json.RawMessage(`"done"`)})
			return err
		})
		if err != nil {
			return nil, false, err
		}
		return &current, true, nil
	}
	if reservation.Dispatched {
		return nil, false, nil
	}
	if !st.r.row.ActorUserID.Valid {
		return nil, false, errors.New("conflict continuation unavailable")
	}
	input := map[string]any{"kind": "rebase-conflict", "change": reservation.Change, "onto": reservation.Onto, "paths": paths, "limit": reservation.Limit, "name": name, "intent": todoPrompt(item)}
	payload, err := json.Marshal(map[string]any{"input": input, "remaining": reservation.Limit})
	if err != nil {
		return nil, false, err
	}
	reservation.Dispatched = true
	checks.ConflictReservation = reservation
	next := item
	next.Checks = checks.encode()
	saved, err := st.commitWithGuard(ctx, next, "conflict", "coding/rebase-conflict", payload, func(tx pgx.Tx) error { return st.lockNativeRebase(ctx, tx, item, reservation.Onto) }, nil)
	if err != nil {
		return nil, false, err
	}
	return &saved, true, nil
}
