package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

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

// MythicalOutboundProviders are current, effect-free guards supplied by the
// owning dependencies. None may mint tokens. Missing wiring fails closed.
// Lookup returns the observed head/digest/lifecycle; AppliedClose must consult
// canonical-App events before current state (a person's reopen is not a retry).
// Send must use budgeted App transport and trusted bare-object tools only.
// Lookup, Send and Settle run within the claimed pass they are given, which
// holds its GitHub destination and bare-object transport; this is their one
// binding (EnableTodoPublication composes them for push and open).
// MergeDecision is T-STK-04's fresh DecideMerge under the matching TODO fence;
// its owner composes it together with the merge kind of Lookup, Send and
// Settle, and the merge route's gate opens only when both are composed.
type MythicalOutboundProviders struct {
	CanonicalApp, StackLease, Budget, Membership, Authorization, AcceptedGeneration func(context.Context, db.MythicalItem, string) error
	MergeDecision                                                                   func(context.Context, db.MythicalItem, MythicalOutboundOp) error
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
	case "push", "open", "body", "merge", "close":
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
func (st *mythicalItemStep) recoverOutbound(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	op, err := decodeMythicalOutbound(item.PendingOp)
	if err != nil {
		return nil, err
	}
	if op.State == "conflict" {
		if mythicalPublishes(op.Kind) {
			// Held for a person: nothing moves but the hold's notice, said once.
			held := st.s.deliverNotice(ctx, st.r, item)
			return &held, nil
		}
		return nil, errors.New("pending GitHub operation conflicts with a foreign change")
	}
	if op.State == "done" {
		return st.settleOutbound(ctx, item, op)
	}
	p := st.s.outbound
	if p.Lookup == nil {
		return nil, errors.New("Waiting for GitHub reconciliation integration")
	}
	observed, appliedClose, err := p.Lookup(st, ctx, item, op)
	if err != nil {
		return nil, err
	}
	op.State = outboundResult(op, observed, appliedClose)
	if op.State == "conflict" && mythicalPublishes(op.Kind) {
		// The branch holds a head Smithers neither recorded nor published: a
		// person's push, held exactly as one found before the push.
		held := st.holdForeignHead(item, &mythicalForeignHead{Branch: op.Target, Head: observed})
		saved, err := st.q.SaveMythicalItemUnderLease(ctx, *held, st.r.row.Claim)
		return &saved, err
	}
	if op.State == "intended" {
		// Drop retains uncertain effects for lookup, but never authorizes another
		// proposal. Its owner must settle the terminal close obligation first.
		if (item.State == "cancelled" || item.State == "dropped") && (op.Kind == "push" || op.Kind == "open" || op.Kind == "body") {
			return nil, errors.New("dropped proposal cannot be repeated")
		}
		if err := st.s.outboundReady(ctx, item, op.Kind); err != nil {
			return nil, err
		}
		if op.Kind == "merge" {
			if p.MergeDecision == nil {
				return nil, errors.New("Waiting for merge readiness integration")
			}
			if err := p.MergeDecision(ctx, item, op); err != nil {
				return nil, err
			}
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
			return nil, err
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

func (st *mythicalItemStep) settleOutbound(ctx context.Context, item db.MythicalItem, op MythicalOutboundOp) (*db.MythicalItem, error) {
	next := item
	if op.Kind == "push" {
		next.PRHead = op.Desired
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
	saved, err := st.q.SaveMythicalItemUnderLease(ctx, next, st.r.row.Claim)
	return &saved, err
}
