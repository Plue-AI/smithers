package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Plan credit rules (smithersai/plue#528, ported from plue 4053bc1c4):
//
//   - A paid subscription invoice (invoice.paid) grants MonthlyCreditGrantCents
//     once per invoice id, capped at the invoice's amount paid. A $0 invoice
//     (trial, full discount) grants nothing.
//   - The grant expires at the end of the period the invoice pays for. There
//     is no rollover. The ledger spends the soonest-expiring credit first, so
//     plan credit goes before the signup grant.
//   - Unspent plan credit is forfeited when a webhook leaves the account
//     with no active or trialing subscription, and on a refund or dispute.
//     Grants and forfeits commit in the webhook's transaction; a billing read
//     never forfeits (smithersai/smithers#2175). A refund or dispute
//     also suspends the account's paid entitlements
//     (billing_subscriptions.payment_reversed_at) until an invoice settled
//     after it is paid (plue 0511eb46e, smithersai/smithers#2175).
//
// Calendar-month grants (monthly_grant:YYYY-MM) issued before this rule are
// left as they are.

// planCreditKeyPrefix names every plan-credit grant: "invoice:<invoice id>".
const planCreditKeyPrefix = "invoice:"

// StripeWebhookEvents is every event the billing webhook handles. The
// deployment's Stripe endpoint must subscribe to exactly these.
var StripeWebhookEvents = []string{
	"checkout.session.completed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.trial_will_end",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.updated",
	"charge.refunded",
	"charge.dispute.created",
	"entitlements.active_entitlement_summary.updated",
}

// planCreditSpendable reports whether plan credit may be spent: the
// subscription is active or trialing. past_due keeps sandbox access through
// the dunning grace period, but not the credit a paid invoice bought.
func planCreditSpendable(subscription *db.BillingSubscription) bool {
	if subscription == nil || subscription.PaymentReversedAt.Valid {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(subscription.Status)) {
	case "active", "trialing":
		return true
	default:
		return false
	}
}

// forfeitPlanCredit removes the account's unspent plan credit from its balance.
func (s *BillingService) forfeitPlanCredit(ctx context.Context, account db.BillingAccount, reason string) error {
	if s.credits == nil {
		return nil
	}
	taken, err := s.credits.Forfeit(ctx, account.OwnerType, account.OwnerID, planCreditKeyPrefix)
	if err != nil {
		return pkgerrors.Internal("failed to forfeit plan credit").WithCause(err)
	}
	if taken > 0 {
		slog.Info("plan credit forfeited", "billing_account_id", account.ID, "nanos", taken, "reason", reason)
	}
	return nil
}

// forfeitLapsedPlanCredit forfeits the plan credit of an account whose latest
// live subscription can no longer spend it.
func (s *BillingService) forfeitLapsedPlanCredit(ctx context.Context, account db.BillingAccount) error {
	if s.credits == nil {
		return nil
	}
	row, err := s.queries.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to load billing subscription").WithCause(err)
	}
	if err == nil && planCreditSpendable(&row) {
		return nil
	}
	return s.forfeitPlanCredit(ctx, account, "subscription not active")
}

// stripeInvoicePaidPayload is the part of an invoice.paid event the grant
// needs. Since API version 2025-03-31 (Basil) the subscription id lives under
// parent.subscription_details; older payloads carry it at the top level.
type stripeInvoicePaidPayload struct {
	ID           string `json:"id"`
	Customer     string `json:"customer"`
	AmountPaid   int64  `json:"amount_paid"`
	Currency     string `json:"currency"`
	Subscription string `json:"subscription"`
	// StatusTransitions.PaidAt is when the invoice settled.
	StatusTransitions struct {
		PaidAt int64 `json:"paid_at"`
	} `json:"status_transitions"`
	Parent struct {
		SubscriptionDetails struct {
			Subscription string `json:"subscription"`
		} `json:"subscription_details"`
	} `json:"parent"`
	Lines struct {
		Data []struct {
			Period struct {
				Start int64 `json:"start"`
				End   int64 `json:"end"`
			} `json:"period"`
		} `json:"data"`
	} `json:"lines"`
}

