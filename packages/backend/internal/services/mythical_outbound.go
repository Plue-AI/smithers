package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// MythicalOutboundOp occupies the existing item's pending_op, never a queue.
// Target is a ref, head branch or PR number; desired/precondition are heads,
// body digests or lifecycle values. Legacy push fields remain readable.
type MythicalOutboundOp struct {
	Kind         string `json:"kind"`
	Target       string `json:"target"`
	Desired      string `json:"desired"`
	Precondition string `json:"precondition"`
	State        string `json:"state"`
}

// An attempted write keeps its unknown slot. Wake for reconciliation promptly;
// the next pass still looks up before it can authorize any repeat.
type mythicalOutboundUncertainError struct{ error }

func (e *mythicalOutboundUncertainError) Unwrap() error { return e.error }

// MythicalOutboundProviders are current, effect-free guards supplied by the
// owning dependencies. None may mint tokens. Missing wiring fails closed.
// Lookup returns the observed head/digest/lifecycle; AppliedClose must consult
// canonical-App events before current state (a person's reopen is not a retry).
// Send must use budgeted App transport and trusted bare-object tools only.
// Lookup, Send and Settle run within the claimed pass they are given, which
// holds its GitHub destination and bare-object transport; this is their one
// binding (EnableTodoPublication composes them for push, open and merge).
// MergeDecision is T-STK-04's fresh DecideMerge under the matching TODO fence,
// composed with them; the merge route's gate opens only when all are.
// PrepareMerge is a merge's Send in two parts: everything but the request,
// before the claim records the merge as sent, and the request alone after.
type MythicalOutboundProviders struct {
	CanonicalApp, StackLease, Budget, Membership, Authorization, AcceptedGeneration func(context.Context, db.MythicalItem, string) error
	MergeDecision                                                                   func(context.Context, db.MythicalItem, MythicalOutboundOp) (mythicalMergeDecided, error)
	PrepareMerge                                                                    func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (mythicalMergeDispatch, error)
	Lookup                                                                          func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (observed string, appliedClose bool, err error)
	Send                                                                            func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) error
	// Settle projects a confirmed operation and retains Drop's PR-close obligation.
	// It returns data only; the worker persists it under the same live lease.
	Settle func(*mythicalItemStep, context.Context, db.MythicalItem, MythicalOutboundOp) (db.MythicalItem, error)
}

func (s *MythicalService) outboundReady(ctx context.Context, item db.MythicalItem, kind string) error {
	p := s.outbound
	for _, guard := range []struct {
		name string
		call func(context.Context, db.MythicalItem, string) error
	}{{"canonical App", p.CanonicalApp}, {"stack lease", p.StackLease}, {"budgeted transport", p.Budget}, {"current membership", p.Membership}, {"command authorization", p.Authorization}, {"accepted generation and TODO fence", p.AcceptedGeneration}} {
		if guard.call == nil {
			return fmt.Errorf("Waiting for %s integration", guard.name)
		}
		if err := guard.call(ctx, item, kind); err != nil {
			return err
		}
	}
	return nil
}

func decodeMythicalOutbound(raw json.RawMessage) (MythicalOutboundOp, error) {
	var op MythicalOutboundOp
	if err := json.Unmarshal(raw, &op); err != nil {
		return op, err
	}
	if op.Kind == "" {
		var legacy mythicalProposalOp
		if err := json.Unmarshal(raw, &legacy); err != nil {
			return op, err
		}
		if legacy.Branch != "" && legacy.Head != "" {
			op = MythicalOutboundOp{Kind: "push", Target: legacy.Branch, Desired: legacy.Head, Precondition: legacy.Expected, State: "unknown"}
		}
	}
	switch op.Kind {
	case "push", "open", "body", "draft", "merge", "close":
	default:
		return op, errors.New("invalid pending GitHub operation kind")
	}
	if op.Target == "" || op.Desired == "" {
		return op, errors.New("invalid pending GitHub operation target or desired value")
	}
	switch op.State {
	case "intended", "unknown", "done", "conflict":
	default:
		return op, errors.New("invalid pending GitHub operation state")
	}
	return op, nil
}

