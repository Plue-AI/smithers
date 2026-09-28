package services

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type countingCreditLedger struct {
	*fakeCreditLedger
	ensureCalls int
}

func (l *countingCreditLedger) EnsureAccount(ctx context.Context, ownerType string, ownerID int64) (int64, error) {
	l.ensureCalls++
	return l.fakeCreditLedger.EnsureAccount(ctx, ownerType, ownerID)
}

func TestBillingServiceInvoiceCreditConvertsOnlyTheCappedAmount(t *testing.T) {
	const largestSafeCents int64 = 922_337_203_685
	now := time.Date(2026, time.September, 27, 12, 0, 0, 0, time.UTC)
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42}
	subscription := db.BillingSubscription{
		BillingAccountID: account.ID,
		Status:           "active",
		PlanKey:          BillingPlanPro,
		CurrentPeriodEnd: pgtype.Timestamptz{Time: now.Add(30 * 24 * time.Hour), Valid: true},
	}
	for _, tc := range []struct {
		name    string
		monthly int64
		paid    int64
		want    int64
		refused bool
	}{
		{"one cent beyond safe amount", 922_337_203_686, 922_337_203_686, 0, true},
		{"extreme unsafe amount", math.MaxInt64, math.MaxInt64, 0, true},
		{"large config capped by small invoice", math.MaxInt64, 100, 1_000_000_000, false},
		{"one cent beyond config capped by safe invoice", 922_337_203_686, largestSafeCents, 9_223_372_036_850_000_000, false},
		{"safe config caps large invoice", largestSafeCents, math.MaxInt64, 9_223_372_036_850_000_000, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ledger := &countingCreditLedger{fakeCreditLedger: newFakeCreditLedger()}
			service := NewBillingService(
				newBillingQuerierMock(), nil,
				BillingServiceConfig{MonthlyCreditGrantCents: tc.monthly, ProMonthlyPriceID: "price_pro"},
				WithBillingCreditLedger(ledger),
			)
			service.now = func() time.Time { return now }
			invoice := stripeInvoicePaidPayload{ID: "in_boundary", AmountPaid: tc.paid}
			err := service.grantInvoiceCredit(context.Background(), account, &subscription, invoice)
			if tc.refused {
				require.ErrorContains(t, err, "invalid plan credit grant")
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.EqualError(t, apiErr.Cause(), "credits: cents cannot be represented as non-negative nanos")
				require.Zero(t, ledger.ensureCalls)
				require.Empty(t, ledger.accounts)
				require.Empty(t, ledger.grants)
				return
			}
			require.NoError(t, err)
			require.Equal(t, 1, ledger.ensureCalls)
			require.Equal(t, tc.want, ledger.grants[1]["invoice:in_boundary"])
		})
	}

	// An expired invoice would issue no grant. Its amount is irrelevant and
	// must not open a credit account even when its conversion would overflow.
	ledger := &countingCreditLedger{fakeCreditLedger: newFakeCreditLedger()}
	service := NewBillingService(newBillingQuerierMock(), nil,
		BillingServiceConfig{MonthlyCreditGrantCents: math.MaxInt64, ProMonthlyPriceID: "price_pro"},
		WithBillingCreditLedger(ledger))
	service.now = func() time.Time { return now }
	expired := subscription
	expired.CurrentPeriodEnd = pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true}
	require.NoError(t, service.grantInvoiceCredit(context.Background(), account, &expired,
		stripeInvoicePaidPayload{ID: "in_expired", AmountPaid: math.MaxInt64}))
	require.Zero(t, ledger.ensureCalls)
	require.Empty(t, ledger.accounts)
}