func (p stripeInvoicePaidPayload) subscriptionID() string {
	if id := strings.TrimSpace(p.Parent.SubscriptionDetails.Subscription); id != "" {
		return id
	}
	return strings.TrimSpace(p.Subscription)
}

// periodEnd is the end of the span the invoice's lines pay for.
func (p stripeInvoicePaidPayload) periodEnd() time.Time {
	var end time.Time
	for _, line := range p.Lines.Data {
		if t := unixToTime(line.Period.End); t.After(end) {
			end = t
		}
	}
	return end
}

// handleInvoicePaid records the settled payment and grants the plan credit a
// paid subscription invoice buys. A failure returns an error so Stripe
// redelivers; the grant is idempotent per invoice id.
func (s *BillingService) handleInvoicePaid(ctx context.Context, invoice stripeInvoicePaidPayload, occurred time.Time) error {
	subscriptionID := invoice.subscriptionID()
	invoiceID := strings.TrimSpace(invoice.ID)
	if subscriptionID == "" || invoiceID == "" || invoice.AmountPaid <= 0 {
		return nil // a one-off invoice, or a $0 invoice that bought no credit
	}
	account, err := s.findBillingAccountByCustomerID(ctx, invoice.Customer)
	if err != nil {
		return err
	}
	var providerStatus string
	var snapshotObservedAt time.Time
	if s.stripe != nil {
		// invoice.paid can arrive before the subscription events; project the
		// authoritative subscription first so its plan and status are known.
		snapshot, err := s.fetchSubscription(ctx, subscriptionID)
		if err != nil {
			return pkgerrors.Internal("failed to load stripe subscription for paid invoice").WithCause(err)
		}
		providerStatus, snapshotObservedAt = snapshot.Status, snapshot.observedAt
		if account == nil {
			owner, ok := ownerFromMetadata(snapshot.Metadata)
			if !ok {
				return nil
			}
			row, err := s.upsertBillingAccount(ctx, owner, invoice.Customer, "", "")
			if err != nil {
				return err
			}
			account = &row
		}
		if err := s.projectWebhookSubscription(ctx, *account, snapshot); err != nil {
			return err
		}
	}
	if account == nil {
		return nil
	}
	rows, err := s.queries.ListBillingSubscriptionsByAccount(ctx, account.ID)
	if err != nil {
		return pkgerrors.Internal("failed to load billing subscriptions").WithCause(err)
	}
	var subscription *db.BillingSubscription
	for i := range rows {
		if rows[i].StripeSubscriptionID == subscriptionID {
			subscription = &rows[i]
			break
		}
	}
	if subscription == nil {
		// Not projected yet; fail so Stripe retries after the subscription event.
		return pkgerrors.Internal("paid invoice " + invoiceID + " references unknown subscription " + subscriptionID)
	}
	// Only a payment settled after a refund or dispute restores the
	// subscription it suspended; a late retry of an earlier (possibly the
	// refunded) invoice leaves it suspended and grants nothing.
	// A payment with no settlement time is recorded as settled at no known
	// time: it restores nothing and grants nothing after a reversal.
	settledAt := unixToTime(invoice.StatusTransitions.PaidAt)
	if settledAt.IsZero() {
		settledAt = occurred
	}
	settled, err := s.queries.SettleBillingSubscriptionPayment(ctx, db.SettleBillingSubscriptionPaymentParams{
		SettledAt:      pgtype.Timestamptz{Time: settledAt, Valid: !settledAt.IsZero()},
		ProviderStatus: providerStatus, SnapshotObservedAt: nullableTimestamptz(snapshotObservedAt),
		BillingAccountID: account.ID, StripeSubscriptionID: subscriptionID,
	})
	if err != nil {
		return pkgerrors.Internal("failed to record settled subscription payment").WithCause(err)
	}
	if reversed := account.LastPaymentReversedAt; reversed.Valid && !settledAt.After(reversed.Time) {
		// Settled before a refund or dispute (possibly the refunded invoice
		// itself, retried after a later invoice restored the plan).
		slog.Info("paid invoice settled before a payment reversal; no plan credit granted", "invoice_id", invoiceID, "billing_account_id", account.ID)
		return nil
	}
	return s.grantInvoiceCredit(ctx, *account, &settled, invoice)
}

