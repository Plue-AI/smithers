package services

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// PlanGrant is an operator's immutable comp and audit receipt. Pro and Max
// belong to user owners. It grants no invoice credit or Stripe subscription.
type PlanGrant struct {
	OwnerType string
	OwnerID   int64
	PlanKey   string
	Key       string
	ExpiresAt time.Time
	Actor     string
	Reason    string
}

// Validate checks required inputs before a caller opens a database. Expiry is
// checked when inserting, so an identical replay remains valid after expiry.
func (g PlanGrant) Validate() error {
	if strings.TrimSpace(g.Actor) == "" {
		return errors.New("plans: -actor is required")
	}
	if strings.TrimSpace(g.Reason) == "" {
		return errors.New("plans: -reason is required")
	}
	if strings.TrimSpace(g.Key) == "" {
		return errors.New("plans: -key is required")
	}
	if g.OwnerType != BillingOwnerTypeUser || g.OwnerID <= 0 {
		return errors.New("plans: -owner must be an existing user")
	}
	if g.PlanKey != BillingPlanPro && g.PlanKey != BillingPlanMax {
		return errors.New("plans: -plan must be pro or max")
	}
	if g.ExpiresAt.IsZero() {
		return errors.New("plans: -expires is required")
	}
	return nil
}

// GrantPlan atomically stores one comp and one audit receipt (the same row).
// It is process-operator authority, never an unauthenticated HTTP operation.
// Reusing a key with different metadata fails without altering the original.
func (s *BillingService) GrantPlan(ctx context.Context, g PlanGrant) error {
	if err := g.Validate(); err != nil {
		return err
	}
	g.Actor, g.Reason, g.Key = strings.TrimSpace(g.Actor), strings.TrimSpace(g.Reason), strings.TrimSpace(g.Key)
	g.ExpiresAt = g.ExpiresAt.UTC().Truncate(time.Microsecond)
	txq, ok := s.queries.(billingTxQuerier)
	if !ok {
		return errors.New("plans: transactional database required")
	}
	tx, err := txq.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	// Lock the owner to serialize distinct keys as well as exact replays, and
	// prevent a concurrently deleted user from leaving a grant behind.
	var ownerID int64
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, g.OwnerID).Scan(&ownerID); err != nil {
		return err
	}
	prior, err := q.GetBillingPlanGrantByKey(ctx, db.GetBillingPlanGrantByKeyParams{
		OwnerType: g.OwnerType, OwnerID: g.OwnerID, SourceKey: g.Key,
	})
	if err == nil {
		if prior.PlanKey != g.PlanKey || !prior.ExpiresAt.Equal(g.ExpiresAt) || prior.Actor != g.Actor || prior.Reason != g.Reason {
			return credits.ErrConflict
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !g.ExpiresAt.After(s.now()) {
		return errors.New("plans: -expires must be in the future")
	}
	_, err = q.InsertBillingPlanGrant(ctx, db.InsertBillingPlanGrantParams{
		OwnerType: g.OwnerType, OwnerID: g.OwnerID, SourceKey: g.Key,
		PlanKey: g.PlanKey, ExpiresAt: g.ExpiresAt, Actor: g.Actor, Reason: g.Reason,
	})
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// compedPlan is used only when no live Stripe subscription exists. Payment
// reversal and dunning policy therefore cannot be bypassed by an older comp.
func (s *BillingService) compedPlan(ctx context.Context, owner billingOwnerRef) (billingPlanDefinition, error) {
	plan := s.defaultPlan(owner.OwnerType)
	grant, err := s.queries.GetActiveBillingPlanGrant(ctx, db.GetActiveBillingPlanGrantParams{
		OwnerType: owner.OwnerType, OwnerID: owner.OwnerID, AsOf: s.now(),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return plan, nil
	}
	if err != nil {
		return billingPlanDefinition{}, pkgerrors.Internal("failed to load plan grant").WithCause(err)
	}
	plan = s.checkoutPlans[owner.OwnerType][grant.PlanKey+":"+BillingIntervalMonthly]
	return plan, nil
}
