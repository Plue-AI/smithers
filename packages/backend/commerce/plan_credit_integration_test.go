package commerce_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/credits"
)

type subscriptionTransport struct {
	commerce.Client
	owner  int64
	status string
	end    time.Time
}

func (p *subscriptionTransport) GetSubscription(context.Context, string) (commerce.SubscriptionSnapshot, error) {
	return commerce.SubscriptionSnapshot{ID: "sub_plan", CustomerID: "cus_plan", PriceID: "price_pro", Interval: "monthly", Status: p.status,
		Quantity: 1, CurrentPeriodEnd: p.end, RawPayload: []byte(`{}`),
		Metadata: map[string]string{"owner_type": "user", "owner_id": fmt.Sprint(p.owner)}}, nil
}

// Plan credit follows paid invoices, never a balance read: once per invoice,
// capped at the amount paid, forfeited on refund and on cancellation
// (smithersai/plue#528, plue 4053bc1c4).
func TestPlanCreditFollowsPaidInvoices(t *testing.T) {
	pool := database(t)
	ctx := context.Background()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	transport := &subscriptionTransport{owner: owner, status: "active", end: end}
	const secret = "test-only-plan-credit-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"},
		WebhookSecret: secret, MonthlyCreditGrantCents: 5000, SignupCreditGrantCents: 1000})
	require.NoError(t, err)
	// Stripe stamps every event with its creation time; each delivery here
	// happens a minute after the previous one.
	clock := time.Now().Add(-time.Hour)
	deliver := func(event, kind, object string) {
		clock = clock.Add(time.Minute)
		payload := []byte(fmt.Sprintf(`{"id":%q,"type":%q,"created":%d,"data":{"object":%s}}`, event, kind, clock.Unix(), object))
		now := time.Now().Unix()
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%d.%s", now, payload)
		require.NoError(t, api.HandleStripeWebhook(ctx, payload, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))))
	}
	invoice := func(event, id string, paid int64, periodEnd time.Time) {
		deliver(event, "invoice.paid", fmt.Sprintf(`{"id":%q,"customer":"cus_plan","amount_paid":%d,"currency":"usd",
			"parent":{"subscription_details":{"subscription":"sub_plan"}},"lines":{"data":[{"period":{"start":%d,"end":%d}}]}}`,
			id, paid, time.Now().Unix(), periodEnd.Unix()))
	}
	ledger := api.CreditLedger()
	balance := func() int64 {
		n, err := ledger.OwnerBalance(ctx, "user", owner)
		require.NoError(t, err)
		return n / credits.NanosPerCent
	}

	// The first paid invoice projects the subscription, opens the account
	// with its signup grant, and adds the plan credit until the period ends.
	invoice("evt_in1", "in_1", 5000, end)
	require.Equal(t, int64(6000), balance())
	var expires time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at FROM credit_grants WHERE source_key = 'invoice:in_1'`).Scan(&expires))
	require.True(t, expires.Equal(end), "plan credit expires at the invoice's period end")

	// Redelivery, a $0 invoice, a read, and an ended period grant nothing.
	invoice("evt_in1_again", "in_1", 5000, end)
	invoice("evt_trial", "in_0", 0, end)
	invoice("evt_old", "in_old", 5000, time.Now().Add(-time.Hour))
	_, err = api.GetUserOverview(ctx, &commerce.User{ID: owner})
	require.NoError(t, err)
	require.Equal(t, int64(6000), balance())

	// A discounted invoice is capped at what it collected.
	invoice("evt_in2", "in_2", 1200, end)
	require.Equal(t, int64(7200), balance())

	worker, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"}})
	require.NoError(t, err)
	plan := func() string {
		entitlement, err := worker.SandboxEntitlement(ctx, owner)
		require.NoError(t, err)
		return entitlement.PlanKey
	}
	paid := func() bool {
		ok, err := api.OwnerHasPaidPlan(ctx, "user", owner)
		require.NoError(t, err)
		return ok
	}
	require.Equal(t, "pro", plan())
	require.True(t, paid())

	// A refund forfeits the unspent plan credit, the signup grant stays, and
	// paid entitlements are suspended while the provider still reports the
	// subscription active (plue 0511eb46e).
	deliver("evt_refund", "charge.refunded", `{"id":"ch_1","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}`)
	require.Equal(t, int64(1000), balance())
	require.Equal(t, "free", plan())
	require.False(t, paid())
	deliver("evt_still_active", "customer.subscription.updated", `{"id":"sub_plan","customer":"cus_plan"}`)
	require.Equal(t, "free", plan(), "a later subscription event does not clear the reversal")

	// The next paid invoice restores the plan and grants its credit.
	invoice("evt_in3", "in_3", 5000, end)
	require.Equal(t, int64(6000), balance())
	require.Equal(t, "pro", plan())
	require.True(t, paid())

	// Cancellation forfeits that credit too.
	transport.status = "canceled"
	deliver("evt_canceled", "customer.subscription.updated", `{"id":"sub_plan","customer":"cus_plan"}`)
	require.Equal(t, int64(1000), balance())
}

