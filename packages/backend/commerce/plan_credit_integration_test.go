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

func (p *subscriptionTransport) ListActiveEntitlements(context.Context, string) ([]string, error) {
	return nil, nil
}

func (p *subscriptionTransport) GetCharge(context.Context, string) (commerce.ChargeSnapshot, error) {
	return commerce.ChargeSnapshot{CustomerID: "cus_plan"}, nil
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
	deliverWebhook := func(event, kind, object string) error {
		clock = clock.Add(time.Minute)
		payload := []byte(fmt.Sprintf(`{"id":%q,"type":%q,"created":%d,"data":{"object":%s}}`, event, kind, clock.Unix(), object))
		now := time.Now().Unix()
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%d.%s", now, payload)
		return api.HandleStripeWebhook(ctx, payload, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil)))
	}
	deliver := func(event, kind, object string) {
		t.Helper()
		require.NoError(t, deliverWebhook(event, kind, object))
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
	status := func() string {
		var value string
		require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&value))
		return value
	}
	require.Equal(t, "pro", plan())
	require.True(t, paid())

	// Spend part of the expiring plan grant before the refund. Reversal
	// removes only the remainder and must not create debt for spent credit.
	creditAccount, err := ledger.EnsureAccount(ctx, "user", owner)
	require.NoError(t, err)
	_, err = ledger.Reserve(ctx, creditAccount, "model-before-refund", 700*credits.NanosPerCent)
	require.NoError(t, err)
	_, err = ledger.Settle(ctx, creditAccount, "model-before-refund", 700*credits.NanosPerCent)
	require.NoError(t, err)
	require.Equal(t, int64(6500), balance())

	// A failed webhook commit must roll back both suspension and credit
	// forfeiture, so the same Stripe event remains safe to retry.
	_, err = pool.Exec(ctx, `
		CREATE FUNCTION fail_reversal_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'reversal commit failed'; END $$;
		CREATE CONSTRAINT TRIGGER fail_reversal_commit AFTER INSERT ON stripe_processed_events
		DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_reversal_commit()`)
	require.NoError(t, err)
	require.Error(t, deliverWebhook("evt_refund", "charge.refunded", `{"id":"ch_1","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}`))
	require.Equal(t, "active", status())
	require.True(t, paid())
	require.Equal(t, int64(6500), balance())
	_, err = pool.Exec(ctx, `DROP TRIGGER fail_reversal_commit ON stripe_processed_events`)
	require.NoError(t, err)

	// A refund forfeits the unspent plan credit, the signup grant stays, and
	// paid entitlements are suspended while the provider still reports the
	// subscription active (plue 0511eb46e).
	deliver("evt_refund", "charge.refunded", `{"id":"ch_1","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}`)
	require.Equal(t, "past_due", status())
	require.Equal(t, int64(1000), balance())
	require.Equal(t, "free", plan())
	require.False(t, paid())
	var firstPastDue time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT past_due_since FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&firstPastDue))
	// Replay both the event ID and the underlying refund with a new ID.
	deliver("evt_refund", "charge.refunded", `{"id":"ch_1","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}`)
	deliver("evt_refund_replay", "charge.refunded", `{"id":"ch_1","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}`)
	require.Equal(t, "past_due", status())
	require.Equal(t, int64(1000), balance())
	var replayPastDue time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT past_due_since FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&replayPastDue))
	require.True(t, firstPastDue.Equal(replayPastDue), "replay must not restart past-due grace")
	deliver("evt_still_active", "customer.subscription.updated", `{"id":"sub_plan","customer":"cus_plan"}`)
	require.Equal(t, "past_due", status(), "an active Stripe snapshot must not clear a reversed payment")
	require.Equal(t, "free", plan(), "a later subscription event does not clear the reversal")

	// The next paid invoice restores the plan and grants its credit.
	invoice("evt_in3", "in_3", 5000, end)
	require.Equal(t, "active", status())
	require.Equal(t, int64(6000), balance())
	require.Equal(t, "pro", plan())
	require.True(t, paid())

	var pastDueCleared bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT past_due_since IS NULL FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&pastDueCleared))
	require.True(t, pastDueCleared)

	// A dispute has the same effect, including on redelivery.
	deliver("evt_dispute", "charge.dispute.created", `{"id":"dp_1","charge":"ch_2","amount":5000,"currency":"usd"}`)
	require.Equal(t, "past_due", status())
	require.Equal(t, int64(1000), balance())
	require.NoError(t, pool.QueryRow(ctx, `SELECT past_due_since FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&firstPastDue))
	deliver("evt_dispute", "charge.dispute.created", `{"id":"dp_1","charge":"ch_2","amount":5000,"currency":"usd"}`)
	require.Equal(t, "past_due", status())
	require.Equal(t, int64(1000), balance())
	deliver("evt_dispute_replay", "charge.dispute.created", `{"id":"dp_1","charge":"ch_2","amount":5000,"currency":"usd"}`)
	require.Equal(t, "past_due", status())
	require.Equal(t, int64(1000), balance())

	require.NoError(t, pool.QueryRow(ctx, `SELECT past_due_since FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&replayPastDue))
	require.True(t, firstPastDue.Equal(replayPastDue), "dispute replay must preserve past-due grace")

	// A payment while Stripe still reports past due clears the reversal,
	// but must neither restore paid credit nor reset the dunning period.
	transport.status = "past_due"
	invoice("evt_still_due", "in_still_due", 5000, end)
	require.Equal(t, "past_due", status())
	require.Equal(t, int64(1000), balance())
	require.NoError(t, pool.QueryRow(ctx, `SELECT past_due_since FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_plan'`).Scan(&replayPastDue))
	require.True(t, firstPastDue.Equal(replayPastDue))
	transport.status = "active"

	// Cancellation forfeits a fresh paid grant too.
	invoice("evt_in4", "in_4", 5000, end)
	require.Equal(t, int64(6000), balance())
	transport.status = "canceled"
	deliver("evt_canceled", "customer.subscription.updated", `{"id":"sub_plan","customer":"cus_plan"}`)
	require.Equal(t, int64(1000), balance())
	require.Equal(t, "canceled", status())
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
	status := func() string {
		overview, err := api.GetUserOverview(ctx, &commerce.User{ID: owner})
		require.NoError(t, err)
		require.NotNil(t, overview.Subscription)
		return overview.Subscription.Status
	}
	base := time.Now().Add(-time.Hour).Truncate(time.Second)

	invoice("evt_in1", "in_1", base)
	require.Equal(t, int64(6000), balance())

	// in_2 was paid, its first delivery failed, and it was refunded before
	// Stripe's retry arrived: the retry neither restores nor grants.
	refund("evt_refund_in2", base.Add(20*time.Minute))
	require.Equal(t, "past_due", status())
	require.False(t, paid())
	invoice("evt_in2_retry", "in_2", base.Add(10*time.Minute))
	require.Equal(t, "past_due", status())
	require.False(t, paid(), "a payment settled before the refund does not restore the plan")
	require.Equal(t, int64(1000), balance(), "a refunded invoice grants no credit")

	// A payment settled after the refund restores the plan and grants.
	invoice("evt_in3", "in_3", base.Add(30*time.Minute))
	require.Equal(t, "active", status())
	require.True(t, paid())
	require.Equal(t, int64(6000), balance())

	// A refund issued before in_3 settled but delivered after it does not
	// suspend the plan in_3 paid for.
	refund("evt_refund_late", base.Add(25*time.Minute))
	require.Equal(t, "active", status())
	require.True(t, paid(), "a reversal older than the latest settled payment does not suspend")
	require.Equal(t, int64(6000), balance(), "nor forfeit the credit that payment bought")

	// An invoice settled before a reversal grants nothing even after a later
	// payment restored the plan.
	invoice("evt_in2b_retry", "in_2b", base.Add(15*time.Minute))
	require.Equal(t, int64(6000), balance())

	// A payment with no settlement time restores nothing.
	refund("evt_refund_in3", base.Add(40*time.Minute))
	require.Equal(t, "past_due", status())
	require.False(t, paid())
	deliver("evt_untimed", "invoice.paid", time.Time{}, fmt.Sprintf(`{"id":"in_untimed","customer":"cus_plan","amount_paid":5000,
		"currency":"usd","parent":{"subscription_details":{"subscription":"sub_plan"}},"lines":{"data":[{"period":{"end":%d}}]}}`, end.Unix()))
	require.Equal(t, "past_due", status())
	require.False(t, paid())
	require.Equal(t, int64(1000), balance())
}

