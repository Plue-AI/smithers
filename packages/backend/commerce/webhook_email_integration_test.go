package commerce_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/credits"
)

// slowEmail blocks each billing notice until released.
type slowEmail struct {
	sending chan string
	release chan struct{}
}

func (e *slowEmail) SendBillingNotification(ctx context.Context, _ string, subject string, _ string) {
	e.sending <- subject
	select {
	case <-e.release:
	case <-ctx.Done():
	}
}

// A payment-failure webhook that forfeits plan credit sends its email after
// it commits, so a model call settling on the same credit account never
// waits on email delivery (smithersai/smithers#2193).
func TestPaymentFailureEmailDoesNotHoldTheCreditLock(t *testing.T) {
	pool := database(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := user(t, pool)
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	transport := &gatedSubscription{owner: owner, end: end, calls: make(chan gatedCall, 4)}
	email := &slowEmail{sending: make(chan string, 4), release: make(chan struct{})}
	const secret = "test-only-dunning-secret"
	api, err := commerce.New(pool, transport, commerce.Config{Usage: admission.ProductUsage, Prices: admission.Prices{ProMonthly: "price_pro"},
		WebhookSecret: secret, MonthlyCreditGrantCents: 5000, EmailSender: email})
	require.NoError(t, err)
	deliver := func(payload []byte) error {
		return api.HandleStripeWebhook(ctx, payload, signedWebhook(secret, payload))
	}
	transport.next("active", nil)
	require.NoError(t, deliver([]byte(fmt.Sprintf(`{"id":"evt_paid","type":"invoice.paid","data":{"object":{"id":"in_dun","customer":"cus_race",
		"amount_paid":5000,"currency":"usd","status_transitions":{"paid_at":%d},"parent":{"subscription_details":{"subscription":"sub_race"}},
		"lines":{"data":[{"period":{"start":%d,"end":%d}}]}}}}`, time.Now().Unix(), time.Now().Unix(), end.Unix()))))
	ledger := api.CreditLedger()
	account, err := ledger.EnsureAccount(ctx, "user", owner)
	require.NoError(t, err)
	_, err = ledger.Reserve(ctx, account, "model_call", credits.NanosPerCent)
	require.NoError(t, err)

	// Dunning ends the subscription: the webhook forfeits the plan credit
	// and emails the customer, whose mail server is slow.
	failed := func(event string) []byte {
		return []byte(fmt.Sprintf(`{"id":%q,"type":"invoice.payment_failed","data":{"object":{"id":"in_next","customer":"cus_race",
			"customer_email":"payer@example.test","amount_due":5000,"currency":"usd","parent":{"subscription_details":{"subscription":"sub_race"}}}}}`, event))
	}
	transport.next("unpaid", nil)
	webhook := make(chan error, 1)
	go func() { webhook <- deliver(failed("evt_failed")) }()
	select {
	case subject := <-email.sending:
		require.Equal(t, "Payment failed for your Smithers subscription", subject)
	case err := <-webhook:
		t.Fatalf("webhook finished before its email: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}

	// The model call settles while the email is still sending.
	settleCtx, settleCancel := context.WithTimeout(ctx, 3*time.Second)
	defer settleCancel()
	settled, err := ledger.Settle(settleCtx, account, "model_call", credits.NanosPerCent/2)
	require.NoError(t, err, "a settlement never waits on a billing email")
	require.Equal(t, credits.NanosPerCent/2, settled.ChargedNanos)
	close(email.release)
	require.NoError(t, <-webhook)
	balance, err := ledger.OwnerBalance(ctx, "user", owner)
	require.NoError(t, err)
	require.Zero(t, balance, "the plan credit was forfeited")

	// A webhook that fails to commit sends nothing.
	_, err = pool.Exec(ctx, `
		CREATE FUNCTION fail_webhook_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'webhook commit failed'; END $$;
		CREATE CONSTRAINT TRIGGER fail_webhook_commit AFTER INSERT ON stripe_processed_events
		DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_webhook_commit()`)
	require.NoError(t, err)
	transport.next("unpaid", nil)
	require.Error(t, deliver(failed("evt_failed_again")))
	select {
	case subject := <-email.sending:
		t.Fatalf("a rolled-back webhook sent %q", subject)
	default:
	}
}