// Stripe delivers events out of order and retries failed ones for days, so a
// refund or dispute only suspends payments settled before it, and only a
// payment settled after it restores the plan, in either arrival order
// (smithersai/smithers#2175).
func TestPaymentReversalFollowsSettlementOrder(t *testing.T) {
	pool := database(t)
	ctx := context.Background()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	transport := &subscriptionTransport{owner: owner, status: "active", end: end}
	const secret = "test-only-plan-credit-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"},
		WebhookSecret: secret, MonthlyCreditGrantCents: 5000, SignupCreditGrantCents: 1000})
	require.NoError(t, err)
	deliver := func(event, kind string, created time.Time, object string) {
		payload := []byte(fmt.Sprintf(`{"id":%q,"type":%q,"created":%d,"data":{"object":%s}}`, event, kind, created.Unix(), object))
		now := time.Now().Unix()
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%d.%s", now, payload)
		require.NoError(t, api.HandleStripeWebhook(ctx, payload, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))))
	}
	invoice := func(event, id string, paidAt time.Time) {
		deliver(event, "invoice.paid", paidAt, fmt.Sprintf(`{"id":%q,"customer":"cus_plan","amount_paid":5000,"currency":"usd",
			"status_transitions":{"paid_at":%d},"parent":{"subscription_details":{"subscription":"sub_plan"}},
			"lines":{"data":[{"period":{"start":%d,"end":%d}}]}}`, id, paidAt.Unix(), paidAt.Unix(), end.Unix()))
	}
	refund := func(event string, at time.Time) {
		deliver(event, "charge.refunded", at, `{"id":"ch_1","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}`)
	}
	balance := func() int64 {
		n, err := api.CreditLedger().OwnerBalance(ctx, "user", owner)
		require.NoError(t, err)
		return n / credits.NanosPerCent
	}
	paid := func() bool {
		ok, err := api.OwnerHasPaidPlan(ctx, "user", owner)
		require.NoError(t, err)
		return ok
	}
	base := time.Now().Add(-time.Hour).Truncate(time.Second)

	invoice("evt_in1", "in_1", base)
	require.Equal(t, int64(6000), balance())

	// in_2 was paid, its first delivery failed, and it was refunded before
	// Stripe's retry arrived: the retry neither restores nor grants.
	refund("evt_refund_in2", base.Add(20*time.Minute))
	require.False(t, paid())
	invoice("evt_in2_retry", "in_2", base.Add(10*time.Minute))
	require.False(t, paid(), "a payment settled before the refund does not restore the plan")
	require.Equal(t, int64(1000), balance(), "a refunded invoice grants no credit")

	// A payment settled after the refund restores the plan and grants.
	invoice("evt_in3", "in_3", base.Add(30*time.Minute))
	require.True(t, paid())
	require.Equal(t, int64(6000), balance())

	// A refund issued before in_3 settled but delivered after it does not
	// suspend the plan in_3 paid for.
	refund("evt_refund_late", base.Add(25*time.Minute))
	require.True(t, paid(), "a reversal older than the latest settled payment does not suspend")
	require.Equal(t, int64(6000), balance(), "nor forfeit the credit that payment bought")

	// An invoice settled before a reversal grants nothing even after a later
	// payment restored the plan.
	invoice("evt_in2b_retry", "in_2b", base.Add(15*time.Minute))
	require.Equal(t, int64(6000), balance())

	// A payment with no settlement time restores nothing.
	refund("evt_refund_in3", base.Add(40*time.Minute))
	require.False(t, paid())
	deliver("evt_untimed", "invoice.paid", time.Time{}, fmt.Sprintf(`{"id":"in_untimed","customer":"cus_plan","amount_paid":5000,
		"currency":"usd","parent":{"subscription_details":{"subscription":"sub_plan"}},"lines":{"data":[{"period":{"end":%d}}]}}`, end.Unix()))
	require.False(t, paid())
	require.Equal(t, int64(1000), balance())
}
