package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// todoDrop is a person's Drop of a TODO (spec §10.7.2): the press's
// Idempotency-Key, the person's login, which the pull request's closing
// comment names, and when.
type todoDrop struct {
	Request    string    `json:"request"`
	Credential string    `json:"credential,omitempty"`
	By         string    `json:"by"`
	At         time.Time `json:"at"`
}

// mythicalAttemptPhases are the launches one attempt admits (commit's phase):
// its todo composition or coding request, delivery, verification and review.
var mythicalAttemptPhases = []string{"todo", "request", "vibe", "verify", "review"}

// mythicalLaunchRequestID is the durable request id of an item's launch:
// one per attempt, phase and generation.
func mythicalLaunchRequestID(item string, attempt int32, phase string, generation int64) string {
	return fmt.Sprintf("mythical:%s:%d:%s:%d", item, attempt, phase, generation)
}

// mythicalRunCanceller records a launch's cancellation in the caller's
// transaction (flowdispatch.Service.CancelRequestInTx); the dispatcher's
// worker then cancels the run.
type mythicalRunCanceller interface {
	CancelRequestInTx(context.Context, pgx.Tx, jobs.Scope, string) (jobs.Operation, error)
}

// dropTodo is Drop on an unmerged TODO (spec §4.1 any unmerged → dropped,
// §10.7.2). Under the stack's row lock it applies the control guard, cancels
// the attempt's runs in the same transaction, settles every open wait,
// clears the pause and records the TODO cancelled, which projects dropped:
// no later TODO's merge waits on it (mythicalMergeAfter) and no later
// prefix includes it. A TODO with a pull request keeps a close obligation in
// its pending_op: the stack comments "Dropped in Smithers by @x" and closes
// it (appSend), then releases its lane as it does every settled item's. The
// same Idempotency-Key again answers the same receipt; another press on the
// dropped TODO is 409.
func (s *MythicalService) dropTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if _, err := Authorize(ctx, s.queries(), "todo.drop"); err != nil {
		return TodoControlReceipt{}, err
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "todo.drop", input)
		if err != nil {
			return err
		}
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
			if prior, found, err := todoControlReplay(ctx, tx, q, item, input, credential, "todo.dropped"); found || err != nil {
				receipt = prior
				return err
			}
			if dropped := mythicalChecksOf(item).Dropped; dropped != nil && dropped.Request == input.Request && dropped.Credential == "" {
				return todoControlUnavailable()
			}
			if err := todoControlGuard(item, input, todoControlFacts{}); err != nil {
				return err
			}
			if len(item.PendingOp) > 0 {
				op, err := decodeMythicalOutbound(item.PendingOp)
				if err != nil {
					return err
				}
				if op.Kind == "merge" || op.State == "intended" {
					return todoControlConflict("A GitHub write on this TODO is settling; drop it again in a moment")
				}
			}
			// A pinned composition may still write after cancellation admission.
			// Until stopped-writer capture is composed, refuse before recording
			// cancellation or allowing successor rebases to discard its work.
			checks := mythicalChecksOf(item)
			if item.FlowDigest.Valid && checks.RunLaunched && item.RequestOutcome == "" {
				return todoControlUnavailable()
			}
			if err := s.FoldIntoForks(ctx, tx, stack, item); err != nil {
				return err
			}
			if err := s.cancelAttempt(ctx, tx, stack, item); err != nil {
				return err
			}
			order, err := q.LockMythicalStackOrder(ctx, input.Repository)
			if err != nil {
				return err
			}
			next := mythicalDropped(item, todoDrop{Request: input.Request, Credential: credential, By: person.Username, At: s.now().UTC()})
			saved, err := q.SaveMythicalItem(ctx, next)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			changed, err := s.removeTodoPlace(ctx, q, stack, saved, order)
			if err != nil {
				return err
			}
			for _, successor := range changed {
				s.itemChanged(ctx, q, stack, successor.ID)
			}
			receipt = TodoControlReceipt{State: "accepted"}
			if err := s.recordTodoControl(ctx, tx, saved, input, credential, "todo.dropped", receipt, map[string]any{
				"item": uuidString(saved.ID), "n": saved.Number.Int64, "attempt": saved.Attempt, "pr": len(saved.PendingOp) > 0,
				"actor": map[string]any{"kind": "person", "id": person.ID, "login": person.Username}, "from": todoState(item), "to": todoState(saved),
			}); err != nil {
				return err
			}
			if stack.RepositoryID == input.Repository {
				s.itemChanged(ctx, q, stack, saved.ID)
			}
			return nil
		}
		return &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is busy; drop it again"}
	})
	return receipt, err
}