// mythicalPublishes reports the operations that write a TODO's own branch and
// pull request; a foreign head found by either is a person's push.
func mythicalPublishes(kind string) bool { return kind == "push" || kind == "open" }

// outboundResult never authorizes a repeat after a foreign change. A close
// event by the App settles even if a person subsequently reopened the PR.
func outboundResult(op MythicalOutboundOp, observed string, appliedClose bool) string {
	if observed == op.Desired || op.Kind == "close" && appliedClose {
		return "done"
	}
	if observed == op.Precondition {
		return "intended"
	}
	return "conflict"
}

// recoverOutbound runs within the existing claimed stack worker. Every repeat
// is preceded by lookup, then current authority, then a committed unknown slot.
// An uncertain slot survives errors, cancellation, Drop and missing providers.
// A merge is decided after lookup by recoverMerge; applied merges never repeat.
func (st *mythicalItemStep) recoverOutbound(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	op, err := decodeMythicalOutbound(item.PendingOp)
	if err != nil {
		return nil, err
	}
	if op.State == "conflict" && !mythicalNoPRPushLease(item, op) {
		if mythicalPublishes(op.Kind) {
			checks := mythicalChecksOf(item)
			missingWait := checks.ForeignHead != ""
			for _, wait := range checks.Waits {
				if wait.Kind == "foreign_push" {
					missingWait = false
				}
			}
			if missingWait {
				return st.saveOutboundForeignWait(ctx, item, &mythicalForeignHead{Branch: op.Target, Head: checks.ForeignHead})
			}
			// Held for a person: nothing moves but the hold's notice, said once.
			held := st.s.deliverNotice(ctx, st.r, item)
			return &held, nil
		}
		return nil, errors.New("pending GitHub operation conflicts with a foreign change")
	}
	if op.State == "done" && !mythicalNoPRPushLease(item, op) {
		return st.settleOutbound(ctx, item, op)
	}
	p := st.s.outbound
	if p.Lookup == nil {
		return nil, errors.New("Waiting for GitHub reconciliation integration")
	}
	observed, appliedClose, err := p.Lookup(st, ctx, item, op)
	if op.Kind == "merge" {
		return st.recoverMerge(ctx, item, op, observed, err)
	}
	if err != nil {
		return nil, err
	}
	if mythicalNoPRPushLease(item, op) && observed != item.PRHead && observed != op.Desired {
		return nil, errors.New("the pre-PR branch moved after its recorded observation; waiting for fetched refs")
	}
	op.State = outboundResult(op, observed, appliedClose)
	if op.Kind == "body" && op.State == "conflict" {
		st.s.logger.Info("mythical.review_body_conflict", "item", uuidString(item.ID), "expected", op.Precondition, "observed", observed, "desired", op.Desired)
		// A person edited the body or the pull request closed: nothing is
		// written, and the verdict stays on the card.
		return st.yieldBody(ctx, item)
	}
	if op.State == "conflict" && mythicalNoPRPushLease(item, op) && observed == item.PRHead {
		return st.finishNoPRPushConflict(ctx, item, op, observed)
	}
	if op.State == "conflict" && mythicalPublishes(op.Kind) {
		// The branch holds a head Smithers neither recorded nor published: a
		// person's push, held exactly as one found before the push.
		return st.saveOutboundForeignWait(ctx, item, &mythicalForeignHead{Branch: op.Target, Head: observed})
	}
	if op.State == "intended" {
		// Drop retains uncertain effects for lookup, but never authorizes another
		// proposal. Its owner must settle the terminal close obligation first.
		if (item.State == "cancelled" || item.State == "dropped") && (op.Kind == "push" || op.Kind == "open" || op.Kind == "body" || op.Kind == "draft") {
			// An in-flight request may still apply after this read. Retain
			// the uncertain slot; Drop never authorizes a proposal repeat.
			return nil, errors.New("dropped proposal cannot be repeated")
		}
		if err := st.s.outboundReady(ctx, item, op.Kind); err != nil {
			return nil, err
		}
		if p.Send == nil {
			return nil, errors.New("Waiting for GitHub dispatch integration")
		}
		if op.Kind != "push" && p.Settle == nil {
			return nil, errors.New("Waiting for GitHub settlement integration")
		}
		op.State = "unknown"
		item.PendingOp, _ = json.Marshal(op)
		item, err = st.q.SaveMythicalItemUnderLease(ctx, item, st.r.row.Claim)
		if err != nil {
			return nil, err
		}
		if err := p.Send(st, ctx, item, op); err != nil {
			if errors.Is(err, errMythicalBodyStale) || errors.Is(err, errMythicalPlacementStale) {
				// Nothing was sent: the gate prepares the body again.
				item.PendingOp = nil
				saved, saveErr := st.q.SaveMythicalItemUnderLease(ctx, item, st.r.row.Claim)
				return &saved, saveErr
			}
			return nil, &mythicalOutboundUncertainError{err}
		}
		// A successful response still needs lookup before settlement. This retains
		// the obligation if the process dies after the remote effect.
		return &item, nil
	}
	if op.State == "done" {
		return st.settleOutbound(ctx, item, op)
	}
	item.PendingOp, _ = json.Marshal(op)
	saved, err := st.q.SaveMythicalItemUnderLease(ctx, item, st.r.row.Claim)
	return &saved, err
}

