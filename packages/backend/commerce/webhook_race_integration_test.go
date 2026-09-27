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

// gatedSubscription answers each GetSubscription with the next scripted
// status. A call whose gate is set waits for it after reading Stripe, so a
// test can hold one webhook's snapshot while another webhook commits.
type gatedSubscription struct {
	commerce.Client
	owner int64
	end   time.Time
	calls chan gatedCall
}

type gatedCall struct {
	status  string
	fetched chan struct{} // closed once the status is read
	release chan struct{} // nil: return at once
}

func (p *gatedSubscription) GetSubscription(ctx context.Context, _ string) (commerce.SubscriptionSnapshot, error) {
	call := <-p.calls
	close(call.fetched)
	if call.release != nil {
		select {
		case <-call.release:
		case <-ctx.Done():
			return commerce.SubscriptionSnapshot{}, ctx.Err()
		}
	}
	return commerce.SubscriptionSnapshot{ID: "sub_race", CustomerID: "cus_race", PriceID: "price_pro", Interval: "monthly", Status: call.status,
		Quantity: 1, CurrentPeriodEnd: p.end, RawPayload: []byte(`{}`),
		Metadata: map[string]string{"owner_type": "user", "owner_id": fmt.Sprint(p.owner)}}, nil
}

func (p *gatedSubscription) ListActiveEntitlements(context.Context, string) ([]string, error) {
	return nil, nil
}

func (p *gatedSubscription) next(status string, release chan struct{}) chan struct{} {
	fetched := make(chan struct{})
	p.calls <- gatedCall{status: status, fetched: fetched, release: release}
	return fetched
}

func signedWebhook(secret string, payload []byte) string {
	now := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", now, payload)
	return fmt.Sprintf("t=%d,v1=%x", now, mac.Sum(nil))
}

// A webhook that read the subscription before a concurrent webhook read and
// committed a newer one leaves that newer snapshot in place, and so cannot
// forfeit the credit it granted (smithersai/smithers#2193).
func TestStaleSubscriptionSnapshotCannotForfeitFreshCredit(t *testing.T) {
	pool := database(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	transport := &gatedSubscription{owner: owner, end: end, calls: make(chan gatedCall, 4)}
	const secret = "test-only-snapshot-race-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"},
		WebhookSecret: secret, MonthlyCreditGrantCents: 5000})
	require.NoError(t, err)
	deliver := func(payload []byte) error {
		return api.HandleStripeWebhook(ctx, payload, signedWebhook(secret, payload))
	}
	subscriptionUpdated := func(event string) []byte {
		return []byte(fmt.Sprintf(`{"id":%q,"type":"customer.subscription.updated","data":{"object":{"id":"sub_race","customer":"cus_race",
			"metadata":{"owner_type":"user","owner_id":"%d"}}}}`, event, owner))
	}
	balance := func() int64 {
		n, err := api.CreditLedger().OwnerBalance(ctx, "user", owner)
		require.NoError(t, err)
		return n / credits.NanosPerCent
	}

	// The subscription is past due.
	transport.next("past_due", nil)
	require.NoError(t, deliver(subscriptionUpdated("evt_past_due")))

	// A subscription webhook reads the past-due subscription and stalls.
	release := make(chan struct{})
	staleFetched := transport.next("past_due", release)
	stale := make(chan error, 1)
	go func() { stale <- deliver(subscriptionUpdated("evt_stale")) }()
	select {
	case <-staleFetched:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}

	// The renewal is paid: invoice.paid reads the active subscription,
	// grants the plan credit and commits.
	transport.next("active", nil)
	require.NoError(t, deliver([]byte(fmt.Sprintf(`{"id":"evt_paid","type":"invoice.paid","data":{"object":{"id":"in_race","customer":"cus_race",
		"amount_paid":5000,"currency":"usd","status_transitions":{"paid_at":%d},"parent":{"subscription_details":{"subscription":"sub_race"}},
		"lines":{"data":[{"period":{"start":%d,"end":%d}}]}}}}`, time.Now().Unix(), time.Now().Unix(), end.Unix()))))
	require.Equal(t, int64(5000), balance())

	// The stalled webhook then writes its older snapshot.
	close(release)
	require.NoError(t, <-stale)
	var status string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_race'`).Scan(&status))
	require.Equal(t, "active", status, "an older snapshot never replaces a newer one")
	require.Equal(t, int64(5000), balance(), "an older snapshot never forfeits fresh plan credit")

	// A later lapse still projects and forfeits.
	transport.next("canceled", nil)
	require.NoError(t, deliver(subscriptionUpdated("evt_canceled")))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_race'`).Scan(&status))
	require.Equal(t, "canceled", status)
	require.Zero(t, balance())
}
