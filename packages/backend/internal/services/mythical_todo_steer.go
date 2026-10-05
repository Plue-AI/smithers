package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// steerTodo is Steer (spec §10.7.3): a person's text for TODO n's coding
// agent, kept on the card (steers[]) and delivered by the TODO's state:
//
//   - working, its coding request's run attached: sent to that run at once as
//     a message, which the run takes at its next feedback boundary (before
//     implementation, or after correction) and plans again with;
//   - starting: held, and sent to the run when it attaches (todoAttachSteers);
//   - queued: held as the next attempt's first input (todoFeedback);
//   - paused: held, and delivered when Resume runs the attempt again;
//   - past its coding run (delivering through in review): the attempt's runs
//     are cancelled and the TODO queues for its next attempt with the steer as
//     its first input; an open pull request stays open and the next proposal
//     updates it;
//   - failed: Retry with that steer (retryTodo, Retry's person-only guard);
//   - merged or dropped: 409 todo_closed.
//
// A steer never settles a question: with one open, the run keeps the message
// until the question is answered. The same Idempotency-Key again answers the
// same receipt. A stage-1 terminal's credential steers for its member, only
// its own branch's TODO.
func (s *MythicalService) steerTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	signaler, _ := s.launcher.(mythicalSignaler)
	if signaler == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if _, terminal := middleware.AuthInfoFromContext(ctx).TerminalDelegation(); !terminal {
		if err := middleware.RequirePerson(ctx, "steer a TODO"); err != nil {
			return TodoControlReceipt{}, &TodoControlError{http.StatusForbidden, "permission", "permission", "Only a person steers a TODO"}
		}
	}
	// A failed TODO's steer is Retry with that steer; Retry guards it again
	// under the stack's lock.
	if item, err := s.queries().GetMythicalItemByNumber(ctx, input.Repository, number); err == nil && item.State == "blocked" && !mythicalMergeFenced(item) {
		if err := todoBranchForbids(ctx, item); err != nil {
			return TodoControlReceipt{}, err
		}
		retry := input
		retry.Op = "retry"
		return s.retryTodo(ctx, number, retry)
	}
	person, err := s.queries().GetUserByID(ctx, input.Actor)
	if err != nil {
		return TodoControlReceipt{}, err
	}
	by := todoActor(ctx, person)
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
			if err := todoBranchForbids(ctx, item); err != nil {
				return err
			}
			for _, steer := range mythicalChecksOf(item).Steers {
				if input.Request != "" && steer.Request == input.Request {
					receipt = TodoControlReceipt{State: "accepted"}
					return nil
				}
			}
			if err := todoControlGuard(item, input, todoControlFacts{}); err != nil {
				return err
			}
			if item.State == "blocked" {
				return todoControlConflict("TODO failed; steer it again to retry it")
			}
			steer := todoSteer{Text: *input.Steer, By: by, At: s.now().UTC(), Request: input.Request}
			next, steer, delivery, err := s.placeTodoSteer(ctx, tx, stack, item, steer, "steer it again")
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
			fact, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "attempt": steer.Attempt, "delivery": delivery,
				"actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username}, "by": todoActorRef(ctx, person), "from": todoState(item), "to": todoState(saved)})
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.steered", todoState(saved), fact); err != nil {
				return err
			}
			if steer.Run != "" {
				scope, target := todoRunTarget(stack, saved)
				if _, err := signaler.SignalInTx(ctx, tx, todoSteerSignal(uuidString(saved.ID), scope, target, "coding/request", steer.Run, steer)); err != nil {
					return err
				}
			}
			if stack.RepositoryID == input.Repository {
				s.itemChanged(ctx, q, stack, saved.ID)
			}
			receipt = TodoControlReceipt{State: "accepted"}
			return nil
		}
		return &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is busy; steer it again"}
	})
	return receipt, err
}