// A queued/starting ref observation may record a newer pre-PR lease without
// replacing the outstanding push. Only a fresh lookup matching that recorded
// lease resolves the old push as a conflict; it never repeats that intent.
func mythicalNoPRPushLease(item db.MythicalItem, op MythicalOutboundOp) bool {
	checks := mythicalChecksOf(item)
	if op.Kind != "push" || item.PRNumber.Valid || item.PRState != "" ||
		item.State == "cancelled" || item.State == "dropped" || mythicalSettledStates[item.State] ||
		!checks.Todo || !mythicalTodoBranchValid(checks.Branch) || op.Target != checks.Branch ||
		!mythicalSHA.MatchString(item.PRHead) || strings.Trim(item.PRHead, "0") == "" ||
		item.PRHead == op.Desired || item.PRHead == op.Precondition || checks.ForeignHead != "" {
		return false
	}
	for _, wait := range todoOpenWaits(item) {
		if wait.Kind == "foreign_push" {
			return false
		}
	}
	return true
}

func (st *mythicalItemStep) finishNoPRPushConflict(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp, observed string) (*db.MythicalItem, error) {
	// The receipt and slot release share the same live stack lease and item CAS.
	// Rollback retains the unresolved intent; replay cannot discard a newer one.
	var saved db.MythicalItem
	err := pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
		next := item
		next.PendingOp = nil
		var err error
		saved, err = db.New(tx).SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
		if err != nil {
			return err
		}
		data, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "operation": op, "observed": observed, "outcome": "conflict"})
		if _, err = st.s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.github_operation_conflict", todoState(saved), data); err != nil {
			return err
		}
		var live bool
		if err = tx.QueryRow(ctx, `SELECT running AND claim=$2 AND lease_expires_at>clock_timestamp() FROM mythical_stacks WHERE repository_id=$1`, item.RepositoryID, st.r.row.Claim).Scan(&live); err != nil {
			return err
		}
		if !live {
			return db.ErrMythicalLeaseLost
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &saved, nil
}

