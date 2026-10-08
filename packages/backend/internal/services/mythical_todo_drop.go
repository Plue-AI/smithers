package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
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

// dropTodo admits a person's Drop under the stack lock. A live pinned attempt
// first commits cancellation and a durable capture obligation; the stack worker
// stops physical writers and retains their final capture before folding forks
// and removing the item. The existing pending_op owns PR close recovery. A
// repeated Idempotency-Key replays the original acknowledgment at either stage.
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
			checks := mythicalChecksOf(item)
			if item.FlowDigest.Valid && checks.RunLaunched && item.RequestOutcome == "" {
				capture, ok := s.lanes.(todoDropCapture)
				_, cancels := s.launcher.(mythicalRunCanceller)
				if !ok || !cancels || !stack.ActorUserID.Valid || item.WorkspaceID == "" {
					return todoControlUnavailable()
				}
				if err := capture.DropCaptureReady(ctx, tx, item); err != nil {
					return err
				}
				var forks bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces w JOIN mythical_items child ON child.workspace_id=w.id::text WHERE w.forked_from_item=$1 AND child.stack_position IS NOT NULL)`, item.ID).Scan(&forks); err != nil {
					return err
				}
				if forks {
					_, reads := s.lanes.(interface {
						CapturedHead(context.Context, string, int64, int64) (string, error)
					})
					if !reads || s.host == nil || (!mythicalSHA.MatchString(item.CandidateBase) && !mythicalSHA.MatchString(item.BaseCommit)) {
						return todoControlUnavailable()
					}
				}
				if item.PRNumber.Valid && s.github == nil {
					return todoControlUnavailable()
				}
				if err := s.cancelAttempt(ctx, tx, stack, item); err != nil {
					return err
				}
				checks.DropRequested = &todoDrop{Request: input.Request, Credential: credential, By: person.Username, At: s.now().UTC()}
				item.Checks = checks.encode()
				saved, err := q.SaveMythicalItem(ctx, item)
				if err != nil {
					return err
				}
				receipt = TodoControlReceipt{State: "accepted"}
				if err := s.recordTodoControl(ctx, tx, saved, input, credential, "todo.drop-requested", receipt, map[string]any{"item": uuidString(item.ID), "n": number}); err != nil {
					return err
				}
				s.itemChanged(ctx, q, stack, saved.ID)
				return nil
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
	checks.DropRequested = nil
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

// Cancellation admission and machine shutdown must commit separately: capture
// ingestion takes the stack lock too. The existing stack worker retries this
// obligation after crashes; neither a cancel receipt nor a DB head proves that
// the physical writer has stopped.
type todoDropCapture interface {
	DropCaptureReady(context.Context, pgx.Tx, db.MythicalItem) error
	CaptureDroppedTodo(context.Context, db.MythicalItem, func() error) error
}

func (s *MythicalService) advanceTodoDrop(ctx context.Context, stack db.MythicalStack, item db.MythicalItem) error {
	capture, ok := s.lanes.(todoDropCapture)
	if !ok {
		return todoControlUnavailable()
	}
	// Awake adopted branches retain their member writers. Capture before the
	// stack transaction: publication needs the same locks as folding. The
	// operation context pins each capture, so a later publication refuses the
	// transaction instead of folding stale bytes.
	ctx = withBranchCaptureContext(ctx)
	if prepare, ok := s.lanes.(interface {
		PrepareDroppedTodoFork(context.Context, string, int64) error
	}); ok {
		var branches []string
		if err := s.store.QueryRow(ctx, `SELECT COALESCE(array_agg(w.id::text ORDER BY child.stack_position), '{}'::text[]) FROM workspaces w JOIN mythical_items child ON child.workspace_id=w.id::text WHERE w.forked_from_item=$1 AND child.stack_position IS NOT NULL AND child.candidate_head=''`, item.ID).Scan(&branches); err != nil {
			return err
		}
		for _, branch := range branches {
			if err := prepare.PrepareDroppedTodoFork(ctx, branch, item.RepositoryID); err != nil {
				return err
			}
		}
	}
	return capture.CaptureDroppedTodo(ctx, item, func() error {
		return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID); err != nil {
				return err
			}
			q := db.New(tx)
			current, err := q.GetMythicalItem(ctx, item.ID)
			if err != nil {
				return err
			}
			drop := mythicalChecksOf(current).DropRequested
			if drop == nil {
				return nil
			}
			if current.Attempt != item.Attempt || current.WorkspaceID != item.WorkspaceID || mythicalMergeFenced(current) {
				return todoControlConflict("TODO changed during Drop")
			}
			if err := s.FoldIntoForks(ctx, tx, stack, current); err != nil {
				return err
			}
			order, err := q.LockMythicalStackOrder(ctx, current.RepositoryID)
			if err != nil {
				return err
			}
			saved, err := q.SaveMythicalItem(ctx, mythicalDropped(current, *drop))
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE workspaces SET branch_archived_at=COALESCE(branch_archived_at,$2) WHERE id::text=$1`, saved.WorkspaceID, drop.At); err != nil {
				return err
			}
			changed, err := s.removeTodoPlace(ctx, q, stack, saved, order)
			if err != nil {
				return err
			}
			for _, successor := range changed {
				s.itemChanged(ctx, q, stack, successor.ID)
			}
			raw, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "attempt": saved.Attempt, "by": drop.By})
			if _, err := s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.dropped", todoState(saved), raw); err != nil {
				return err
			}
			s.itemChanged(ctx, q, stack, saved.ID)
			return nil
		})
	})
}