// placeTodoSteer files steer on item by the TODO's state (spec §10.7.3),
// inside the transaction that holds the stack's row lock, and answers the
// item to save, the steer as filed and its delivery:
//
//   - "held": for the attempt that receives it as its first input (queued:
//     attempt n+1; paused: the attempt Resume runs again), or, while the
//     attempt is starting, for its run to attach (Pending, todoAttachSteers);
//   - "sent": to the working attempt's live coding run (steer.Run), which the
//     caller signals once the item is saved (todoSteerSignal);
//   - "next_attempt": the attempt's coding run has ended, so its runs are
//     cancelled and the TODO queues for attempt n+1 with the steer first.
//
// A failed TODO is not placed here: Retry carries its steer. again names the
// press in the refusal that asks for it once a GitHub write settles.
func (s *MythicalService) placeTodoSteer(ctx context.Context, tx pgx.Tx, stack db.MythicalStack, item db.MythicalItem, steer todoSteer, again string) (db.MythicalItem, todoSteer, string, error) {
	next, delivery := item, "held"
	checks := mythicalChecksOf(item)
	switch {
	case item.PausedAt.Valid:
		// Resume runs this attempt again with every steer held for it.
		steer.Attempt = item.Attempt
	case item.State == "queued" || item.State == "retrying" || item.State == "skipped":
		// The next launch is attempt n+1; the steer is its first input.
		steer.Attempt = item.Attempt + 1
	case item.State == "running" && item.RequestOutcome == "":
		if item.FlowDigest.Valid {
			// The todo composition's host refuses messages until its
			// boundaries are composed (T-FLW-11, flows/coding/steering.ts).
			return item, steer, "", todoControlUnavailable()
		}
		steer.Attempt = item.Attempt
		if checks.RunAttached && item.RequestRunID != "" && stack.ActorUserID.Valid {
			steer.Run, delivery = item.RequestRunID, "sent"
		} else {
			steer.Pending = true
		}
	default:
		// The attempt's coding run has ended: the steer re-enters
		// implement as the next attempt's first input.
		if len(item.PendingOp) > 0 {
			return item, steer, "", todoControlConflict("A GitHub write on this TODO is settling; " + again + " in a moment")
		}
		if err := s.cancelAttempt(ctx, tx, stack, item); err != nil {
			return item, steer, "", err
		}
		next, delivery = mythicalSteered(item), "next_attempt"
		checks = mythicalChecksOf(next)
		steer.Attempt = item.Attempt + 1
	}
	checks.Steers = append(checks.Steers, steer)
	next.Checks = checks.encode()
	return next, steer, delivery, nil
}

// mythicalSteered is an item past its coding run queued for its next
// attempt by a steer: its evidence kept, its review forgotten (the next
// attempt proposes a new head), the attempt bound counting from here. An
// open pull request stays open; the next proposal pushes its branch again.
func mythicalSteered(item db.MythicalItem) db.MythicalItem {
	next := retainTodoAttemptEvidence(item)
	next.State, next.Reason, next.NextAttemptAt = "queued", "", pgtype.Timestamptz{}
	checks := mythicalChecksOf(next)
	checks.Replans, checks.AttemptBase = 0, item.Attempt
	checks.RunLaunched, checks.RunAttached, checks.Review = false, false, nil
	next.Checks = checks.encode()
	return next
}

// todoRunTarget is the scope and target every launch of item ran under
// (commitWith): the stack's repository and actor, and the item's lane.
func todoRunTarget(stack db.MythicalStack, item db.MythicalItem) (jobs.Scope, flowruntime.FlowRuntimeTarget) {
	tenant, principal := "repository:"+strconv.FormatInt(stack.RepositoryID, 10), "user:"+strconv.FormatInt(stack.ActorUserID.Int64, 10)
	return jobs.Scope{TenantID: tenant, PrincipalID: principal}, flowruntime.FlowRuntimeTarget{TenantID: tenant, PrincipalID: principal,
		WorkspaceID: item.WorkspaceID, BindingKind: mythicalBindingKind, BindingID: uuidString(item.ID)}
}

// todoSteerSignal is steer as the message the dispatcher delivers to run
// (the runtime's steer mutation), once per steer.
func todoSteerSignal(itemID string, scope jobs.Scope, target flowruntime.FlowRuntimeTarget, flowID, run string, steer todoSteer) flowdispatch.SignalRequest {
	key := steer.Request
	if key == "" {
		key = steer.At.UTC().Format(time.RFC3339Nano)
	}
	id := "todo-steer:" + itemID + ":" + key
	authorization, _ := json.Marshal(map[string]any{"itemId": itemID, "steer": key})
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-steer", "itemId": itemID})
	return flowdispatch.SignalRequest{Scope: scope, RequestID: id, Target: target, FlowID: flowID, RunID: run,
		AuthorizationContext: authorization, Projection: projection,
		Steer: &flowdispatch.SteerMessage{MessageID: id, CreatedAt: float64(steer.At.UnixMilli()), Body: steer.Text}}
}

// todoAttachSteers sends the steers that reached a starting attempt to its
// coding request's run once the host attaches it (§10.7.3): each is marked
// sent to run in next, and its message is returned for admission in the
// projection's transaction.
func todoAttachSteers(next *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate, run string) []flowdispatch.SignalRequest {
	if projection.Phase != "request" || run == "" || next.RequestRunID != run || update.State.Terminal() {
		return nil
	}
	checks := mythicalChecksOf(*next)
	if !checks.RunAttached {
		return nil
	}
	var out []flowdispatch.SignalRequest
	for i := range checks.Steers {
		steer := &checks.Steers[i]
		if !steer.Pending || steer.Attempt != next.Attempt {
			continue
		}
		steer.Pending, steer.Run = false, run
		out = append(out, todoSteerSignal(uuidString(next.ID), update.Scope, update.Checkpoint.Target, update.Checkpoint.FlowID, run, *steer))
	}
	if len(out) > 0 {
		next.Checks = checks.encode()
	}
	return out
}
