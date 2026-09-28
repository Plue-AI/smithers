// Package commerce exposes the canonical billing routes without a payment SDK.
// Private deployments supply the payment transport; worker admission is separate.
package commerce

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/billingstore"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// These are value contracts, with no provider SDK dependency.
type Client = services.StripeBillingClient
type CreateCustomerInput = services.StripeCreateCustomerInput
type CreateCheckoutSessionInput = services.StripeCreateCheckoutSessionInput
type CreatePortalSessionInput = services.StripeCreatePortalSessionInput
type CheckoutSessionResult = services.StripeCheckoutSessionResult
type CheckoutSessionSnapshot = services.StripeCheckoutSessionSnapshot
type SubscriptionSnapshot = services.StripeSubscriptionSnapshot
type ChargeSnapshot = services.StripeChargeSnapshot
type EmailSender = services.BillingEmailSender
type User = db.User
type Plans = services.BillingPlansResponse
type Overview = services.BillingOverview
type Session = services.BillingSessionResult
type Capabilities = services.BillingCapabilities

// WebhookEvents is every payment event HandleStripeWebhook handles. The
// deployment's webhook endpoint must subscribe to exactly these.
var WebhookEvents = services.StripeWebhookEvents

// Routes is the complete existing HTTP billing contract. Optional commerce
// absence must be represented by nil, never a nonfunctional route authority.
type Routes interface {
	GetUserPlans(context.Context, *User) (Plans, error)
	GetUserOverview(context.Context, *User) (Overview, error)
	GetOrgOverview(context.Context, *User, string) (Overview, error)
	CreateUserCheckout(context.Context, *User, string, string) (Session, error)
	CreateOrgCheckout(context.Context, *User, string, string, string) (Session, error)
	CreateUserPortal(context.Context, *User) (Session, error)
	CreateOrgPortal(context.Context, *User, string) (Session, error)
	RefreshUserBilling(context.Context, *User) (Overview, error)
	RefreshOrgBilling(context.Context, *User, string) (Overview, error)
	HandleStripeWebhook(context.Context, []byte, string) error
}

type Service interface {
	Routes
	ReconcileOrgSeats(context.Context, int64) error
	Capabilities() Capabilities
	// SetFallbackEmailSender binds the common product notification service before serving.
	// A deployment-supplied sender remains authoritative.
	SetFallbackEmailSender(EmailSender)
	// CreditLedger is the exact credit ledger with this deployment's grants,
	// shared by every platform-model charge.
	CreditLedger() credits.Ledger
	// OwnerHasPaidPlan reports whether an owner's subscription grants paid
	// entitlements. The model proxy charges an organization's automation to
	// the acting user when it does not.
	OwnerHasPaidPlan(ctx context.Context, ownerType string, ownerID int64) (bool, error)
}

type Config struct {
	Usage                                                           admission.UsageFactory
	Prices                                                          admission.Prices
	BaseURL, PortalReturnURL, CheckoutSuccessURL, CheckoutCancelURL string
	WebhookSecret                                                   string
	EmailSender                                                     EmailSender
	// MonthlyCreditGrantCents is the platform credit one paid subscription
	// invoice (invoice.paid) grants in the exact credit ledger, capped at the
	// invoice's amount paid and expiring at the end of the period it pays for.
	// Zero grants nothing.
	MonthlyCreditGrantCents int64
	// SignupCreditGrantCents is the one-time platform credit granted when a
	// user's credit account is created, once per login identity
	// (credits.Ledger.SignupGrantNanos). Zero grants nothing.
	SignupCreditGrantCents int64
}

// New constructs API commerce over the same ledger, metering, and transactional
// projection implementation used by admission. Payment keys stay in Client.
func New(pool *pgxpool.Pool, client Client, cfg Config) (Service, error) {
	if pool == nil {
		return nil, errors.New("commerce: database pool is required")
	}
	if client == nil {
		return nil, errors.New("commerce: payment client is required")
	}
	if strings.TrimSpace(cfg.WebhookSecret) == "" {
		return nil, errors.New("commerce: webhook secret is required")
	}
	if cfg.Usage == nil {
		return nil, errors.New("commerce: usage factory is required")
	}
	if cfg.MonthlyCreditGrantCents < 0 || cfg.SignupCreditGrantCents < 0 {
		return nil, errors.New("commerce: credit grants must be non-negative")
	}
	signupNanos, err := credits.NanosFromCents(cfg.SignupCreditGrantCents)
	if err != nil {
		return nil, fmt.Errorf("commerce: signup credit grant: %w", err)
	}
	if _, err := credits.NanosFromCents(cfg.MonthlyCreditGrantCents); err != nil {
		return nil, fmt.Errorf("commerce: monthly credit grant: %w", err)
	}
	queries, err := billingstore.Bind(pool, cfg.Usage)
	if err != nil {
		return nil, err
	}
	p := cfg.Prices
	ledger := credits.Ledger{DB: pool, SignupGrantNanos: signupNanos}
	service := services.NewBillingService(queries, client, services.BillingServiceConfig{
		BaseURL: cfg.BaseURL, PortalReturnURL: cfg.PortalReturnURL,
		CheckoutSuccessURL: cfg.CheckoutSuccessURL, CheckoutCancelURL: cfg.CheckoutCancelURL,
		StripeWebhookSecret:    cfg.WebhookSecret,
		PersonalMonthlyPriceID: p.PersonalMonthly, PersonalAnnualPriceID: p.PersonalAnnual,
		ProMonthlyPriceID: p.ProMonthly, ProAnnualPriceID: p.ProAnnual,
		MaxMonthlyPriceID: p.MaxMonthly, MaxAnnualPriceID: p.MaxAnnual,
		TeamMonthlyPriceID: p.TeamMonthly, TeamAnnualPriceID: p.TeamAnnual,
		EnterpriseMonthlyPriceID: p.EnterpriseMonthly, EnterpriseAnnualPriceID: p.EnterpriseAnnual,
		MonthlyCreditGrantCents: cfg.MonthlyCreditGrantCents,
	}, services.WithBillingEmailSender(cfg.EmailSender), services.WithBillingCreditLedger(ledger))
	return &authority{BillingService: service, emailSender: cfg.EmailSender, ledger: ledger}, nil
}

type authority struct {
	*services.BillingService
	emailSender EmailSender
	ledger      credits.Ledger
}

func (s *authority) CreditLedger() credits.Ledger { return s.ledger }

func (s *authority) Capabilities() Capabilities { return s.CommerceCapabilities() }

var _ Service = (*authority)(nil)
var _ admission.Policy = (*authority)(nil)

func (s *authority) SetFallbackEmailSender(sender EmailSender) {
	if s.emailSender == nil {
		s.emailSender = sender
		services.WithBillingEmailSender(sender)(s.BillingService)
	}
}