func (st *mythicalItemStep) settleOutbound(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (*db.MythicalItem, error) {
	next := item
	if op.Kind == "push" {
		next.PRHead = op.Desired
		checks := mythicalChecksOf(next)
		if review := checks.Review; review != nil && review.Rebase != nil && review.Rebase.Candidate == next.CandidateHead && review.Rebase.Base == next.CandidateBase && review.Rebase.PatchID != "" {
			review.Rebase.Head = op.Desired
			next.Checks = checks.encode()
		}
	} else {
		// Open binds the discovered PR; merge waits for main containment and its
		// fenced inbound transaction; Drop records the outstanding close. None
		// can be invented from a transport response or a head alone.
		settle := st.s.outbound.Settle
		if settle == nil {
			return nil, errors.New("Waiting for GitHub settlement integration")
		}
		var err error
		next, err = settle(st, ctx, item, op)
		if err != nil {
			return nil, err
		}
		if next.ID != item.ID || next.RepositoryID != item.RepositoryID || next.Version != item.Version {
			return nil, errors.New("GitHub settlement changed item identity or version")
		}
		if (item.State == "cancelled" || item.State == "dropped") && next.State != item.State {
			return nil, errors.New("GitHub settlement changed dropped item state")
		}
	}
	next.PendingOp = nil
	if op.Kind != "close" {
		next = mythicalDropObligation(next)
	}
	if !mythicalTodo(item) || !item.Number.Valid {
		saved, err := st.q.SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
		return &saved, err
	}
	// A live TODO subscription advances only when its durable stream does.
	// Commit the confirmed state and its fact together; an event failure keeps
	// the pending intent so recovery can settle without repeating GitHub's write.
	var saved db.MythicalItem
	err := pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
		var err error
		saved, err = db.New(tx).SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
		if err != nil {
			return err
		}
		if saved.State == "landed" && item.State != "landed" {
			if err = st.s.admitLearningInTx(ctx, tx, saved); err != nil {
				return err
			}
		}
		data, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": item.Number.Int64, "operation": op, "from": todoState(item), "to": todoState(saved), "actor": map[string]any{"kind": "system", "id": "stack"}, "merge_commit": saved.PRMergeCommit})
		if _, err = st.s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.github_operation_settled", todoState(saved), data); err != nil {
			return err
		}
		var live bool
		if err = tx.QueryRow(ctx, `SELECT running AND claim=$2 AND lease_expires_at>clock_timestamp() FROM mythical_stacks WHERE repository_id=$1`, item.RepositoryID, st.r.row.Claim).Scan(&live); err != nil {
			return err
		}
		if !live {
			return db.ErrMythicalLeaseLost
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &saved, nil
}

// yieldBody drops a "body" operation that must not be sent; the current
// head's verdict counts as posted, so the gate does not prepare it again.
func (st *mythicalItemStep) yieldBody(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	next := item
	next.PendingOp = nil
	checks := mythicalChecksOf(next)
	if op, err := decodeMythicalOutbound(item.PendingOp); err == nil {
		checks.PRBodyDeclined = op.Desired
	}
	if checks.Review != nil && mythicalReviewCurrent(checks.Review, next) {
		checks.Review.Posted = true
	}
	next.Checks = checks.encode()
	next = mythicalDropObligation(next)
	saved, err := st.q.SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
	return &saved, err
}

// Queue Drop's close only after the previous slot is settled; a late-opened
// PR is bound before this runs. No operation is ever overwritten.
func mythicalDropObligation(item db.MythicalItem) db.MythicalItem {
	checks := mythicalChecksOf(item)
	if len(item.PendingOp) == 0 && ((item.State == "cancelled" || item.State == "dropped") && checks.Dropped != nil || item.State == "landed" && checks.MergedVia != nil) && item.PRNumber.Valid && item.PRState == "open" {
		item.PendingOp, _ = json.Marshal(MythicalOutboundOp{Kind: "close", Target: fmt.Sprint(item.PRNumber.Int64), Desired: "closed", Precondition: "open", State: "intended"})
	}
	return item
}

func (st *mythicalItemStep) saveOutboundForeignWait(ctx context.Context, item db.MythicalItem, foreign *mythicalForeignHead) (*db.MythicalItem, error) {
	held := st.holdForeignHead(item, foreign)
	var saved db.MythicalItem
	err := pgx.BeginFunc(ctx, st.s.store, func(tx pgx.Tx) error {
		var err error
		saved, err = db.New(tx).SaveMythicalItemUnderLease(ctx, *held, st.r.row.Claim)
		if err != nil {
			return err
		}
		if mythicalTodo(item) && todoState(item) != todoState(saved) {
			data, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": mythicalItemNumber(item), "from": todoState(item), "to": todoState(saved), "sha": foreign.Head})
			_, err = st.s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.foreign_push", todoState(saved), data)
		}
		return err
	})
	return &saved, err
}