// reversePayment handles a refund or dispute: the unspent plan credit is
// forfeited and the account's live subscriptions lose paid entitlements until
// an invoice settled after the reversal is paid. A reversal older than a
// subscription's latest settled payment does not suspend it.
func (s *BillingService) reversePayment(ctx context.Context, account db.BillingAccount, reason string, occurred time.Time) error {
	reversedAt := pgtype.Timestamptz{Time: s.eventTime(occurred), Valid: true}
	if err := s.queries.RecordBillingAccountPaymentReversal(ctx, db.RecordBillingAccountPaymentReversalParams{
		ReversedAt: reversedAt, BillingAccountID: account.ID,
	}); err != nil {
		return pkgerrors.Internal("failed to record payment reversal").WithCause(err)
	}
	suspended, err := s.queries.MarkBillingSubscriptionsPaymentReversed(ctx, db.MarkBillingSubscriptionsPaymentReversedParams{
		ReversedAt: reversedAt, BillingAccountID: account.ID,
	})
	if err != nil {
		return pkgerrors.Internal("failed to suspend reversed subscription").WithCause(err)
	}
	if suspended == 0 {
		// No live subscription, or a later payment settled: the credit that
		// payment bought stays. A lapsed subscription's credit was forfeited
		// when it lapsed.
		return nil
	}
	return s.forfeitPlanCredit(ctx, account, reason)
}

// eventTime is when a Stripe event happened, or now when the payload has no
// creation time.
func (s *BillingService) eventTime(occurred time.Time) time.Time {
	if occurred.IsZero() {
		return s.now()
	}
	return occurred
}

// OwnerHasPaidPlan reports whether an owner's latest live subscription grants
// paid entitlements.
func (s *BillingService) OwnerHasPaidPlan(ctx context.Context, ownerType string, ownerID int64) (bool, error) {
	account, err := s.findBillingAccountByOwner(ctx, ownerType, ownerID)
	if err != nil || account == nil {
		return false, err
	}
	row, err := s.queries.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, pkgerrors.Internal("failed to load billing subscription").WithCause(err)
	}
	return s.subscriptionGrantsPaidAccess(&row), nil
}

// grantInvoiceCredit grants the plan credit one paid invoice bought.
func (s *BillingService) grantInvoiceCredit(ctx context.Context, account db.BillingAccount, subscription *db.BillingSubscription, invoice stripeInvoicePaidPayload) error {
	if s.credits == nil || s.config.MonthlyCreditGrantCents <= 0 || !planCreditSpendable(subscription) {
		return nil
	}
	if s.planForSubscription(account.OwnerType, subscription).Key == BillingPlanFree {
		return nil
	}
	cents := min(s.config.MonthlyCreditGrantCents, invoice.AmountPaid)
	periodEnd := invoice.periodEnd()
	if periodEnd.IsZero() && subscription.CurrentPeriodEnd.Valid {
		periodEnd = subscription.CurrentPeriodEnd.Time
	}
	if periodEnd.IsZero() {
		return pkgerrors.Internal("paid invoice " + invoice.ID + " has no service period")
	}
	if !periodEnd.After(s.now()) {
		slog.Warn("paid invoice period already ended; no plan credit granted", "invoice_id", invoice.ID, "period_end", periodEnd)
		return nil
	}
	nanos, err := credits.NanosFromCents(cents)
	if err != nil {
		return pkgerrors.Internal("invalid plan credit grant").WithCause(err)
	}
	accountID, err := s.credits.EnsureAccount(ctx, account.OwnerType, account.OwnerID)
	if err != nil {
		return pkgerrors.Internal("failed to open credit account").WithCause(err)
	}
	err = s.credits.Grant(ctx, accountID, planCreditKeyPrefix+strings.TrimSpace(invoice.ID), nanos, &periodEnd)
	if err != nil && !stdErrors.Is(err, credits.ErrConflict) {
		// ErrConflict: this invoice was granted before (and since forfeited).
		return pkgerrors.Internal("failed to record plan credit grant").WithCause(err)
	}
	return nil
}
