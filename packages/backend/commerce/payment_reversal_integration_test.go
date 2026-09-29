package commerce_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/stretchr/testify/require"
)

func TestReversalRecoveryRetriesWhenANewerSnapshotWins(t *testing.T) {
	pool := database(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	transport := &gatedSubscription{owner: owner, end: end, calls: make(chan gatedCall, 4)}
	const secret = "reversal-race-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"}, WebhookSecret: secret, MonthlyCreditGrantCents: 5000})
	require.NoError(t, err)
	deliver := func(payload []byte) error {
		return api.HandleStripeWebhook(ctx, payload, signedWebhook(secret, payload))
	}
	base := time.Now().Add(-time.Hour).Unix()
	invoice := func(id string, at int64) []byte {
		return []byte(fmt.Sprintf(`{"id":"evt_%s","type":"invoice.paid","created":%d,"data":{"object":{"id":%q,"customer":"cus_race","amount_paid":5000,"currency":"usd","status_transitions":{"paid_at":%d},"parent":{"subscription_details":{"subscription":"sub_race"}},"lines":{"data":[{"period":{"end":%d}}]}}}}`, id, at, id, at, end.Unix()))
	}
	transport.next("active", nil)
	require.NoError(t, deliver(invoice("in_initial", base)))
	refund := []byte(fmt.Sprintf(`{"id":"evt_refund","type":"charge.refunded","created":%d,"data":{"object":{"id":"ch_race","customer":"cus_race","amount_refunded":5000,"currency":"usd"}}}`, base+60))
	require.NoError(t, deliver(refund))
	recovery := invoice("in_recovery", base+120)
	release := make(chan struct{})
	fetched := transport.next("active", release)
	result := make(chan error, 1)
	go func() { result <- deliver(recovery) }()
	select {
	case <-fetched:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	transport.next("active", nil)
	require.NoError(t, deliver([]byte(`{"id":"evt_newer_snapshot","type":"customer.subscription.updated","data":{"object":{"id":"sub_race","customer":"cus_race"}}}`)))
	close(release)
	require.Error(t, <-result, "a stale recovery snapshot must retry instead of consuming the invoice without credit")
	var reversed bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT payment_reversed_at IS NOT NULL FROM billing_subscriptions WHERE stripe_subscription_id='sub_race'`).Scan(&reversed))
	require.True(t, reversed, "the failed recovery must roll back settlement")
	transport.next("active", nil)
	require.NoError(t, deliver(recovery))
	overview, err := api.GetUserOverview(ctx, &commerce.User{ID: owner})
	require.NoError(t, err)
	require.Equal(t, "active", overview.Subscription.Status)
	require.Equal(t, int64(5000)*credits.NanosPerCent, overview.CreditBalanceNanos)
	require.NoError(t, deliver(recovery))
	balance, err := api.CreditLedger().OwnerBalance(ctx, "user", owner)
	require.NoError(t, err)
	require.Equal(t, int64(5000)*credits.NanosPerCent, balance)
}

func TestReversalDoesNotPromoteAnOlderSubscription(t *testing.T) {
	pool := database(t)
	ctx := context.Background()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour)
	transport := &subscriptionTransport{owner: owner, status: "active", end: end}
	const secret = "reversal-order-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"}, WebhookSecret: secret})
	require.NoError(t, err)
	updated := []byte(fmt.Sprintf(`{"id":"evt_initial","type":"customer.subscription.updated","data":{"object":{"id":"sub_plan","customer":"cus_plan","metadata":{"owner_type":"user","owner_id":"%d"}}}}`, owner))
	require.NoError(t, api.HandleStripeWebhook(ctx, updated, signedWebhook(secret, updated)))
	base := time.Now().Add(-time.Hour)
	_, err = pool.Exec(ctx, `UPDATE billing_subscriptions SET updated_at=$1, payment_settled_at=$1;
 `, base)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO billing_subscriptions (billing_account_id,stripe_subscription_id,stripe_price_id,plan_key,billing_interval,status,quantity,payment_settled_at,updated_at)
 SELECT billing_account_id,'sub_newer',stripe_price_id,plan_key,billing_interval,'active',quantity,$1,$1 FROM billing_subscriptions WHERE stripe_subscription_id='sub_plan'`, base.Add(30*time.Minute))
	require.NoError(t, err)
	refund := []byte(fmt.Sprintf(`{"id":"evt_late_refund","type":"charge.refunded","created":%d,"data":{"object":{"id":"ch_old","customer":"cus_plan","amount_refunded":5000,"currency":"usd"}}}`, base.Add(time.Minute).Unix()))
	require.NoError(t, api.HandleStripeWebhook(ctx, refund, signedWebhook(secret, refund)))
	paid, err := api.OwnerHasPaidPlan(ctx, "user", owner)
	require.NoError(t, err)
	require.True(t, paid, "the newer settled subscription must remain the selected paid plan")
}