// cancelAttempt cancels every persisted launch of the current attempt,
// including its composition launched before candidate generations advanced.
// A phase never launched, or a run already ended, changes nothing.
func (s *MythicalService) cancelAttempt(ctx context.Context, tx pgx.Tx, stack db.MythicalStack, item db.MythicalItem) error {
	canceller, ok := s.launcher.(mythicalRunCanceller)
	if !ok || !stack.ActorUserID.Valid || item.Attempt <= 0 {
		return nil
	}
	scope := jobs.Scope{TenantID: "repository:" + strconv.FormatInt(stack.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(stack.ActorUserID.Int64, 10)}
	// Request identity belongs to admission, not the current candidate. Keep
	// current-generation identities for legacy launchers, and add persisted
	// earlier launches from the same item and attempt. Never select a private
	// principal stream or cancel another item's work.
	requests := make([]string, 0, len(mythicalAttemptPhases))
	seen := map[string]bool{}
	for _, phase := range mythicalAttemptPhases {
		request := mythicalLaunchRequestID(uuidString(item.ID), item.Attempt, phase, item.Generation)
		requests = append(requests, request)
		seen[request] = true
	}
	rows, err := tx.Query(ctx, `SELECT request_id FROM product_job_requests
	 WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3
	 AND payload->'projection'->>'kind'=$4
	 AND payload->'projection'->>'itemId'=$5
	 AND payload->'projection'->>'attempt'=$6
	 ORDER BY created_at,id`, scope.TenantID, scope.PrincipalID, flowdispatch.OperationLaunch,
		mythicalBindingKind, uuidString(item.ID), strconv.FormatInt(int64(item.Attempt), 10))
	if err != nil {
		return err
	}
	for rows.Next() {
		var request string
		if err := rows.Scan(&request); err != nil {
			rows.Close()
			return err
		}
		if !seen[request] {
			requests = append(requests, request)
			seen[request] = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, request := range requests {
		if _, err := canceller.CancelRequestInTx(ctx, tx, scope, request); err != nil && !errors.Is(err, jobs.ErrNotFound) {
			return fmt.Errorf("cancel the TODO's launch %s: %w", request, err)
		}
	}
	return nil
}

// mythicalDropped is item dropped by drop: cancelled, its open waits
// settled, its pause cleared, and, while its pull request is open, the
// obligation to close it.
func mythicalDropped(item db.MythicalItem, drop todoDrop) db.MythicalItem {
	next := item
	checks := mythicalChecksOf(item)
	for i := range checks.Waits {
		if checks.Waits[i].SettledAt == nil {
			at := drop.At
			checks.Waits[i].SettledAt = &at
		}
	}
	checks.Dropped = &drop
	checks.GitHubDropRead = nil
	checks.GitHubClosedAt = &drop.At
	checks.GitHubClosedPosition = item.StackPosition.Int64
	next.Checks = checks.encode()
	next.State, next.Reason = "cancelled", "dropped"
	next.PausedAt, next.NextAttemptAt = pgtype.Timestamptz{}, pgtype.Timestamptz{}
	if len(item.PendingOp) == 0 && item.PRNumber.Valid && item.PRState != "closed" {
		next.PendingOp, _ = json.Marshal(MythicalOutboundOp{Kind: "close", Target: strconv.FormatInt(item.PRNumber.Int64, 10), Desired: "closed", Precondition: "open", State: "intended"})
	}
	return settleTodoAttemptEvidence(next, "dropped")
}

// mythicalDropComment is the comment a dropped TODO's pull request closes
// with (§10.7.2).
func mythicalDropComment(drop *todoDrop) string {
	if drop == nil || drop.By == "" {
		return "Dropped in Smithers"
	}
	return "Dropped in Smithers by @" + drop.By
}
