package commerce_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/stretchr/testify/require"
)

// Constructor-only tests use a pool value: no method opens a connection.
type inertPaymentClient struct{ commerce.Client }

func validConfig() commerce.Config {
	return commerce.Config{Usage: admission.ProductUsage, WebhookSecret: "webhook-secret"}
}

func TestNewValidatesAuthoritiesBeforeBindingUsage(t *testing.T) {
	pool := &pgxpool.Pool{}
	client := &inertPaymentClient{}
	for _, tc := range []struct {
		name   string
		pool   *pgxpool.Pool
		client commerce.Client
		cfg    commerce.Config
		want   string
	}{
		{"missing pool", nil, client, validConfig(), "database pool is required"},
		{"missing payment client", pool, nil, validConfig(), "payment client is required"},
		{"missing webhook secret", pool, client, commerce.Config{Usage: admission.ProductUsage}, "webhook secret is required"},
		{"whitespace webhook secret", pool, client, commerce.Config{Usage: admission.ProductUsage, WebhookSecret: " \t\n"}, "webhook secret is required"},
		{"missing usage authority", pool, client, commerce.Config{WebhookSecret: "webhook-secret"}, "usage factory is required"},
		{"negative monthly grant", pool, client, commerce.Config{Usage: admission.ProductUsage, WebhookSecret: "webhook-secret", MonthlyCreditGrantCents: -1}, "credit grants must be non-negative"},
		{"negative signup grant", pool, client, commerce.Config{Usage: admission.ProductUsage, WebhookSecret: "webhook-secret", SignupCreditGrantCents: -1}, "credit grants must be non-negative"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			cfg := tc.cfg
			if cfg.Usage != nil {
				cfg.Usage = func(conn admission.DBTX) (admission.Usage, error) {
					called = true
					return admission.ProductUsage(conn)
				}
			}
			service, err := commerce.New(tc.pool, tc.client, cfg)
			require.Nil(t, service)
			require.EqualError(t, err, "commerce: "+tc.want)
			require.False(t, called, "invalid configuration must not bind usage")
		})
	}
}

func TestNewPreservesUsageFailureAndRequiresBoundAuthority(t *testing.T) {
	pool := &pgxpool.Pool{}
	client := &inertPaymentClient{}
	want := errors.New("private usage unavailable")
	for _, tc := range []struct {
		name  string
		usage admission.UsageFactory
		want  error
	}{
		{"factory failure", func(admission.DBTX) (admission.Usage, error) { return nil, want }, want},
		{"nil authority", func(admission.DBTX) (admission.Usage, error) { return nil, nil }, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validConfig()
			calls := 0
			cfg.Usage = func(conn admission.DBTX) (admission.Usage, error) {
				calls++
				require.Same(t, pool, conn)
				return tc.usage(conn)
			}
			service, err := commerce.New(pool, client, cfg)
			require.Nil(t, service)
			require.Equal(t, 1, calls)
			if tc.want != nil {
				require.ErrorIs(t, err, tc.want)
			} else {
				require.ErrorContains(t, err, "usage factory returned no authority")
			}
		})
	}
}

func TestNewConfiguresCheckoutAndExactSignupLedgerWithoutDatabaseIO(t *testing.T) {
	pool := &pgxpool.Pool{}
	client := &inertPaymentClient{}
	cfg := validConfig()
	cfg.SignupCreditGrantCents = 1_234
	cfg.Prices = admission.Prices{ProMonthly: "price_pro"}
	service, err := commerce.New(pool, client, cfg)
	require.NoError(t, err)
	require.True(t, service.Capabilities().Checkout)
	require.True(t, service.Capabilities().Webhook)
	require.Same(t, pool, service.CreditLedger().DB)
	require.Equal(t, int64(12_340_000_000), service.CreditLedger().SignupGrantNanos)

	cfg.Prices = admission.Prices{}
	withoutCheckout, err := commerce.New(pool, client, cfg)
	require.NoError(t, err)
	require.False(t, withoutCheckout.Capabilities().Checkout)
	require.True(t, withoutCheckout.Capabilities().Webhook)
}

func TestNewRejectsGrantsThatCannotConvertToNanos(t *testing.T) {
	const largestSafeCents int64 = 922_337_203_685
	pool := &pgxpool.Pool{}
	client := &inertPaymentClient{}
	for _, grant := range []string{"signup", "monthly"} {
		t.Run(grant, func(t *testing.T) {
			cfg := validConfig()
			bindings := 0
			cfg.Usage = func(conn admission.DBTX) (admission.Usage, error) {
				bindings++
				require.Same(t, pool, conn)
				return admission.ProductUsage(conn)
			}
			if grant == "signup" {
				cfg.SignupCreditGrantCents = largestSafeCents
			} else {
				cfg.MonthlyCreditGrantCents = largestSafeCents
			}
			valid, err := commerce.New(pool, client, cfg)
			require.NoError(t, err)
			require.NotNil(t, valid)
			require.Equal(t, 1, bindings)
			if grant == "signup" {
				require.Equal(t, int64(9_223_372_036_850_000_000), valid.CreditLedger().SignupGrantNanos)
			}
			if grant == "signup" {
				cfg.SignupCreditGrantCents = largestSafeCents + 1
			} else {
				cfg.MonthlyCreditGrantCents = largestSafeCents + 1
			}
			bindings = 0
			service, err := commerce.New(pool, client, cfg)
			require.Nil(t, service)
			require.EqualError(t, err, "commerce: "+grant+" credit grant: credits: cents cannot be represented as non-negative nanos")
			require.Zero(t, bindings, "unsafe grants must be rejected before usage binding")
		})
	}
}