// Plan credit commits with the webhook that grants it: a delivery that fails
// to commit grants nothing, a billing read in between cannot forfeit it, and
// Stripe's retry grants it once (smithersai/smithers#2175).
func TestPlanCreditCommitsWithItsWebhook(t *testing.T) {
	pool := database(t)
	ctx := context.Background()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	transport := &subscriptionTransport{owner: owner, status: "active", end: end}
	const secret = "test-only-plan-credit-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"},
		WebhookSecret: secret, MonthlyCreditGrantCents: 5000, SignupCreditGrantCents: 1000})
	require.NoError(t, err)
	payload := []byte(fmt.Sprintf(`{"id":"evt_in1","type":"invoice.paid","data":{"object":{"id":"in_1","customer":"cus_plan",
		"amount_paid":5000,"currency":"usd","parent":{"subscription_details":{"subscription":"sub_plan"}},
		"lines":{"data":[{"period":{"start":%d,"end":%d}}]}}}}`, time.Now().Unix(), end.Unix()))
	deliver := func() error {
		now := time.Now().Unix()
		mac := hmac.New(sha256.New, []byte(secret))
		fmt.Fprintf(mac, "%d.%s", now, payload)
		return api.HandleStripeWebhook(ctx, payload, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil)))
	}
	balance := func() int64 {
		n, err := api.CreditLedger().OwnerBalance(ctx, "user", owner)
		require.NoError(t, err)
		return n / credits.NanosPerCent
	}

	// The subscription is past due when its renewal invoice is paid.
	transport.status = "past_due"
	event := []byte(fmt.Sprintf(`{"id":"evt_past_due","type":"customer.subscription.updated","data":{"object":{"id":"sub_plan","customer":"cus_plan",
		"metadata":{"owner_type":"user","owner_id":"%d"}}}}`, owner))
	now := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", now, event)
	require.NoError(t, api.HandleStripeWebhook(ctx, event, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))))
	require.Zero(t, balance())
	transport.status = "active"

	// The renewal's first delivery fails at commit, after every side effect
	// ran; a billing read then sees the committed past_due subscription.
	_, err = pool.Exec(ctx, `
		CREATE FUNCTION fail_webhook_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'webhook commit failed'; END $$;
		CREATE CONSTRAINT TRIGGER fail_webhook_commit AFTER INSERT ON stripe_processed_events
		DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_webhook_commit()`)
	require.NoError(t, err)
	require.Error(t, deliver())
	require.Zero(t, balance(), "a webhook that did not commit grants nothing")

	_, err = api.GetUserOverview(ctx, &commerce.User{ID: owner})
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `DROP TRIGGER fail_webhook_commit ON stripe_processed_events`)
	require.NoError(t, err)
	require.NoError(t, deliver())
	require.Equal(t, int64(6000), balance(), "Stripe's retry grants the plan credit")

	// A refresh projects a lapsed snapshot but never forfeits: its snapshot
	// can predate a webhook that just granted. The lapse webhook forfeits.
	transport.status = "past_due"
	_, err = api.RefreshUserBilling(ctx, &commerce.User{ID: owner})
	require.NoError(t, err)
	require.Equal(t, int64(6000), balance())
	lapse := []byte(`{"id":"evt_lapsed","type":"customer.subscription.updated","data":{"object":{"id":"sub_plan","customer":"cus_plan"}}}`)
	now = time.Now().Unix()
	mac = hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", now, lapse)
	require.NoError(t, api.HandleStripeWebhook(ctx, lapse, fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))))
	require.Equal(t, int64(1000), balance())
}
