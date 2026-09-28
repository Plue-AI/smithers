package services

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/billingstore"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	BillingOwnerTypeUser = "user"
	BillingOwnerTypeOrg  = "org"

	BillingPlanFree       = "free"
	BillingPlanPersonal   = "personal"
	BillingPlanPro        = "pro"
	BillingPlanMax        = "max"
	BillingPlanTeam       = "team"
	BillingPlanEnterprise = "enterprise"
	BillingPlanCustom     = "custom"

	BillingIntervalMonthly = "monthly"
	BillingIntervalAnnual  = "annual"

	BillingMetricPrivateRepos = "private_repos"
	BillingMetricStorageBytes = "storage_bytes"
	BillingMetricCIMinutes    = "ci_minutes"
	BillingMetricAgentRuns    = "agent_runs"
	BillingMetricSeats        = "seats"
	BillingMetricSandboxHours = "sandbox_hours"

	unlimitedBillingQuantity int64 = 9_000_000_000_000

	billingDunningGracePeriod         = 7 * 24 * time.Hour
	billingDunningNotificationCadence = "immediate failure notice, then one notice per Stripe payment_failed retry event"
	billingAdvisoryLockReleaseTimeout = 5 * time.Second

	// storageAuthorizationLockSQL is the shared per-owner quota lock. It
	// serializes storage writers, private-repository consumers, and inbound
	// transfers so each check observes the prior consuming commit. The id
	// parameter is typed bigint and cast to text inside the statement: writing
	// it as $2::text would make Postgres infer a text parameter, which pgx cannot
	// encode the int64 owner id into.
	storageAuthorizationLockSQL = "SELECT pg_advisory_xact_lock(hashtextextended('storage:' || $1::text || ':' || ($2::bigint)::text, 0))"
)

type BillingPolicy interface {
	AuthorizeSandboxStart(ctx context.Context, userID int64) error
	SandboxEntitlement(ctx context.Context, userID int64) (SandboxEntitlement, error)
	AuthorizePrivateRepo(ctx context.Context, ownerType string, ownerID int64) error
	AuthorizeWorkflowDispatch(ctx context.Context, repositoryID int64) error
	AuthorizeAgentRun(ctx context.Context, repositoryID int64) error
	AuthorizeStorageIncrease(ctx context.Context, repositoryID int64, additionalBytes int64) error
	// AuthorizePairing gates a user's participation in a Smithers Pair session
	// at create and join/invite-accept ONLY (amendment B: live members are
	// grandfathered for the session's lifetime — no enqueue re-check, no
	// mid-session degradation). Paid ⇔ the user's live subscription resolves to
	// a Hobby ('personal', $40) plan or above; trialing counts as paid
	// (decisions #1/#6). Free or lapsed users are Forbidden.
	AuthorizePairing(ctx context.Context, userID int64) error
}

type BillingQuerier interface {
	BillingBaseQuerier
	CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error)
	SumSandboxAwakeSecondsForUserSince(ctx context.Context, userID int64, since time.Time) (int64, error)
	CountActiveAgentSessionVMsForUser(ctx context.Context, userID int64) (int64, error)
}

// BillingBaseQuerier is the canonical product ledger and usage contract.
// Sandbox operations require BillingQuerier and fail closed when it is absent.
type BillingBaseQuerier = billingstore.Querier

type StripeBillingClient interface {
	CreateCustomer(ctx context.Context, input StripeCreateCustomerInput) (string, error)
	CreateCheckoutSession(ctx context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error)
	CreatePortalSession(ctx context.Context, input StripeCreatePortalSessionInput) (string, error)
	GetSubscription(ctx context.Context, subscriptionID string) (StripeSubscriptionSnapshot, error)
	GetCharge(ctx context.Context, chargeID string) (StripeChargeSnapshot, error)
	ListActiveEntitlements(ctx context.Context, customerID string) ([]string, error)
	CancelSubscription(ctx context.Context, subscriptionID string) error
	UpdateSubscriptionQuantity(ctx context.Context, subscriptionID string, quantity int64) error
	GetLatestCheckoutSession(ctx context.Context, customerID string) (StripeCheckoutSessionSnapshot, bool, error)
	ExpireCheckoutSession(ctx context.Context, sessionID string) error
}

type BillingEmailSender interface {
	SendBillingNotification(ctx context.Context, toEmail string, subject string, body string)
}

type BillingServiceConfig struct {
	// MonthlyCreditGrantCents is the platform credit one paid subscription
	// invoice buys, capped at the invoice's amount paid and spendable until the
	// end of the period it pays for. Zero grants nothing.
	MonthlyCreditGrantCents  int64
	BaseURL                  string
	PortalReturnURL          string
	CheckoutSuccessURL       string
	CheckoutCancelURL        string
	StripeWebhookSecret      string
	PersonalMonthlyPriceID   string
	PersonalAnnualPriceID    string
	ProMonthlyPriceID        string
	ProAnnualPriceID         string
	MaxMonthlyPriceID        string
	MaxAnnualPriceID         string
	TeamMonthlyPriceID       string
	TeamAnnualPriceID        string
	EnterpriseMonthlyPriceID string
	EnterpriseAnnualPriceID  string
}

type BillingAccountSummary struct {
	ID                  int64     `json:"id"`
	StripeCustomerID    string    `json:"stripe_customer_id"`
	StripeCustomerEmail string    `json:"stripe_customer_email"`
	StripeCustomerName  string    `json:"stripe_customer_name"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
}

type BillingSubscriptionSummary struct {
	StripeSubscriptionID string     `json:"stripe_subscription_id"`
	StripePriceID        string     `json:"stripe_price_id"`
	PlanKey              string     `json:"plan_key"`
	BillingInterval      string     `json:"billing_interval"`
	Status               string     `json:"status"`
	Quantity             int64      `json:"quantity"`
	TrialEnd             *time.Time `json:"trial_end,omitempty"`
	CurrentPeriodStart   *time.Time `json:"current_period_start,omitempty"`
	CurrentPeriodEnd     *time.Time `json:"current_period_end,omitempty"`
	CancelAtPeriodEnd    bool       `json:"cancel_at_period_end"`
	CanceledAt           *time.Time `json:"canceled_at,omitempty"`
}

type BillingEntitlementSummary struct {
	FeatureKey   string    `json:"feature_key"`
	Active       bool      `json:"active"`
	LastSyncedAt time.Time `json:"last_synced_at"`
}

type BillingUsageSummary struct {
	MetricKey        string `json:"metric_key"`
	IncludedQuantity int64  `json:"included_quantity"`
	ConsumedQuantity int64  `json:"consumed_quantity"`
	OverageQuantity  int64  `json:"overage_quantity"`
}

type BillingOverview struct {
	Sandbox          SandboxEntitlement          `json:"sandbox"`
	OwnerType        string                      `json:"owner_type"`
	OwnerID          int64                       `json:"owner_id"`
	OwnerName        string                      `json:"owner_name"`
	PlanKey          string                      `json:"plan_key"`
	BillingInterval  string                      `json:"billing_interval"`
	StripeConfigured bool                        `json:"stripe_configured"`
	Account          *BillingAccountSummary      `json:"account,omitempty"`
	Subscription     *BillingSubscriptionSummary `json:"subscription,omitempty"`
	Entitlements     []BillingEntitlementSummary `json:"entitlements"`
	// CreditBalanceNanos is the owner's spendable platform credit in USD
	// nanos; negative is owed. CreditBalanceCents rounds it toward zero.
	CreditBalanceNanos   int64                 `json:"credit_balance_nanos"`
	CreditBalanceCents   int64                 `json:"credit_balance_cents"`
	LifetimeChargedNanos int64                 `json:"lifetime_charged_nanos"`
	ChargeCount          int64                 `json:"charge_count"`
	UsagePeriodStart     time.Time             `json:"usage_period_start"`
	UsagePeriodEnd       time.Time             `json:"usage_period_end"`
	Usage                []BillingUsageSummary `json:"usage"`
}

type BillingSessionResult struct {
	URL string `json:"url"`
}

type billingOwnerRef struct {
	OwnerType string
	OwnerID   int64
	OwnerName string
}

type billingPlanLimits struct {
	ConcurrentSandboxes    int64
	SandboxIdleTimeoutSecs int64
	SandboxHoursPerDay     int64
	PrivateRepos           int64
	StorageBytes           int64
	CIMinutes              int64
	AgentRuns              int64
	Seats                  int64
}

type billingPlanDefinition struct {
	PriceCents   int64
	Key          string
	AllowedOwner string
	Interval     string
	PriceID      string
	Limits       billingPlanLimits
	// Unlisted plans still resolve for existing subscriptions but are not
	// offered in the plans list and refuse checkout.
	Unlisted bool
}

type BillingService struct {
	queries     BillingBaseQuerier
	stripe      StripeBillingClient
	credits     BillingCreditLedger
	emailSender BillingEmailSender
	// notices, when set, holds billing notices until the webhook
	// transaction commits (see processStripeEventTx).
	notices       *[]billingNotice
	config        BillingServiceConfig
	priceCatalog  map[string]billingPlanDefinition
	checkoutPlans map[string]map[string]billingPlanDefinition
	now           func() time.Time
}

type BillingServiceOption func(*BillingService)

// BillingCreditLedger is the exact credit ledger (credits.Ledger). Without
// one, accounts carry no platform credit and no grant is issued.
type BillingCreditLedger interface {
	EnsureAccount(ctx context.Context, ownerType string, ownerID int64) (int64, error)
	Grant(ctx context.Context, accountID int64, key string, nanos int64, expiresAt *time.Time) error
	OwnerBalance(ctx context.Context, ownerType string, ownerID int64) (int64, error)
	OwnerSummary(ctx context.Context, ownerType string, ownerID int64) (balance, chargedNanos, chargeCount int64, err error)
	Forfeit(ctx context.Context, ownerType string, ownerID int64, prefix string) (int64, error)
}

// creditLedgerInTransaction joins ledger to tx. A ledger that cannot join a
// transaction fails closed rather than committing credit on its own.
func creditLedgerInTransaction(ledger BillingCreditLedger, tx pgx.Tx) (BillingCreditLedger, error) {
	switch l := ledger.(type) {
	case nil:
		return nil, nil
	case credits.Ledger:
		return l.InTransaction(tx), nil
	default:
		return nil, pkgerrors.Internal("billing credit ledger cannot join the webhook transaction")
	}
}

func WithBillingCreditLedger(ledger BillingCreditLedger) BillingServiceOption {
	return func(s *BillingService) {
		s.credits = ledger
	}
}

func WithBillingEmailSender(sender BillingEmailSender) BillingServiceOption {
	return func(s *BillingService) {
		s.emailSender = sender
	}
}

type stripeCheckoutSessionPayload struct {
	ID              string            `json:"id"`
	Customer        string            `json:"customer"`
	Subscription    string            `json:"subscription"`
	Metadata        map[string]string `json:"metadata"`
	CustomerDetails struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"customer_details"`
}

type stripeSubscriptionPayload struct {
	ID                 string            `json:"id"`
	Customer           string            `json:"customer"`
	Metadata           map[string]string `json:"metadata"`
	Status             string            `json:"status"`
	CancelAtPeriodEnd  bool              `json:"cancel_at_period_end"`
	CanceledAt         int64             `json:"canceled_at"`
	CurrentPeriodStart int64             `json:"current_period_start"`
	CurrentPeriodEnd   int64             `json:"current_period_end"`
	TrialEnd           int64             `json:"trial_end"`
	Items              struct {
		Data []struct {
			Quantity           int64 `json:"quantity"`
			CurrentPeriodStart int64 `json:"current_period_start"`
			CurrentPeriodEnd   int64 `json:"current_period_end"`
			Price              struct {
				ID        string `json:"id"`
				Recurring struct {
					Interval string `json:"interval"`
				} `json:"recurring"`
			} `json:"price"`
		} `json:"data"`
	} `json:"items"`
}

type stripeCustomerPayload struct {
	ID       string            `json:"id"`
	Email    string            `json:"email"`
	Name     string            `json:"name"`
	Metadata map[string]string `json:"metadata"`
}

type stripeInvoicePaymentFailedPayload struct {
	ID                 string `json:"id"`
	Customer           string `json:"customer"`
	Subscription       string `json:"subscription"`
	Number             string `json:"number"`
	HostedInvoiceURL   string `json:"hosted_invoice_url"`
	AmountDue          int64  `json:"amount_due"`
	Currency           string `json:"currency"`
	NextPaymentAttempt int64  `json:"next_payment_attempt"`
	AttemptCount       int64  `json:"attempt_count"`
	CustomerEmail      string `json:"customer_email"`
	CustomerName       string `json:"customer_name"`
	// Since API version 2025-03-31 (Basil) the subscription id lives here;
	// the top-level field is empty on current payloads.
	Parent struct {
		SubscriptionDetails struct {
			Subscription string `json:"subscription"`
		} `json:"subscription_details"`
	} `json:"parent"`
}

func (p stripeInvoicePaymentFailedPayload) subscriptionID() string {
	if id := strings.TrimSpace(p.Parent.SubscriptionDetails.Subscription); id != "" {
		return id
	}
	return strings.TrimSpace(p.Subscription)
}

type stripeChargePayload struct {
	ID             string `json:"id"`
	Customer       string `json:"customer"`
	Invoice        string `json:"invoice"`
	PaymentIntent  string `json:"payment_intent"`
	AmountRefunded int64  `json:"amount_refunded"`
	Currency       string `json:"currency"`
	BillingDetails struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"billing_details"`
}

type stripeDisputePayload struct {
	ID            string `json:"id"`
	Charge        string `json:"charge"`
	PaymentIntent string `json:"payment_intent"`
	Amount        int64  `json:"amount"`
	Currency      string `json:"currency"`
	Reason        string `json:"reason"`
	Status        string `json:"status"`
}

type stripeEntitlementSummaryPayload struct {
	Customer           string `json:"customer"`
	ActiveEntitlements []struct {
		LookupKey string `json:"lookup_key"`
		Feature   struct {
			LookupKey string `json:"lookup_key"`
		} `json:"feature"`
	} `json:"active_entitlements"`
}

func NewBillingService(q BillingBaseQuerier, stripeClient StripeBillingClient, cfg BillingServiceConfig, opts ...BillingServiceOption) *BillingService {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		baseURL = "http://localhost:4000"
	}
	cfg.BaseURL = baseURL
	s := &BillingService{
		queries:       q,
		stripe:        stripeClient,
		config:        cfg,
		priceCatalog:  map[string]billingPlanDefinition{},
		checkoutPlans: map[string]map[string]billingPlanDefinition{},
		now:           func() time.Time { return time.Now().UTC() },
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	s.bootstrapCatalog()
	return s
}

func (s *BillingService) bootstrapCatalog() {
	freeLimits := billingPlanLimits{
		ConcurrentSandboxes: 1, SandboxIdleTimeoutSecs: 1800, SandboxHoursPerDay: 4,
		PrivateRepos: 100,
		StorageBytes: 100 * 1024 * 1024 * 1024,
		CIMinutes:    10000,
		AgentRuns:    2000,
		Seats:        250,
	}
	personalLimits := billingPlanLimits{
		ConcurrentSandboxes: 3, SandboxIdleTimeoutSecs: 14400, SandboxHoursPerDay: unlimitedBillingQuantity,
		PrivateRepos: 250,
		StorageBytes: 250 * 1024 * 1024 * 1024,
		CIMinutes:    25000,
		AgentRuns:    5000,
		Seats:        1,
	}
	// Pro: the heavy single-user plan — sits between personal and team on
	// every quota but stays Seats:1 (user-owned, like personal). Pro
	// workspaces sleep after 1 hour idle.
	proLimits := billingPlanLimits{
		ConcurrentSandboxes: 3, SandboxIdleTimeoutSecs: 3600, SandboxHoursPerDay: unlimitedBillingQuantity,
		PrivateRepos: 500,
		StorageBytes: 500 * 1024 * 1024 * 1024,
		CIMinutes:    50000,
		AgentRuns:    15000,
		Seats:        1,
	}
	teamLimits := billingPlanLimits{
		ConcurrentSandboxes: 3, SandboxIdleTimeoutSecs: 14400, SandboxHoursPerDay: unlimitedBillingQuantity,
		PrivateRepos: 1000,
		StorageBytes: 1024 * 1024 * 1024 * 1024,
		CIMinutes:    100000,
		AgentRuns:    25000,
		Seats:        250,
	}
	enterpriseLimits := billingPlanLimits{
		ConcurrentSandboxes: 3, SandboxIdleTimeoutSecs: 14400, SandboxHoursPerDay: unlimitedBillingQuantity,
		PrivateRepos: unlimitedBillingQuantity,
		StorageBytes: unlimitedBillingQuantity,
		CIMinutes:    unlimitedBillingQuantity,
		AgentRuns:    unlimitedBillingQuantity,
		Seats:        unlimitedBillingQuantity,
	}

	// Max promises 64 never-sleeping sandboxes, more than the fleet runs. It
	// is unlisted (not purchasable); the definition stays for any existing
	// subscription.
	maxLimits := proLimits
	maxLimits.ConcurrentSandboxes = 64
	maxLimits.SandboxIdleTimeoutSecs = 0
	s.checkoutPlans[BillingOwnerTypeUser] = map[string]billingPlanDefinition{}
	s.checkoutPlans[BillingOwnerTypeOrg] = map[string]billingPlanDefinition{}

	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanPersonal,
		PriceCents:   4000,
		AllowedOwner: BillingOwnerTypeUser,
		Interval:     BillingIntervalMonthly,
		PriceID:      strings.TrimSpace(s.config.PersonalMonthlyPriceID),
		Limits:       personalLimits,
	})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanPersonal,
		PriceCents:   4000,
		AllowedOwner: BillingOwnerTypeUser,
		Interval:     BillingIntervalAnnual,
		PriceID:      strings.TrimSpace(s.config.PersonalAnnualPriceID),
		Limits:       personalLimits,
	})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanPro,
		PriceCents:   5000,
		AllowedOwner: BillingOwnerTypeUser,
		Interval:     BillingIntervalMonthly,
		PriceID:      strings.TrimSpace(s.config.ProMonthlyPriceID),
		Limits:       proLimits,
	})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanPro,
		PriceCents:   5000,
		AllowedOwner: BillingOwnerTypeUser,
		Interval:     BillingIntervalAnnual,
		PriceID:      strings.TrimSpace(s.config.ProAnnualPriceID),
		Limits:       proLimits,
	})
	s.registerPlan(billingPlanDefinition{Key: BillingPlanMax, AllowedOwner: BillingOwnerTypeUser, Interval: BillingIntervalMonthly, PriceID: strings.TrimSpace(s.config.MaxMonthlyPriceID), PriceCents: 50000, Limits: maxLimits, Unlisted: true})
	s.registerPlan(billingPlanDefinition{Key: BillingPlanMax, AllowedOwner: BillingOwnerTypeUser, Interval: BillingIntervalAnnual, PriceID: strings.TrimSpace(s.config.MaxAnnualPriceID), PriceCents: 50000, Limits: maxLimits, Unlisted: true})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanTeam,
		AllowedOwner: BillingOwnerTypeOrg,
		Interval:     BillingIntervalMonthly,
		PriceID:      strings.TrimSpace(s.config.TeamMonthlyPriceID),
		Limits:       teamLimits,
	})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanTeam,
		AllowedOwner: BillingOwnerTypeOrg,
		Interval:     BillingIntervalAnnual,
		PriceID:      strings.TrimSpace(s.config.TeamAnnualPriceID),
		Limits:       teamLimits,
	})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanEnterprise,
		AllowedOwner: BillingOwnerTypeOrg,
		Interval:     BillingIntervalMonthly,
		PriceID:      strings.TrimSpace(s.config.EnterpriseMonthlyPriceID),
		Limits:       enterpriseLimits,
	})
	s.registerPlan(billingPlanDefinition{
		Key:          BillingPlanEnterprise,
		AllowedOwner: BillingOwnerTypeOrg,
		Interval:     BillingIntervalAnnual,
		PriceID:      strings.TrimSpace(s.config.EnterpriseAnnualPriceID),
		Limits:       enterpriseLimits,
	})

	s.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = billingPlanDefinition{
		Key:          BillingPlanFree,
		AllowedOwner: BillingOwnerTypeUser,
		Limits:       freeLimits,
	}
	s.checkoutPlans[BillingOwnerTypeOrg][BillingPlanFree] = billingPlanDefinition{
		Key:          BillingPlanFree,
		AllowedOwner: BillingOwnerTypeOrg,
		Limits:       freeLimits,
	}
	s.checkoutPlans[BillingOwnerTypeOrg][BillingPlanCustom] = billingPlanDefinition{
		Key:          BillingPlanCustom,
		AllowedOwner: BillingOwnerTypeOrg,
		Limits:       enterpriseLimits,
	}
	s.checkoutPlans[BillingOwnerTypeUser][BillingPlanCustom] = billingPlanDefinition{
		Key:          BillingPlanCustom,
		AllowedOwner: BillingOwnerTypeUser,
		Limits:       personalLimits,
	}
}

func (s *BillingService) registerPlan(plan billingPlanDefinition) {
	if strings.TrimSpace(plan.PriceID) != "" {
		s.priceCatalog[plan.PriceID] = plan
	}
	if plan.AllowedOwner == "" || plan.Key == "" || plan.Interval == "" {
		return
	}
	if _, ok := s.checkoutPlans[plan.AllowedOwner]; !ok {
		s.checkoutPlans[plan.AllowedOwner] = map[string]billingPlanDefinition{}
	}
	s.checkoutPlans[plan.AllowedOwner][plan.Key+":"+plan.Interval] = plan
}

func (s *BillingService) GetUserOverview(ctx context.Context, user *db.User) (BillingOverview, error) {
	if user == nil {
		return BillingOverview{}, pkgerrors.Unauthorized("authentication required")
	}
	return s.ownerOverview(ctx, billingOwnerRef{
		OwnerType: BillingOwnerTypeUser,
		OwnerID:   user.ID,
		OwnerName: user.Username,
	})
}

func (s *BillingService) GetOrgOverview(ctx context.Context, actor *db.User, orgName string) (BillingOverview, error) {
	owner, err := s.resolveOrgOwner(ctx, actor, orgName)
	if err != nil {
		return BillingOverview{}, err
	}
	return s.ownerOverview(ctx, owner)
}

func (s *BillingService) CreateUserCheckout(ctx context.Context, user *db.User, planKey, interval string) (BillingSessionResult, error) {
	if user == nil {
		return BillingSessionResult{}, pkgerrors.Unauthorized("authentication required")
	}
	return s.createCheckoutSession(ctx, billingOwnerRef{
		OwnerType: BillingOwnerTypeUser,
		OwnerID:   user.ID,
		OwnerName: user.Username,
	}, strings.TrimSpace(user.DisplayName), billingTextValue(user.Email), planKey, interval, 1)
}

func (s *BillingService) CreateOrgCheckout(ctx context.Context, actor *db.User, orgName, planKey, interval string) (BillingSessionResult, error) {
	owner, err := s.resolveOrgOwner(ctx, actor, orgName)
	if err != nil {
		return BillingSessionResult{}, err
	}
	seats, err := s.currentSeatCount(ctx, owner)
	if err != nil {
		return BillingSessionResult{}, err
	}
	seats = mustPositiveBillingSeatCount(seats)
	email := ""
	if actor != nil {
		email = billingTextValue(actor.Email)
	}
	return s.createCheckoutSession(ctx, owner, owner.OwnerName, email, planKey, interval, seats)
}

func (s *BillingService) CreateUserPortal(ctx context.Context, user *db.User) (BillingSessionResult, error) {
	if user == nil {
		return BillingSessionResult{}, pkgerrors.Unauthorized("authentication required")
	}
	return s.createPortalSession(ctx, billingOwnerRef{
		OwnerType: BillingOwnerTypeUser,
		OwnerID:   user.ID,
		OwnerName: user.Username,
	})
}

func (s *BillingService) CreateOrgPortal(ctx context.Context, actor *db.User, orgName string) (BillingSessionResult, error) {
	owner, err := s.resolveOrgOwner(ctx, actor, orgName)
	if err != nil {
		return BillingSessionResult{}, err
	}
	return s.createPortalSession(ctx, owner)
}

func (s *BillingService) RefreshUserBilling(ctx context.Context, user *db.User) (BillingOverview, error) {
	if user == nil {
		return BillingOverview{}, pkgerrors.Unauthorized("authentication required")
	}
	owner := billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: user.ID, OwnerName: user.Username}
	if err := s.refreshRemoteProjection(ctx, owner); err != nil {
		return BillingOverview{}, err
	}
	return s.ownerOverview(ctx, owner)
}

func (s *BillingService) RefreshOrgBilling(ctx context.Context, actor *db.User, orgName string) (BillingOverview, error) {
	owner, err := s.resolveOrgOwner(ctx, actor, orgName)
	if err != nil {
		return BillingOverview{}, err
	}
	if err := s.refreshRemoteProjection(ctx, owner); err != nil {
		return BillingOverview{}, err
	}
	// Manual repair lever for seat drift: refresh the authoritative Stripe
	// projection first, then compare it with current membership. This ordering
	// also repairs drift when the stale local quantity happened to equal the
	// seat count before refresh. Best-effort — a seat update failure must not
	// hide the otherwise-refreshed billing state.
	if err := s.ReconcileOrgSeats(ctx, owner.OwnerID); err != nil {
		slog.Warn("failed to reconcile org billing seats during refresh", "org_id", owner.OwnerID, "error", err)
	}
	return s.ownerOverview(ctx, owner)
}

// ReconcileOrgSeats syncs the Stripe subscription quantity for an org's
// per-seat plan to the current org member count. Called after org membership
// mutations so added seats are billed and removed seats credited (checkout
// only sets the quantity once, at session creation). No-op when Stripe is not
// configured, the org has no billing account, no live subscription exists, or
// the quantity already matches.
func (s *BillingService) ReconcileOrgSeats(ctx context.Context, orgID int64) error {
	if s.stripe == nil {
		return nil
	}
	account, err := s.findBillingAccountByOwner(ctx, BillingOwnerTypeOrg, orgID)
	if err != nil {
		return err
	}
	if account == nil {
		return nil
	}
	subscriptionRow, err := s.queries.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return pkgerrors.Internal("failed to load billing subscription").WithCause(err)
	}
	if strings.TrimSpace(subscriptionRow.StripeSubscriptionID) == "" {
		return nil
	}
	seats, err := s.currentSeatCount(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeOrg, OwnerID: orgID})
	if err != nil {
		return err
	}
	seats = mustPositiveBillingSeatCount(seats)
	if subscriptionRow.Quantity == seats {
		return nil
	}
	if err := s.stripe.UpdateSubscriptionQuantity(ctx, subscriptionRow.StripeSubscriptionID, seats); err != nil {
		return pkgerrors.Internal("failed to update stripe subscription seat quantity").WithCause(err)
	}
	// Refresh the local projection immediately so the DB row reflects the new
	// quantity; the customer.subscription.updated webhook confirms it later.
	snapshot, err := s.fetchSubscription(ctx, subscriptionRow.StripeSubscriptionID)
	if err != nil {
		return nil
	}
	return s.upsertSubscriptionSnapshot(ctx, *account, snapshot)
}

func (s *BillingService) HandleStripeWebhook(ctx context.Context, payload []byte, signature string) error {
	secret := strings.TrimSpace(s.config.StripeWebhookSecret)
	if secret == "" {
		return pkgerrors.BadRequest("stripe billing webhooks are not configured")
	}
	var event struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Created int64  `json:"created"`
		Data    struct {
			Raw json.RawMessage `json:"object"`
		} `json:"data"`
	}
	if !verifyStripeWebhookSignature(payload, signature, secret) || json.Unmarshal(payload, &event) != nil {
		return pkgerrors.BadRequest("invalid stripe webhook signature")
	}

	eventID := strings.TrimSpace(event.ID)
	if eventID == "" {
		return pkgerrors.BadRequest("stripe webhook event id is required")
	}
	occurred := unixToTime(event.Created)
	if txq, ok := s.queries.(billingTxQuerier); ok {
		return s.processStripeEventTx(ctx, txq, eventID, event.Type, occurred, event.Data.Raw)
	}
	// Non-transactional querier (test fakes): claim first, then release the
	// claim if processing fails so Stripe's retry can reprocess the event.
	claimed, err := s.claimStripeProcessedEvent(ctx, eventID, string(event.Type))
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	if err := s.handleStripeEvent(ctx, eventID, event.Type, occurred, event.Data.Raw); err != nil {
		_ = s.queries.DeleteStripeProcessedEvent(context.Background(), eventID)
		return err
	}
	return nil
}

// billingTxQuerier deliberately does not require a concrete WithTx result.
// A deployment query wrapper must retain its metering overrides when rebound.
// Webhook processing can claim the event and apply its DB side effects in one transaction, so a crash
// mid-processing rolls the claim back and Stripe's retry is not swallowed as
// an already-processed duplicate (an orphaned claim row would otherwise mark
// the event done with none of its side effects persisted).
type billingTxQuerier interface {
	BillingBaseQuerier
	BeginTx(ctx context.Context) (pgx.Tx, error)
}

// BillingQueryRebinder preserves a deployment's complete metering contract on
// the exact supplied database handle, including caller-owned transactions.
// Implementations must not open another connection or drop usage overrides.
type BillingQueryRebinder = billingstore.Rebinder

func (s *BillingService) inTransaction(conn db.DBTX) (*BillingService, error) {
	var rebound BillingBaseQuerier
	var err error
	if binder, ok := s.queries.(BillingQueryRebinder); ok {
		rebound, err = binder.RebindBillingQueries(conn)
	} else if _, ok := s.queries.(*db.Queries); ok {
		rebound = db.New(conn)

	}
	if err != nil {
		return nil, fmt.Errorf("billing: bind transaction queries: %w", err)
	}
	if rebound == nil {
		return nil, pkgerrors.Internal("billing transaction queries unavailable")
	}
	txService := *s
	txService.queries = rebound
	return &txService, nil
}

// processStripeEventTx claims the event and runs its side effects inside a
// single transaction: either the claim and every DB side effect commit
// together, or none do. A concurrent duplicate delivery blocks on the claim
// row insert and observes this transaction's outcome — skip after commit,
// reprocess after rollback.
func (s *BillingService) processStripeEventTx(ctx context.Context, txq billingTxQuerier, eventID, eventType string, occurred time.Time, raw json.RawMessage) error {
	tx, err := txq.BeginTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin stripe webhook transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	txService, err := s.inTransaction(tx)
	if err != nil {
		return err
	}
	// Credit granted or forfeited by the event commits with the claim and the
	// billing projection it follows from (smithersai/smithers#2175).
	if txService.credits, err = creditLedgerInTransaction(s.credits, tx); err != nil {
		return err
	}
	// Notices go out after commit: a sender may block, so never while the
	// transaction holds the credit account lock a model call's settlement
	// waits on, and never for an event that rolls back (smithersai/smithers#2193).
	var notices []billingNotice
	txService.notices = &notices
	claimed, err := txService.claimStripeProcessedEvent(ctx, eventID, eventType)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	if err := txService.handleStripeEvent(ctx, eventID, eventType, occurred, raw); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit stripe webhook transaction").WithCause(err)
	}
	for _, notice := range notices {
		s.sendBillingNotification(ctx, notice.account, notice.subject, notice.body)
	}
	return nil
}

// handleStripeEvent applies one event. occurred is when Stripe created it
// (zero when unknown); settlement ordering relies on it because Stripe
// delivers events out of order.
func (s *BillingService) handleStripeEvent(ctx context.Context, eventID string, eventType string, occurred time.Time, raw json.RawMessage) error {
	switch eventType {
	case "checkout.session.completed":
		var session stripeCheckoutSessionPayload
		if err := json.Unmarshal(raw, &session); err != nil {
			return pkgerrors.BadRequest("invalid checkout.session.completed payload")
		}
		return s.handleCheckoutSessionCompleted(ctx, session)
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		var subscription stripeSubscriptionPayload
		if err := json.Unmarshal(raw, &subscription); err != nil {
			return pkgerrors.BadRequest("invalid customer.subscription payload")
		}
		return s.handleSubscriptionEvent(ctx, subscription, raw, occurred)
	case "customer.subscription.trial_will_end":
		var subscription stripeSubscriptionPayload
		if err := json.Unmarshal(raw, &subscription); err != nil {
			return pkgerrors.BadRequest("invalid customer.subscription.trial_will_end payload")
		}
		return s.handleSubscriptionTrialWillEnd(ctx, subscription, raw, occurred)
	case "invoice.paid":
		var invoice stripeInvoicePaidPayload
		if err := json.Unmarshal(raw, &invoice); err != nil {
			return pkgerrors.BadRequest("invalid invoice.paid payload")
		}
		return s.handleInvoicePaid(ctx, invoice, occurred)
	case "invoice.payment_failed":
		var invoice stripeInvoicePaymentFailedPayload
		if err := json.Unmarshal(raw, &invoice); err != nil {
			return pkgerrors.BadRequest("invalid invoice.payment_failed payload")
		}
		return s.handleInvoicePaymentFailed(ctx, invoice)
	case "customer.updated":
		var customer stripeCustomerPayload
		if err := json.Unmarshal(raw, &customer); err != nil {
			return pkgerrors.BadRequest("invalid customer.updated payload")
		}
		return s.handleCustomerUpdated(ctx, customer)
	case "charge.refunded":
		var charge stripeChargePayload
		if err := json.Unmarshal(raw, &charge); err != nil {
			return pkgerrors.BadRequest("invalid charge.refunded payload")
		}
		return s.handleChargeRefunded(ctx, eventID, occurred, charge)
	case "charge.dispute.created":
		var dispute stripeDisputePayload
		if err := json.Unmarshal(raw, &dispute); err != nil {
			return pkgerrors.BadRequest("invalid charge.dispute.created payload")
		}
		return s.handleChargeDisputeCreated(ctx, eventID, occurred, dispute)
	case "entitlements.active_entitlement_summary.updated":
		var summary stripeEntitlementSummaryPayload
		if err := json.Unmarshal(raw, &summary); err != nil {
			return pkgerrors.BadRequest("invalid entitlement summary payload")
		}
		return s.handleEntitlementEvent(ctx, summary)
	default:
		return nil
	}
}

func (s *BillingService) AuthorizePrivateRepo(ctx context.Context, ownerType string, ownerID int64) error {
	if ownerType != BillingOwnerTypeUser && ownerType != BillingOwnerTypeOrg {
		return nil
	}
	owner := billingOwnerRef{OwnerType: ownerType, OwnerID: ownerID}
	plan, usage, _, _, err := s.resolveLocalState(ctx, owner)
	if err != nil {
		return err
	}
	return s.enforceMetricLimit(plan.Limits.PrivateRepos, usage[BillingMetricPrivateRepos], "private repositories")
}

// AuthorizePrivateRepoCommitted closes the private-repository check/create
// race. It holds the same per-owner advisory lock used by transfers and
// storage writers while recomputing the current private-repository count and
// while commit makes the consuming write durable. The advisory-lock-only
// transaction is rolled back afterward, so releasing the lock cannot turn an
// already-committed repository mutation into an apparent failure.
//
// Existing-repository callers must acquire the repository ownership lock
// before entering this method. New repositories do not yet have a stable id,
// so create, fork, and import paths acquire only this owner lock.
func (s *BillingService) AuthorizePrivateRepoCommitted(
	ctx context.Context,
	ownerType string,
	ownerID int64,
	commit func(ctx context.Context) error,
) error {
	if commit == nil {
		return pkgerrors.Internal("private repository commit is required")
	}
	if ownerID <= 0 || (ownerType != BillingOwnerTypeUser && ownerType != BillingOwnerTypeOrg) {
		return pkgerrors.Internal("invalid private repository billing owner")
	}

	txq, ok := s.queries.(billingTxQuerier)
	if !ok {
		if err := s.AuthorizePrivateRepo(ctx, ownerType, ownerID); err != nil {
			return err
		}
		return commit(ctx)
	}

	tx, err := txq.BeginTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin private repository authorization transaction").WithCause(err)
	}
	defer releaseBillingAdvisoryLockTransaction(ctx, tx, "private repository authorization")
	if _, err := tx.Exec(ctx, storageAuthorizationLockSQL, ownerType, ownerID); err != nil {
		return pkgerrors.Internal("failed to lock private repository usage").WithCause(err)
	}

	txService, err := s.inTransaction(tx)
	if err != nil {
		return err
	}
	owner := billingOwnerRef{OwnerType: ownerType, OwnerID: ownerID}
	plan, usage, _, _, err := txService.resolveLocalState(ctx, owner)
	if err != nil {
		return err
	}
	if err := txService.enforceMetricLimit(plan.Limits.PrivateRepos, usage[BillingMetricPrivateRepos], "private repositories"); err != nil {
		return err
	}
	return commit(ctx)
}

// pairingPlanRank orders plan keys so pairing can require Hobby ('personal')
// or above. Free/unknown rank 0; the paid floor is BillingPlanPersonal.
func pairingPlanRank(planKey string) int {
	switch strings.ToLower(strings.TrimSpace(planKey)) {
	case BillingPlanPersonal:
		return 1
	case BillingPlanPro, BillingPlanMax:
		return 2
	case BillingPlanTeam:
		return 3
	case BillingPlanEnterprise:
		return 4
	case BillingPlanCustom:
		// Custom (Stripe-provisioned) plans are always at least paid-tier.
		return 5
	default:
		return 0
	}
}

func (s *BillingService) AuthorizePairing(ctx context.Context, userID int64) error {
	owner := billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: userID}
	// Pairing only needs the effective PLAN, so use the lightweight plan-only
	// resolver rather than resolveLocalState. The latter also recomputes and
	// PERSISTS the full usage counters (~11 queries + 5 upserts) whose result we
	// discard here — and any transient failure in that write path would wrongly
	// DENY a legitimately-paid user's pair create/join. resolvePlan ignores
	// non-live subscription rows, so a lapsed Hobby user resolves to 'free' here
	// and is denied.
	plan, err := s.resolvePlan(ctx, owner)
	if err != nil {
		return err
	}
	if pairingPlanRank(plan.Key) < pairingPlanRank(BillingPlanPersonal) {
		return pkgerrors.Forbidden("pairing requires a paid plan (Hobby or above)")
	}
	return nil
}

// AuthorizeBranchLockJoin gates asking to JOIN a branch another user holds.
// Joining an occupied branch is multiplayer participation, so it uses the
// same paid floor as pairing (Hobby/'personal' or above; trialing counts).
// Free or lapsed users are Forbidden — the client turns that into the
// request-upgrade path.
func (s *BillingService) AuthorizeBranchLockJoin(ctx context.Context, userID int64) error {
	owner := billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: userID}
	plan, err := s.resolvePlan(ctx, owner)
	if err != nil {
		return err
	}
	if pairingPlanRank(plan.Key) < pairingPlanRank(BillingPlanPersonal) {
		return pkgerrors.Forbidden("joining an occupied branch requires a paid plan (Hobby or above)")
	}
	return nil
}

// resolvePlan resolves ONLY the effective plan for an owner (account -> latest
// live subscription -> plan tier/key), skipping the usage recompute+persist that
// resolveLocalState performs. Trialing counts as paid. Used by plan-gate checks
// (e.g. pairing) that need the tier but not the usage counters, so a transient
// usage-write failure cannot deny a paid user.
func (s *BillingService) resolvePlan(ctx context.Context, owner billingOwnerRef) (billingPlanDefinition, error) {
	plan := s.defaultPlan(owner.OwnerType)

	account, err := s.findBillingAccountByOwner(ctx, owner.OwnerType, owner.OwnerID)
	if err != nil {
		return billingPlanDefinition{}, err
	}
	if account == nil {
		return plan, nil
	}

	row, err := s.queries.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return plan, nil
		}
		return billingPlanDefinition{}, pkgerrors.Internal("failed to load billing subscription").WithCause(err)
	}
	return s.planForSubscription(owner.OwnerType, &row), nil
}

func (s *BillingService) AuthorizeWorkflowDispatch(ctx context.Context, repositoryID int64) error {
	owner, _, err := s.resolveRepoOwner(ctx, repositoryID)
	if err != nil {
		return err
	}
	plan, usage, _, _, err := s.resolveLocalState(ctx, owner)
	if err != nil {
		return err
	}
	return s.enforceMetricLimit(plan.Limits.CIMinutes, usage[BillingMetricCIMinutes], "CI minutes")
}

func (s *BillingService) AuthorizeAgentRun(ctx context.Context, repositoryID int64) error {
	owner, _, err := s.resolveRepoOwner(ctx, repositoryID)
	if err != nil {
		return err
	}
	plan, usage, _, _, err := s.resolveLocalState(ctx, owner)
	if err != nil {
		return err
	}
	return s.enforceMetricLimit(plan.Limits.AgentRuns, usage[BillingMetricAgentRuns], "agent runs")
}

func (s *BillingService) AuthorizeStorageIncrease(ctx context.Context, repositoryID int64, additionalBytes int64) error {
	if additionalBytes <= 0 {
		return nil
	}
	owner, _, err := s.resolveRepoOwner(ctx, repositoryID)
	if err != nil {
		return err
	}
	plan, usage, _, _, err := s.resolveLocalState(ctx, owner)
	if err != nil {
		return err
	}
	if storageIncreaseWithinLimit(plan.Limits.StorageBytes, usage[BillingMetricStorageBytes].ConsumedQuantity, additionalBytes) {
		return nil
	}
	return pkgerrors.Forbidden("storage cap exceeded for the current billing plan")
}

// AuthorizeStorageIncreaseCommitted closes the check-then-finalize race that
// plain AuthorizeStorageIncrease leaves open: two concurrent callers can both
// pass the cap check before either one's consuming write (e.g. confirming a
// release/LFS/artifact upload) becomes visible, letting the cap be overdrawn.
//
// It holds a per-owner Postgres advisory lock for the duration of the check
// AND the caller-supplied commit, so a second concurrent call for the same
// owner blocks on the lock until the first one's usage-changing write is
// durable, and its own usage check observes it. commit runs on its own
// connection/transaction and must commit itself before returning nil. The
// lock transaction contains only advisory locks and a best-effort usage
// projection; it is intentionally rolled back after commit returns so a
// second, fallible COMMIT can never turn an already-durable consuming write
// into an apparent failure. If commit errors, that error propagates.
//
// When the configured querier does not support transactions (unit-test
// fakes), this degrades to a plain check followed by an unserialized commit.
func (s *BillingService) AuthorizeStorageIncreaseCommitted(ctx context.Context, repositoryID, additionalBytes int64, commit func(ctx context.Context) error) error {
	if additionalBytes <= 0 {
		return commit(ctx)
	}
	return s.AuthorizeStorageIncreaseCommittedDynamic(ctx, repositoryID, func(context.Context) (int64, error) {
		return additionalBytes, nil
	}, commit)
}

// AuthorizeStorageIncreaseCommittedDynamic is the conditional form of
// AuthorizeStorageIncreaseCommitted. resolveAdditionalBytes runs after the
// per-owner advisory lock is acquired, allowing idempotent finalizers to
// re-check whether a concurrent caller already registered the same bytes. A
// zero result still runs commit but does not perform a quota increase check.
func (s *BillingService) AuthorizeStorageIncreaseCommittedDynamic(
	ctx context.Context,
	repositoryID int64,
	resolveAdditionalBytes func(ctx context.Context) (int64, error),
	commit func(ctx context.Context) error,
) error {
	if resolveAdditionalBytes == nil {
		return pkgerrors.Internal("storage increase resolver is required")
	}

	txq, ok := s.queries.(billingTxQuerier)
	if !ok {
		additionalBytes, err := resolveAdditionalBytes(ctx)
		if err != nil {
			return err
		}
		if additionalBytes < 0 {
			return pkgerrors.Internal("storage increase cannot be negative")
		}
		if additionalBytes > 0 {
			if err := s.AuthorizeStorageIncrease(ctx, repositoryID, additionalBytes); err != nil {
				return err
			}
		}
		return commit(ctx)
	}

	tx, err := txq.BeginTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin storage authorization transaction").WithCause(err)
	}
	defer releaseBillingAdvisoryLockTransaction(ctx, tx, "storage authorization")

	// Ownership-changing operations take the exclusive form of this lock. A
	// storage finalizer must acquire the shared form before resolving the owner,
	// otherwise it can read the old owner, wait behind a transfer on that stale
	// owner's quota lock, and commit bytes after ownership changed.
	if _, err := tx.Exec(ctx, repoOwnershipSharedLockSQL, repositoryID); err != nil {
		return pkgerrors.Internal("failed to lock repository ownership").WithCause(err)
	}
	txService, err := s.inTransaction(tx)
	if err != nil {
		return err
	}
	owner, _, err := txService.resolveRepoOwner(ctx, repositoryID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, storageAuthorizationLockSQL, owner.OwnerType, owner.OwnerID); err != nil {
		return pkgerrors.Internal("failed to lock storage usage").WithCause(err)
	}
	additionalBytes, err := resolveAdditionalBytes(ctx)
	if err != nil {
		return err
	}
	if additionalBytes < 0 {
		return pkgerrors.Internal("storage increase cannot be negative")
	}

	if additionalBytes > 0 {
		plan, usage, _, _, err := txService.resolveLocalState(ctx, owner)
		if err != nil {
			return err
		}
		if !storageIncreaseWithinLimit(plan.Limits.StorageBytes, usage[BillingMetricStorageBytes].ConsumedQuantity, additionalBytes) {
			return pkgerrors.Forbidden("storage cap exceeded for the current billing plan")
		}
	}

	if err := commit(ctx); err != nil {
		return err
	}

	return nil
}

// AuthorizeRepositoryTransferCommitted admits a repository transfer against
// the destination owner's private-repository and storage limits. The caller
// must already hold the repository_ownership exclusive lock; this method then
// takes the destination owner's storage lock and holds it across the supplied
// apply/stage/COMMIT callback. All committed storage writers acquire locks in
// the same repository -> owner order, avoiding stale-owner quota writes and
// deadlocks.
//
// The repository still belongs to the source owner from this transaction's
// point of view, so the destination usage excludes it. Its exact footprint is
// measured separately by stable repository id and admitted overflow-safely.
func (s *BillingService) AuthorizeRepositoryTransferCommitted(
	ctx context.Context,
	repositoryID int64,
	targetOwnerType string,
	targetOwnerID int64,
	privateRepository bool,
	commit func(ctx context.Context) error,
) error {
	if commit == nil {
		return pkgerrors.Internal("repository transfer commit is required")
	}
	if repositoryID <= 0 || targetOwnerID <= 0 || (targetOwnerType != BillingOwnerTypeUser && targetOwnerType != BillingOwnerTypeOrg) {
		return pkgerrors.Internal("invalid repository transfer billing owner")
	}
	target := billingOwnerRef{OwnerType: targetOwnerType, OwnerID: targetOwnerID}

	txq, ok := s.queries.(billingTxQuerier)
	if !ok {
		if err := s.authorizeRepositoryTransferUsage(ctx, repositoryID, target, privateRepository); err != nil {
			return err
		}
		return commit(ctx)
	}

	tx, err := txq.BeginTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to begin repository transfer authorization transaction").WithCause(err)
	}
	defer releaseBillingAdvisoryLockTransaction(ctx, tx, "repository transfer authorization")
	if _, err := tx.Exec(ctx, storageAuthorizationLockSQL, target.OwnerType, target.OwnerID); err != nil {
		return pkgerrors.Internal("failed to lock target owner storage usage").WithCause(err)
	}

	txService, err := s.inTransaction(tx)
	if err != nil {
		return err
	}
	if err := txService.authorizeRepositoryTransferUsage(ctx, repositoryID, target, privateRepository); err != nil {
		return err
	}
	if err := commit(ctx); err != nil {
		return err
	}
	return nil
}

// AuthorizeRepositoryTransferCommittedInTransaction performs transfer
// admission on the caller's already advisory-locked ownership transaction.
// Sharing the transaction is required in production: opening a second billing
// transaction while the first holds the repository lock can deadlock a
// single-connection pool and splits the quota decision from the consuming
// ownership commit.
func (s *BillingService) AuthorizeRepositoryTransferCommittedInTransaction(
	ctx context.Context,
	tx db.DBTX,
	repositoryID int64,
	targetOwnerType string,
	targetOwnerID int64,
	privateRepository bool,
	commit func(ctx context.Context) error,
) error {
	if commit == nil {
		return pkgerrors.Internal("repository transfer commit is required")
	}
	if tx == nil || repositoryID <= 0 || targetOwnerID <= 0 ||
		(targetOwnerType != BillingOwnerTypeUser && targetOwnerType != BillingOwnerTypeOrg) {
		return pkgerrors.Internal("invalid repository transfer billing owner")
	}
	target := billingOwnerRef{OwnerType: targetOwnerType, OwnerID: targetOwnerID}
	if _, err := tx.Exec(ctx, storageAuthorizationLockSQL, target.OwnerType, target.OwnerID); err != nil {
		return pkgerrors.Internal("failed to lock target owner storage usage").WithCause(err)
	}

	txService, err := s.inTransaction(tx)
	if err != nil {
		return err
	}
	if err := txService.authorizeRepositoryTransferUsage(ctx, repositoryID, target, privateRepository); err != nil {
		return err
	}
	return commit(ctx)
}

func releaseBillingAdvisoryLockTransaction(parent context.Context, tx pgx.Tx, operation string) {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(parent), billingAdvisoryLockReleaseTimeout)
	defer cancel()
	if err := tx.Rollback(releaseCtx); err != nil && !stdErrors.Is(err, pgx.ErrTxClosed) {
		// A pgxpool transaction discards/releases a broken connection. The
		// consuming callback is already durable, so this cleanup failure is
		// operational telemetry, never a reason to report that write as failed.
		slog.Error("failed to release billing advisory lock transaction", "operation", operation, "error", err)
	}
}

func (s *BillingService) authorizeRepositoryTransferUsage(ctx context.Context, repositoryID int64, target billingOwnerRef, privateRepository bool) error {
	footprint, err := s.queries.SumStorageBytesByRepository(ctx, repositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to measure repository storage").WithCause(err)
	}
	if footprint < 0 {
		return pkgerrors.Internal("repository storage footprint cannot be negative")
	}
	if !privateRepository && footprint == 0 {
		return nil
	}

	plan, usage, _, _, err := s.resolveLocalState(ctx, target)
	if err != nil {
		return err
	}
	if privateRepository {
		if err := s.enforceMetricLimit(plan.Limits.PrivateRepos, usage[BillingMetricPrivateRepos], "private repositories"); err != nil {
			return err
		}
	}
	if !storageIncreaseWithinLimit(plan.Limits.StorageBytes, usage[BillingMetricStorageBytes].ConsumedQuantity, footprint) {
		return pkgerrors.Forbidden("storage cap exceeded for the target owner's billing plan")
	}
	return nil
}

// storageIncreaseWithinLimit compares against the remaining finite capacity
// instead of adding two caller/data-controlled int64 values. The latter can
// wrap negative and accidentally authorize an upload larger than the plan.
func storageIncreaseWithinLimit(limit, consumed, additional int64) bool {
	if additional <= 0 {
		return true
	}
	if limit < 0 || consumed < 0 {
		return false
	}
	if limit >= unlimitedBillingQuantity {
		return true
	}
	if consumed > limit {
		return false
	}
	return additional <= limit-consumed
}

// StorageCommitAuthorizer is the optional BillingPolicy extension implemented
// by *BillingService: it serializes the storage-cap check with the caller's
// finalizing write behind a per-owner advisory lock (see
// AuthorizeStorageIncreaseCommitted).
type StorageCommitAuthorizer interface {
	AuthorizeStorageIncreaseCommitted(ctx context.Context, repositoryID, additionalBytes int64, commit func(ctx context.Context) error) error
}

// DynamicStorageCommitAuthorizer lets an idempotent storage finalizer resolve
// its actual byte delta while holding the same owner lock used for the quota
// check. Production BillingService implements both this and
// StorageCommitAuthorizer; the separate interface preserves compatibility with
// existing policy fakes.
type DynamicStorageCommitAuthorizer interface {
	AuthorizeStorageIncreaseCommittedDynamic(
		ctx context.Context,
		repositoryID int64,
		resolveAdditionalBytes func(ctx context.Context) (int64, error),
		commit func(ctx context.Context) error,
	) error
}

// RepositoryTransferCommitAuthorizer is the optional BillingPolicy extension
// used by serialized repository transfers. Production BillingService meters
// both private-repository count and the repository's complete storage
// footprint while holding the destination owner's quota lock through COMMIT.
type RepositoryTransferCommitAuthorizer interface {
	AuthorizeRepositoryTransferCommitted(
		ctx context.Context,
		repositoryID int64,
		targetOwnerType string,
		targetOwnerID int64,
		privateRepository bool,
		commit func(ctx context.Context) error,
	) error
}

// RepositoryTransferTransactionAuthorizer is the production transfer
// extension used when the ownership transaction can expose its DB handle.
// It keeps repository and destination-owner advisory locks on one connection
// and holds both through the consuming COMMIT.
type RepositoryTransferTransactionAuthorizer interface {
	AuthorizeRepositoryTransferCommittedInTransaction(
		ctx context.Context,
		tx db.DBTX,
		repositoryID int64,
		targetOwnerType string,
		targetOwnerID int64,
		privateRepository bool,
		commit func(ctx context.Context) error,
	) error
}

// PrivateRepoCommitAuthorizer is the optional BillingPolicy extension used by
// every operation that makes one more private repository visible. Production
// *BillingService holds the owner's quota lock through the consuming write;
// simpler policy fakes retain the check-then-commit fallback below.
type PrivateRepoCommitAuthorizer interface {
	AuthorizePrivateRepoCommitted(
		ctx context.Context,
		ownerType string,
		ownerID int64,
		commit func(ctx context.Context) error,
	) error
}

// authorizePrivateRepoThenCommit centralizes private-repository admission.
// The callback is guarded so a malformed authorizer cannot apply a consuming
// mutation zero or multiple times while reporting success.
func authorizePrivateRepoThenCommit(
	ctx context.Context,
	policy BillingPolicy,
	ownerType string,
	ownerID int64,
	privateRepository bool,
	commit func(ctx context.Context) error,
) error {
	if commit == nil {
		return pkgerrors.Internal("private repository commit is required")
	}
	if !privateRepository || policy == nil {
		return commit(ctx)
	}
	if committed, ok := policy.(PrivateRepoCommitAuthorizer); ok {
		called := false
		err := committed.AuthorizePrivateRepoCommitted(ctx, ownerType, ownerID, func(commitCtx context.Context) error {
			if called {
				return pkgerrors.Internal("private repository commit called more than once")
			}
			called = true
			return commit(commitCtx)
		})
		if err != nil {
			return err
		}
		if !called {
			return pkgerrors.Internal("private repository was not committed")
		}
		return nil
	}
	if err := policy.AuthorizePrivateRepo(ctx, ownerType, ownerID); err != nil {
		return err
	}
	return commit(ctx)
}

// authorizeStorageIncreaseThenCommit meters additionalBytes against policy
// and, only if allowed, invokes commit — the storage-consuming write. It is
// the single entry point every storage path (LFS, workflow artifacts and
// caches, release assets, issue artifacts) uses to close issue 136's
// check-then-finalize race: when policy implements StorageCommitAuthorizer
// (production *BillingService), the check and the commit are serialized
// behind a per-owner lock. A nil policy runs commit ungated, and a
// base-interface fake degrades to a plain check followed by an unserialized
// commit.
func authorizeStorageIncreaseThenCommit(ctx context.Context, policy BillingPolicy, repositoryID, additionalBytes int64, commit func(ctx context.Context) error) error {
	if policy == nil {
		return commit(ctx)
	}
	if committed, ok := policy.(StorageCommitAuthorizer); ok {
		return committed.AuthorizeStorageIncreaseCommitted(ctx, repositoryID, additionalBytes, commit)
	}
	if err := policy.AuthorizeStorageIncrease(ctx, repositoryID, additionalBytes); err != nil {
		return err
	}
	return commit(ctx)
}

// authorizeStorageIncreaseThenCommitDynamic is the idempotent-finalizer
// variant. Production resolves additionalBytes while holding the billing
// owner's storage lock; older fakes fall back to resolving immediately before
// their existing authorization path.
func authorizeStorageIncreaseThenCommitDynamic(
	ctx context.Context,
	policy BillingPolicy,
	repositoryID int64,
	resolveAdditionalBytes func(ctx context.Context) (int64, error),
	commit func(ctx context.Context) error,
) error {
	if policy == nil {
		if _, err := resolveAdditionalBytes(ctx); err != nil {
			return err
		}
		return commit(ctx)
	}
	if dynamic, ok := policy.(DynamicStorageCommitAuthorizer); ok {
		return dynamic.AuthorizeStorageIncreaseCommittedDynamic(ctx, repositoryID, resolveAdditionalBytes, commit)
	}
	additionalBytes, err := resolveAdditionalBytes(ctx)
	if err != nil {
		return err
	}
	if additionalBytes == 0 {
		return commit(ctx)
	}
	return authorizeStorageIncreaseThenCommit(ctx, policy, repositoryID, additionalBytes, commit)
}

func (s *BillingService) ownerOverview(ctx context.Context, owner billingOwnerRef) (BillingOverview, error) {
	plan, usage, account, subscription, err := s.resolveLocalState(ctx, owner)
	if err != nil {
		return BillingOverview{}, err
	}

	entitlements := []BillingEntitlementSummary{}
	if account != nil {
		rows, err := s.queries.ListBillingEntitlementsByAccount(ctx, account.ID)
		if err != nil {
			return BillingOverview{}, pkgerrors.Internal("failed to load billing entitlements").WithCause(err)
		}
		entitlements = make([]BillingEntitlementSummary, 0, len(rows))
		for _, row := range rows {
			entitlements = append(entitlements, BillingEntitlementSummary{
				FeatureKey:   row.FeatureKey,
				Active:       row.Active,
				LastSyncedAt: row.LastSyncedAt,
			})
		}
	}

	var sandbox SandboxEntitlement
	if owner.OwnerType == BillingOwnerTypeUser {
		sandbox, err = s.SandboxEntitlement(ctx, owner.OwnerID)
		if err != nil {
			return BillingOverview{}, err
		}
	}
	periodStart, periodEnd := billingPeriodWindow(s.now())
	out := BillingOverview{
		Sandbox:          sandbox,
		OwnerType:        owner.OwnerType,
		OwnerID:          owner.OwnerID,
		OwnerName:        owner.OwnerName,
		PlanKey:          plan.Key,
		BillingInterval:  plan.Interval,
		StripeConfigured: s.stripe != nil,
		Entitlements:     entitlements,
		UsagePeriodStart: periodStart,
		UsagePeriodEnd:   periodEnd,
		Usage:            orderUsageSummaries(usage),
	}
	if account != nil {
		out.Account = &BillingAccountSummary{
			ID:                  account.ID,
			StripeCustomerID:    account.StripeCustomerID,
			StripeCustomerEmail: account.StripeCustomerEmail,
			StripeCustomerName:  account.StripeCustomerName,
			CreatedAt:           account.CreatedAt,
			UpdatedAt:           account.UpdatedAt,
		}
	}
	if s.credits != nil {
		balance, charged, count, err := s.credits.OwnerSummary(ctx, owner.OwnerType, owner.OwnerID)
		if err != nil {
			return BillingOverview{}, pkgerrors.Internal("failed to load credit balance").WithCause(err)
		}
		out.CreditBalanceNanos, out.CreditBalanceCents = balance, balance/credits.NanosPerCent
		out.LifetimeChargedNanos, out.ChargeCount = charged, count
	}
	if subscription != nil {
		out.Subscription = &BillingSubscriptionSummary{
			StripeSubscriptionID: subscription.StripeSubscriptionID,
			StripePriceID:        subscription.StripePriceID,
			PlanKey:              subscription.PlanKey,
			BillingInterval:      subscription.BillingInterval,
			Status:               subscription.Status,
			Quantity:             subscription.Quantity,
			TrialEnd:             nullableTime(subscription.TrialEnd),
			CurrentPeriodStart:   nullableTime(subscription.CurrentPeriodStart),
			CurrentPeriodEnd:     nullableTime(subscription.CurrentPeriodEnd),
			CancelAtPeriodEnd:    subscription.CancelAtPeriodEnd,
			CanceledAt:           nullableTime(subscription.CanceledAt),
		}
	}
	return out, nil
}

func (s *BillingService) resolveLocalState(ctx context.Context, owner billingOwnerRef) (billingPlanDefinition, map[string]BillingUsageSummary, *db.BillingAccount, *db.BillingSubscription, error) {
	plan := s.defaultPlan(owner.OwnerType)

	account, err := s.findBillingAccountByOwner(ctx, owner.OwnerType, owner.OwnerID)
	if err != nil {
		return billingPlanDefinition{}, nil, nil, nil, err
	}

	var subscription *db.BillingSubscription
	if account != nil {
		row, err := s.queries.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
		if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
			return billingPlanDefinition{}, nil, nil, nil, pkgerrors.Internal("failed to load billing subscription").WithCause(err)
		}
		if err == nil {
			subscription = &row
			plan = s.planForSubscription(owner.OwnerType, &row)
		}
	}

	usage, err := s.computeAndPersistUsage(ctx, owner, plan.Limits)
	if err != nil {
		return billingPlanDefinition{}, nil, nil, nil, err
	}
	return plan, usage, account, subscription, nil
}

func (s *BillingService) computeAndPersistUsage(ctx context.Context, owner billingOwnerRef, limits billingPlanLimits) (map[string]BillingUsageSummary, error) {
	periodStart, periodEnd := billingPeriodWindow(s.now())

	privateRepos, err := s.queries.CountPrivateReposByOwner(ctx, db.CountPrivateReposByOwnerParams{
		OwnerType: owner.OwnerType,
		OwnerID:   owner.OwnerID,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to count private repositories").WithCause(err)
	}
	storageBytes, err := s.queries.SumStorageBytesByOwner(ctx, db.SumStorageBytesByOwnerParams{
		OwnerType: owner.OwnerType,
		OwnerID:   owner.OwnerID,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to measure storage usage").WithCause(err)
	}
	ciMinutes, err := s.queries.SumWorkflowMinutesByOwner(ctx, db.SumWorkflowMinutesByOwnerParams{
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
		OwnerType:   owner.OwnerType,
		OwnerID:     owner.OwnerID,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to measure workflow usage").WithCause(err)
	}
	agentRuns, err := s.queries.CountAgentRunsByOwner(ctx, db.CountAgentRunsByOwnerParams{
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
		OwnerType:   owner.OwnerType,
		OwnerID:     owner.OwnerID,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to measure agent usage").WithCause(err)
	}
	seats, err := s.currentSeatCount(ctx, owner)
	if err != nil {
		return nil, err
	}

	var sandboxHours int64
	includedHours := limits.SandboxHoursPerDay
	if includedHours < unlimitedBillingQuantity {
		includedHours *= int64(periodEnd.Sub(periodStart) / (24 * time.Hour))
	}
	if owner.OwnerType == BillingOwnerTypeUser {
		q, ok := s.queries.(BillingQuerier)
		if !ok {
			return nil, pkgerrors.Internal("sandbox metering store unavailable")
		}
		seconds, err := q.SumSandboxAwakeSecondsForUserSince(ctx, owner.OwnerID, periodStart)
		if err != nil {
			return nil, err
		}
		sandboxHours = seconds / 3600
		if seconds%3600 > 0 {
			sandboxHours++
		}
	}
	metrics := map[string]BillingUsageSummary{
		BillingMetricPrivateRepos: {MetricKey: BillingMetricPrivateRepos, IncludedQuantity: limits.PrivateRepos, ConsumedQuantity: privateRepos, OverageQuantity: overageQuantity(privateRepos, limits.PrivateRepos)},
		BillingMetricStorageBytes: {MetricKey: BillingMetricStorageBytes, IncludedQuantity: limits.StorageBytes, ConsumedQuantity: storageBytes, OverageQuantity: overageQuantity(storageBytes, limits.StorageBytes)},
		BillingMetricCIMinutes:    {MetricKey: BillingMetricCIMinutes, IncludedQuantity: limits.CIMinutes, ConsumedQuantity: ciMinutes, OverageQuantity: overageQuantity(ciMinutes, limits.CIMinutes)},
		BillingMetricAgentRuns:    {MetricKey: BillingMetricAgentRuns, IncludedQuantity: limits.AgentRuns, ConsumedQuantity: agentRuns, OverageQuantity: overageQuantity(agentRuns, limits.AgentRuns)},
		BillingMetricSeats:        {MetricKey: BillingMetricSeats, IncludedQuantity: limits.Seats, ConsumedQuantity: seats, OverageQuantity: overageQuantity(seats, limits.Seats)},
	}

	if owner.OwnerType == BillingOwnerTypeUser {
		metrics[BillingMetricSandboxHours] = BillingUsageSummary{MetricKey: BillingMetricSandboxHours, IncludedQuantity: includedHours, ConsumedQuantity: sandboxHours, OverageQuantity: overageQuantity(sandboxHours, includedHours)}
	}
	for _, metric := range metrics {
		if _, err := s.queries.UpsertBillingUsageCounter(ctx, db.UpsertBillingUsageCounterParams{
			OwnerType:                owner.OwnerType,
			OwnerID:                  owner.OwnerID,
			MetricKey:                metric.MetricKey,
			PeriodStart:              periodStart,
			PeriodEnd:                periodEnd,
			IncludedQuantity:         metric.IncludedQuantity,
			ConsumedQuantity:         metric.ConsumedQuantity,
			OverageQuantity:          metric.OverageQuantity,
			LastReportedMeterEventID: "",
			LastSyncedAt:             s.now(),
		}); err != nil {
			return nil, pkgerrors.Internal("failed to persist billing usage counters").WithCause(err)
		}
	}

	rows, err := s.queries.ListBillingUsageCountersByOwnerAndPeriod(ctx, db.ListBillingUsageCountersByOwnerAndPeriodParams{
		OwnerType:   owner.OwnerType,
		OwnerID:     owner.OwnerID,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to load billing usage counters").WithCause(err)
	}

	out := map[string]BillingUsageSummary{}
	for _, row := range rows {
		out[row.MetricKey] = BillingUsageSummary{
			MetricKey:        row.MetricKey,
			IncludedQuantity: row.IncludedQuantity,
			ConsumedQuantity: row.ConsumedQuantity,
			OverageQuantity:  row.OverageQuantity,
		}
	}
	return out, nil
}

func (s *BillingService) createCheckoutSession(ctx context.Context, owner billingOwnerRef, customerName, customerEmail, planKey, interval string, quantity int64) (BillingSessionResult, error) {
	if s.stripe == nil {
		return BillingSessionResult{}, pkgerrors.BadRequest("stripe billing is not configured")
	}
	plan, err := s.checkoutPlan(owner.OwnerType, planKey, interval)
	if err != nil {
		return BillingSessionResult{}, err
	}
	account, err := s.ensureBillingAccount(ctx, owner, customerName, customerEmail)
	if err != nil {
		return BillingSessionResult{}, err
	}
	// One paid subscription per owner: a second checkout would double-charge —
	// plan changes go through the Stripe customer portal (proration included).
	existing, err := s.queries.GetLatestLiveBillingSubscriptionByAccount(ctx, account.ID)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return BillingSessionResult{}, pkgerrors.Internal("failed to load billing subscription").WithCause(err)
	}
	if err == nil && paidSubscriptionStatus(existing.Status) {
		return BillingSessionResult{}, pkgerrors.BadRequest("a subscription is already active — change plans in the billing portal instead")
	}
	// Stripe is the serialization point between the local pre-check and the
	// subscription webhook. The newest session's id becomes the next checkout
	// generation: concurrent requests see the same generation and therefore use
	// the same idempotency key. Matching open sessions are reused; a completed
	// session blocks another charge while its webhook catches up.
	latest, found, err := s.stripe.GetLatestCheckoutSession(ctx, account.StripeCustomerID)
	if err != nil {
		return BillingSessionResult{}, pkgerrors.Internal("failed to inspect stripe checkout sessions").WithCause(err)
	}
	checkoutGeneration := "initial"
	if found {
		checkoutGeneration = strings.TrimSpace(latest.ID)
		if checkoutGeneration == "" {
			return BillingSessionResult{}, pkgerrors.Internal("stripe checkout session is missing an id")
		}
		switch strings.ToLower(strings.TrimSpace(latest.Status)) {
		case "open":
			if checkoutSessionMatches(latest, owner, plan, quantity) {
				if strings.TrimSpace(latest.URL) == "" {
					return BillingSessionResult{}, pkgerrors.Internal("stripe checkout session is missing a url")
				}
				return BillingSessionResult{URL: latest.URL}, nil
			}
			if err := s.stripe.ExpireCheckoutSession(ctx, latest.ID); err != nil {
				return BillingSessionResult{}, pkgerrors.Internal("failed to expire stale stripe checkout session").WithCause(err)
			}
		case "complete":
			// A completed session whose subscription has not reached the local
			// projection may already have charged the customer, so fail closed
			// while its webhook catches up. Once that exact subscription is
			// projected as lapsed, this session is merely the previous generation
			// and a fresh checkout is legitimate.
			projected, paid, projectionErr := s.checkoutSubscriptionProjection(ctx, account.ID, latest.SubscriptionID)
			if projectionErr != nil {
				return BillingSessionResult{}, projectionErr
			}
			if !projected || paid {
				return BillingSessionResult{}, pkgerrors.BadRequest("checkout is already complete — refresh billing before starting another checkout")
			}
		case "expired":
			// A new generation may safely replace an expired session.
		default:
			return BillingSessionResult{}, pkgerrors.Internal("stripe checkout session has an unknown status")
		}
	}
	result, err := s.stripe.CreateCheckoutSession(ctx, StripeCreateCheckoutSessionInput{
		CustomerID:         account.StripeCustomerID,
		SuccessURL:         s.checkoutSuccessURL(owner),
		CancelURL:          s.checkoutCancelURL(owner),
		PriceID:            plan.PriceID,
		Quantity:           quantity,
		CheckoutGeneration: checkoutGeneration,
		Metadata: map[string]string{
			"owner_type":        owner.OwnerType,
			"owner_id":          strconv.FormatInt(owner.OwnerID, 10),
			"plan_key":          plan.Key,
			"interval":          plan.Interval,
			"checkout_quantity": strconv.FormatInt(quantity, 10),
		},
		TermsOfServiceAcceptance: checkoutRenewalTerms(plan.Interval),
	})
	if err != nil {
		return BillingSessionResult{}, pkgerrors.Internal("failed to create stripe checkout session").WithCause(err)
	}
	return BillingSessionResult{URL: result.URL}, nil
}

func checkoutSessionMatches(session StripeCheckoutSessionSnapshot, owner billingOwnerRef, plan billingPlanDefinition, quantity int64) bool {
	return strings.TrimSpace(session.Metadata["owner_type"]) == owner.OwnerType &&
		strings.TrimSpace(session.Metadata["owner_id"]) == strconv.FormatInt(owner.OwnerID, 10) &&
		strings.TrimSpace(session.Metadata["plan_key"]) == plan.Key &&
		strings.TrimSpace(session.Metadata["interval"]) == plan.Interval &&
		strings.TrimSpace(session.Metadata["checkout_quantity"]) == strconv.FormatInt(quantity, 10)
}

func (s *BillingService) checkoutSubscriptionProjection(ctx context.Context, accountID int64, subscriptionID string) (projected bool, paid bool, err error) {
	subscriptionID = strings.TrimSpace(subscriptionID)
	if subscriptionID == "" {
		return false, false, nil
	}
	rows, listErr := s.queries.ListBillingSubscriptionsByAccount(ctx, accountID)
	if listErr != nil {
		return false, false, pkgerrors.Internal("failed to inspect billing subscriptions").WithCause(listErr)
	}
	for _, row := range rows {
		if strings.TrimSpace(row.StripeSubscriptionID) == subscriptionID {
			return true, paidSubscriptionStatus(row.Status), nil
		}
	}
	return false, false, nil
}

func (s *BillingService) createPortalSession(ctx context.Context, owner billingOwnerRef) (BillingSessionResult, error) {
	if s.stripe == nil {
		return BillingSessionResult{}, pkgerrors.BadRequest("stripe billing is not configured")
	}
	account, err := s.findBillingAccountByOwner(ctx, owner.OwnerType, owner.OwnerID)
	if err != nil {
		return BillingSessionResult{}, err
	}
	if account == nil {
		return BillingSessionResult{}, pkgerrors.NotFound("billing account not found")
	}
	url, err := s.stripe.CreatePortalSession(ctx, StripeCreatePortalSessionInput{
		CustomerID: account.StripeCustomerID,
		ReturnURL:  s.portalReturnURL(owner),
	})
	if err != nil {
		return BillingSessionResult{}, pkgerrors.Internal("failed to create stripe customer portal session").WithCause(err)
	}
	return BillingSessionResult{URL: url}, nil
}

func (s *BillingService) refreshRemoteProjection(ctx context.Context, owner billingOwnerRef) error {
	if s.stripe == nil {
		return pkgerrors.BadRequest("stripe billing is not configured")
	}
	account, err := s.findBillingAccountByOwner(ctx, owner.OwnerType, owner.OwnerID)
	if err != nil {
		return err
	}
	if account == nil {
		return nil
	}

	subscription, err := s.queries.GetLatestBillingSubscriptionByAccount(ctx, account.ID)
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to load billing subscription").WithCause(err)
	}
	if err == nil && strings.TrimSpace(subscription.StripeSubscriptionID) != "" {
		snapshot, err := s.fetchSubscription(ctx, subscription.StripeSubscriptionID)
		if err != nil {
			return pkgerrors.Internal("failed to refresh stripe subscription").WithCause(err)
		}
		if err := s.upsertSubscriptionSnapshot(ctx, *account, snapshot); err != nil {
			return err
		}
	}

	entitlements, err := s.stripe.ListActiveEntitlements(ctx, account.StripeCustomerID)
	if err != nil {
		return pkgerrors.Internal("failed to refresh stripe entitlements").WithCause(err)
	}
	if err := s.replaceEntitlements(ctx, account.ID, entitlements); err != nil {
		return err
	}
	return nil
}

func (s *BillingService) handleCheckoutSessionCompleted(ctx context.Context, session stripeCheckoutSessionPayload) error {
	owner, ok := ownerFromMetadata(session.Metadata)
	if !ok {
		account, err := s.findBillingAccountByCustomerID(ctx, session.Customer)
		if err != nil {
			return err
		}
		if account == nil {
			return nil
		}
		owner = billingOwnerRef{
			OwnerType: account.OwnerType,
			OwnerID:   account.OwnerID,
			OwnerName: account.StripeCustomerName,
		}
	}
	account, err := s.upsertBillingAccount(ctx, owner, session.Customer, session.CustomerDetails.Name, session.CustomerDetails.Email)
	if err != nil {
		return err
	}
	if s.stripe != nil && strings.TrimSpace(session.Subscription) != "" {
		// A failed fetch fails the webhook so Stripe redelivers it; the
		// transaction rolls the event claim back.
		snapshot, err := s.fetchSubscription(ctx, session.Subscription)
		if err != nil {
			return pkgerrors.Internal("failed to load stripe subscription after checkout").WithCause(err)
		}
		return s.projectWebhookSubscription(ctx, account, snapshot)
	}
	return nil
}

func (s *BillingService) handleSubscriptionEvent(ctx context.Context, payload stripeSubscriptionPayload, raw json.RawMessage, occurred time.Time) error {
	account, err := s.findBillingAccountByCustomerID(ctx, payload.Customer)
	if err != nil {
		return err
	}
	if account == nil {
		owner, ok := ownerFromMetadata(payload.Metadata)
		if !ok {
			return nil
		}
		row, err := s.upsertBillingAccount(ctx, owner, payload.Customer, "", "")
		if err != nil {
			return err
		}
		account = &row
	}
	account = mustResolvedBillingAccount(account)
	// Stripe delivers subscription webhooks without ordering guarantees, so a stale
	// customer.subscription.updated can carry an old "active" status and overwrite a
	// newer "canceled" state — resurrecting a canceled subscription. Re-fetch the
	// current subscription from Stripe and persist that authoritative snapshot
	// (mirroring handleCheckoutSessionCompleted). A failed fetch fails the webhook
	// so Stripe redelivers it. Only without Stripe (offline/tests) is the payload
	// projected, as of the event's creation.
	if s.stripe == nil || strings.TrimSpace(payload.ID) == "" {
		return s.projectWebhookSubscription(ctx, *account, observedSubscription{snapshotFromWebhookSubscription(payload, raw), occurred})
	}
	snapshot, err := s.fetchSubscription(ctx, payload.ID)
	if err != nil {
		return pkgerrors.Internal("failed to load stripe subscription").WithCause(err)
	}
	return s.projectWebhookSubscription(ctx, *account, snapshot)
}

func (s *BillingService) handleSubscriptionTrialWillEnd(ctx context.Context, payload stripeSubscriptionPayload, raw json.RawMessage, occurred time.Time) error {
	if err := s.handleSubscriptionEvent(ctx, payload, raw, occurred); err != nil {
		return err
	}
	account, err := s.findBillingAccountByCustomerID(ctx, payload.Customer)
	if err != nil || account == nil {
		return err
	}
	trialEnd := unixToTime(payload.TrialEnd)
	when := "soon"
	if !trialEnd.IsZero() {
		when = trialEnd.Format("January 2, 2006")
	}
	body := fmt.Sprintf(
		"Your Smithers trial for %s ends on %s. Add or confirm a payment method before the trial ends to keep paid features active.\n\nManage billing: %s",
		billingOwnerDisplayName(*account),
		when,
		s.billingPortalURLForAccount(*account),
	)
	s.sendBillingNotification(ctx, *account, "Your Smithers trial is ending soon", body)
	return nil
}

func (s *BillingService) handleInvoicePaymentFailed(ctx context.Context, payload stripeInvoicePaymentFailedPayload) error {
	account, err := s.findBillingAccountByCustomerID(ctx, payload.Customer)
	if err != nil || account == nil {
		return err
	}
	if strings.TrimSpace(payload.CustomerEmail) != "" || strings.TrimSpace(payload.CustomerName) != "" {
		owner := billingOwnerRef{OwnerType: account.OwnerType, OwnerID: account.OwnerID, OwnerName: account.StripeCustomerName}
		updated, updateErr := s.upsertBillingAccount(ctx, owner, account.StripeCustomerID, nonEmpty(payload.CustomerName, account.StripeCustomerName), nonEmpty(payload.CustomerEmail, account.StripeCustomerEmail))
		if updateErr != nil {
			return updateErr
		}
		account = &updated
	}
	if subscriptionID := payload.subscriptionID(); s.stripe != nil && subscriptionID != "" {
		snapshot, err := s.fetchSubscription(ctx, subscriptionID)
		if err != nil {
			return pkgerrors.Internal("failed to refresh stripe subscription after payment failure").WithCause(err)
		}
		if err := s.projectWebhookSubscription(ctx, *account, snapshot); err != nil {
			return err
		}
	}

	nextAttempt := "Stripe will keep retrying the payment method on file."
	if t := unixToTime(payload.NextPaymentAttempt); !t.IsZero() {
		nextAttempt = "Stripe will retry the payment on " + t.Format("January 2, 2006") + "."
	}
	invoiceRef := strings.TrimSpace(payload.Number)
	if invoiceRef == "" {
		invoiceRef = strings.TrimSpace(payload.ID)
	}
	body := fmt.Sprintf(
		"We could not collect payment for invoice %s (%s).\n\n%s\n\nSmithers keeps paid features available during a %s grace period. If Stripe marks the subscription unpaid, canceled, or expired after dunning, the account is automatically downgraded to the free plan.\n\nNotification cadence: %s.\n\nUpdate payment method: %s",
		invoiceRef,
		formatMoneyCents(payload.AmountDue, payload.Currency),
		nextAttempt,
		formatDurationDays(billingDunningGracePeriod),
		billingDunningNotificationCadence,
		nonEmpty(payload.HostedInvoiceURL, s.billingPortalURLForAccount(*account)),
	)
	s.sendBillingNotification(ctx, *account, "Payment failed for your Smithers subscription", body)
	return nil
}

func (s *BillingService) handleCustomerUpdated(ctx context.Context, payload stripeCustomerPayload) error {
	account, err := s.findBillingAccountByCustomerID(ctx, payload.ID)
	if err != nil || account == nil {
		return err
	}
	owner := billingOwnerRef{OwnerType: account.OwnerType, OwnerID: account.OwnerID, OwnerName: account.StripeCustomerName}
	_, err = s.upsertBillingAccount(ctx, owner, payload.ID, payload.Name, payload.Email)
	return err
}

func (s *BillingService) handleChargeRefunded(ctx context.Context, eventID string, occurred time.Time, payload stripeChargePayload) error {
	customerID := strings.TrimSpace(payload.Customer)
	if customerID == "" && s.stripe != nil && strings.TrimSpace(payload.ID) != "" {
		charge, err := s.stripe.GetCharge(ctx, payload.ID)
		if err != nil {
			return pkgerrors.Internal("failed to refresh stripe charge after refund").WithCause(err)
		}
		customerID = charge.CustomerID
		if payload.AmountRefunded <= 0 {
			payload.AmountRefunded = charge.AmountRefunded
		}
		if payload.Currency == "" {
			payload.Currency = charge.Currency
		}
	}
	account, err := s.findBillingAccountByCustomerID(ctx, customerID)
	if err != nil || account == nil {
		return err
	}
	reason := fmt.Sprintf("Stripe charge refunded: %s (%s)", strings.TrimSpace(payload.ID), formatMoneyCents(payload.AmountRefunded, payload.Currency))
	if err := s.reversePayment(ctx, *account, reason, occurred); err != nil {
		return err
	}
	return s.recordStripeCreditAudit(ctx, *account, eventID, "refund", "stripe_charge", reason)
}

func (s *BillingService) handleChargeDisputeCreated(ctx context.Context, eventID string, occurred time.Time, payload stripeDisputePayload) error {
	customerID := ""
	if s.stripe != nil && strings.TrimSpace(payload.Charge) != "" {
		charge, err := s.stripe.GetCharge(ctx, payload.Charge)
		if err != nil {
			return pkgerrors.Internal("failed to refresh stripe charge after dispute").WithCause(err)
		}
		customerID = charge.CustomerID
	}
	account, err := s.findBillingAccountByCustomerID(ctx, customerID)
	if err != nil || account == nil {
		return err
	}
	reason := fmt.Sprintf(
		"Stripe dispute created: %s charge=%s reason=%s status=%s amount=%s",
		strings.TrimSpace(payload.ID),
		strings.TrimSpace(payload.Charge),
		strings.TrimSpace(payload.Reason),
		strings.TrimSpace(payload.Status),
		formatMoneyCents(payload.Amount, payload.Currency),
	)
	if err := s.reversePayment(ctx, *account, reason, occurred); err != nil {
		return err
	}
	return s.recordStripeCreditAudit(ctx, *account, eventID, "adjustment", "stripe_dispute", reason)
}

func (s *BillingService) handleEntitlementEvent(ctx context.Context, payload stripeEntitlementSummaryPayload) error {
	account, err := s.findBillingAccountByCustomerID(ctx, payload.Customer)
	if err != nil {
		return err
	}
	if account == nil {
		return nil
	}
	keys := make([]string, 0, len(payload.ActiveEntitlements))
	for _, entitlement := range payload.ActiveEntitlements {
		key := strings.TrimSpace(entitlement.LookupKey)
		if key == "" {
			key = strings.TrimSpace(entitlement.Feature.LookupKey)
		}
		if key == "" {
			continue
		}
		keys = append(keys, key)
	}
	return s.replaceEntitlements(ctx, account.ID, keys)
}

func (s *BillingService) replaceEntitlements(ctx context.Context, billingAccountID int64, featureKeys []string) error {
	if err := s.queries.DeactivateBillingEntitlementsByAccount(ctx, billingAccountID); err != nil {
		return pkgerrors.Internal("failed to reset billing entitlements").WithCause(err)
	}
	deduped := dedupeStrings(featureKeys)
	now := s.now()
	for _, featureKey := range deduped {
		if _, err := s.queries.UpsertBillingEntitlement(ctx, db.UpsertBillingEntitlementParams{
			BillingAccountID: billingAccountID,
			FeatureKey:       featureKey,
			Active:           true,
			LastSyncedAt:     now,
		}); err != nil {
			return pkgerrors.Internal("failed to persist billing entitlements").WithCause(err)
		}
	}
	return nil
}

// observedSubscription is a Stripe subscription snapshot and the database
// time just before it was read: Stripe's state is at least that new.
type observedSubscription struct {
	StripeSubscriptionSnapshot
	observedAt time.Time
}

// fetchSubscription reads a subscription from Stripe, stamped with the
// database clock so concurrent writers on every replica compare one clock.
func (s *BillingService) fetchSubscription(ctx context.Context, subscriptionID string) (observedSubscription, error) {
	observedAt, err := s.queries.BillingSnapshotClock(ctx)
	if err != nil {
		return observedSubscription{}, fmt.Errorf("read database clock: %w", err)
	}
	snapshot, err := s.stripe.GetSubscription(ctx, subscriptionID)
	if err != nil {
		return observedSubscription{}, err
	}
	return observedSubscription{snapshot, observedAt}, nil
}

// upsertSubscriptionSnapshot projects snapshot unless the stored snapshot was
// read after it (smithersai/smithers#2193): a webhook that read Stripe before
// a concurrent webhook read and committed a newer state cannot overwrite it.
func (s *BillingService) upsertSubscriptionSnapshot(ctx context.Context, account db.BillingAccount, observed observedSubscription) error {
	snapshot := observed.StripeSubscriptionSnapshot
	plan := s.planFromPrice(account.OwnerType, snapshot.PriceID, snapshot.Interval)
	if snapshot.PlanKey != "" {
		plan.Key = snapshot.PlanKey
	}
	if plan.Key == "" {
		plan.Key = BillingPlanCustom
	}
	interval := strings.TrimSpace(snapshot.Interval)
	if interval == "" {
		interval = plan.Interval
	}
	// Safety net for the pure sub-second concurrent-create race that Layer 1
	// (open-session expiry at checkout) cannot close: if this incoming paid
	// subscription is a DIFFERENT id than an existing paid row on the account
	// AND it carries our checkout metadata (all four keys — only our checkout
	// flow stamps plan_key+interval, so manually-created enterprise subs are
	// never touched), cancel the newer duplicate to stop the double-charge. The
	// pre-existing subscription wins; portal plan changes reuse the same id and
	// so can never trip this branch. Cancel is best-effort — the projection upsert
	// must still proceed (a replayed webhook may find the sub already canceled).
	if s.stripe != nil && paidSubscriptionStatus(snapshot.Status) && hasCheckoutMetadata(snapshot.Metadata) {
		uncertainCompetitor := false
		canceledDuplicate := false
		if rows, listErr := s.queries.ListBillingSubscriptionsByAccount(ctx, account.ID); listErr == nil {
			for _, row := range rows {
				if row.StripeSubscriptionID == snapshot.ID || !paidSubscriptionStatus(row.Status) {
					continue
				}
				// The competing row is only a real duplicate if Stripe ALSO still
				// reports it as paid. A stale local 'active' row (a missed
				// cancellation webhook left the DB drifted from Stripe) must NOT
				// cause us to cancel this genuinely-purchased subscription — which
				// Stripe has already charged — with no refund path. Verify against
				// Stripe before canceling; on any doubt, leave the incoming alone.
				competing, getErr := s.stripe.GetSubscription(ctx, row.StripeSubscriptionID)
				if getErr != nil {
					uncertainCompetitor = true
					slog.Warn("skipping duplicate cancel: failed to verify competing subscription in stripe",
						"competing_subscription_id", row.StripeSubscriptionID, "account_id", account.ID, "error", getErr)
					continue
				}
				if !paidSubscriptionStatus(competing.Status) {
					slog.Warn("skipping duplicate cancel: competing subscription is not live in stripe",
						"competing_subscription_id", row.StripeSubscriptionID, "account_id", account.ID)
					continue
				}
				if cancelErr := s.stripe.CancelSubscription(ctx, snapshot.ID); cancelErr != nil {
					slog.Warn("failed to cancel duplicate paid subscription", "subscription_id", snapshot.ID, "account_id", account.ID, "error", cancelErr)
				} else {
					canceledDuplicate = true
					slog.Warn("canceled duplicate paid subscription", "subscription_id", snapshot.ID, "kept_subscription_id", row.StripeSubscriptionID, "account_id", account.ID)
				}
				break
			}
		}
		if uncertainCompetitor && !canceledDuplicate {
			slog.Warn("duplicate subscription scan completed with unverified competitors", "subscription_id", snapshot.ID, "account_id", account.ID)
		}
	}
	_, err := s.queries.UpsertBillingSubscription(ctx, db.UpsertBillingSubscriptionParams{
		BillingAccountID:     account.ID,
		StripeSubscriptionID: snapshot.ID,
		StripePriceID:        snapshot.PriceID,
		PlanKey:              plan.Key,
		BillingInterval:      interval,
		Status:               snapshot.Status,
		Quantity:             snapshot.Quantity,
		TrialEnd:             nullableTimestamptz(snapshot.TrialEnd),
		CurrentPeriodStart:   nullableTimestamptz(snapshot.CurrentPeriodStart),
		CurrentPeriodEnd:     nullableTimestamptz(snapshot.CurrentPeriodEnd),
		CancelAtPeriodEnd:    snapshot.CancelAtPeriodEnd,
		CanceledAt:           nullableTimestamptz(snapshot.CanceledAt),
		RawPayload:           snapshot.RawPayload,
		SnapshotObservedAt:   nullableTimestamptz(observed.observedAt),
	})
	if err != nil && !stdErrors.Is(err, pgx.ErrNoRows) { // ErrNoRows: a newer snapshot is stored
		return pkgerrors.Internal("failed to persist billing subscription").WithCause(err)
	}
	return nil
}

// projectWebhookSubscription persists a webhook's subscription snapshot and
// forfeits plan credit the account can no longer spend. Only a webhook
// forfeits, inside its transaction: a refresh or a read that forfeited from
// its own snapshot could take credit a concurrent webhook just granted
// (smithersai/smithers#2175).
func (s *BillingService) projectWebhookSubscription(ctx context.Context, account db.BillingAccount, snapshot observedSubscription) error {
	if err := s.upsertSubscriptionSnapshot(ctx, account, snapshot); err != nil {
		return err
	}
	return s.forfeitLapsedPlanCredit(ctx, account)
}

func (s *BillingService) ensureBillingAccount(ctx context.Context, owner billingOwnerRef, customerName, customerEmail string) (db.BillingAccount, error) {
	account, err := s.findBillingAccountByOwner(ctx, owner.OwnerType, owner.OwnerID)
	if err != nil {
		return db.BillingAccount{}, err
	}
	if account != nil {
		return *account, nil
	}
	customerID, err := s.stripe.CreateCustomer(ctx, StripeCreateCustomerInput{
		Name:  strings.TrimSpace(customerName),
		Email: strings.TrimSpace(customerEmail),
		Metadata: map[string]string{
			"owner_type": owner.OwnerType,
			"owner_id":   strconv.FormatInt(owner.OwnerID, 10),
		},
	})
	if err != nil {
		return db.BillingAccount{}, pkgerrors.Internal("failed to create stripe customer").WithCause(err)
	}
	return s.upsertBillingAccount(ctx, owner, customerID, customerName, customerEmail)
}

func (s *BillingService) upsertBillingAccount(ctx context.Context, owner billingOwnerRef, stripeCustomerID, customerName, customerEmail string) (db.BillingAccount, error) {
	account, err := s.queries.UpsertBillingAccount(ctx, db.UpsertBillingAccountParams{
		OwnerType:           owner.OwnerType,
		OwnerID:             owner.OwnerID,
		StripeCustomerID:    strings.TrimSpace(stripeCustomerID),
		StripeCustomerEmail: strings.TrimSpace(customerEmail),
		StripeCustomerName:  strings.TrimSpace(customerName),
	})
	if err != nil {
		return db.BillingAccount{}, pkgerrors.Internal("failed to persist billing account").WithCause(err)
	}
	return account, nil
}

func (s *BillingService) resolveOrgOwner(ctx context.Context, actor *db.User, orgName string) (billingOwnerRef, error) {
	if actor == nil {
		return billingOwnerRef{}, pkgerrors.Unauthorized("authentication required")
	}
	lowerName := strings.ToLower(strings.TrimSpace(orgName))
	if lowerName == "" {
		return billingOwnerRef{}, pkgerrors.BadRequest("organization name is required")
	}
	org, err := s.queries.GetOrgByLowerName(ctx, lowerName)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return billingOwnerRef{}, pkgerrors.NotFound("organization not found")
		}
		return billingOwnerRef{}, pkgerrors.Internal("failed to load organization").WithCause(err)
	}
	member, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         actor.ID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return billingOwnerRef{}, pkgerrors.Forbidden("insufficient organization permissions")
		}
		return billingOwnerRef{}, pkgerrors.Internal("failed to load organization membership").WithCause(err)
	}
	if strings.ToLower(strings.TrimSpace(member.Role)) != "owner" {
		return billingOwnerRef{}, pkgerrors.Forbidden("insufficient organization permissions")
	}
	return billingOwnerRef{
		OwnerType: BillingOwnerTypeOrg,
		OwnerID:   org.ID,
		OwnerName: org.Name,
	}, nil
}

func (s *BillingService) resolveRepoOwner(ctx context.Context, repositoryID int64) (billingOwnerRef, db.Repository, error) {
	repo, err := s.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return billingOwnerRef{}, db.Repository{}, pkgerrors.NotFound("repository not found")
		}
		return billingOwnerRef{}, db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	if repo.UserID.Valid {
		user, err := s.queries.GetUserByID(ctx, repo.UserID.Int64)
		if err != nil {
			return billingOwnerRef{}, db.Repository{}, pkgerrors.Internal("failed to load repository owner").WithCause(err)
		}
		return billingOwnerRef{
			OwnerType: BillingOwnerTypeUser,
			OwnerID:   user.ID,
			OwnerName: user.Username,
		}, repo, nil
	}
	if repo.OrgID.Valid {
		org, err := s.queries.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			return billingOwnerRef{}, db.Repository{}, pkgerrors.Internal("failed to load repository owner").WithCause(err)
		}
		return billingOwnerRef{
			OwnerType: BillingOwnerTypeOrg,
			OwnerID:   org.ID,
			OwnerName: org.Name,
		}, repo, nil
	}
	return billingOwnerRef{}, db.Repository{}, pkgerrors.Internal("repository owner not found")
}

func (s *BillingService) currentSeatCount(ctx context.Context, owner billingOwnerRef) (int64, error) {
	if owner.OwnerType == BillingOwnerTypeUser {
		return 1, nil
	}
	count, err := s.queries.CountOrgMembers(ctx, owner.OwnerID)
	if err != nil {
		return 0, pkgerrors.Internal("failed to count organization seats").WithCause(err)
	}
	if count <= 0 {
		return 1, nil
	}
	return count, nil
}

func mustPositiveBillingSeatCount(seats int64) int64 {
	if seats <= 0 {
		panic("billing seat count must be positive")
	}
	return seats
}

func mustResolvedBillingAccount(account *db.BillingAccount) *db.BillingAccount {
	if account == nil {
		panic("billing account must be resolved")
	}
	return account
}

func (s *BillingService) defaultPlan(ownerType string) billingPlanDefinition {
	if plans, ok := s.checkoutPlans[ownerType]; ok {
		if plan, ok := plans[BillingPlanFree]; ok {
			return plan
		}
	}
	return billingPlanDefinition{
		Key:          BillingPlanFree,
		AllowedOwner: ownerType,
		Limits: billingPlanLimits{
			PrivateRepos: unlimitedBillingQuantity,
			StorageBytes: unlimitedBillingQuantity,
			CIMinutes:    unlimitedBillingQuantity,
			AgentRuns:    unlimitedBillingQuantity,
			Seats:        unlimitedBillingQuantity,
		},
	}
}

func (s *BillingService) planForSubscription(ownerType string, subscription *db.BillingSubscription) billingPlanDefinition {
	if subscription == nil {
		return s.defaultPlan(ownerType)
	}
	if !s.subscriptionGrantsPaidAccess(subscription) {
		return s.defaultPlan(ownerType)
	}
	interval := normalizeBillingInterval(subscription.BillingInterval)
	// Legacy/manual paid rows may omit the interval. User-tier catalog entries
	// are monthly by default, so resolve those rows against the monthly limits
	// instead of silently falling back to the generic paid-plan defaults.
	if interval == "" {
		interval = BillingIntervalMonthly
	}
	plan := s.planFromPrice(ownerType, subscription.StripePriceID, interval)
	if strings.TrimSpace(subscription.PlanKey) != "" {
		plan.Key = subscription.PlanKey
		// The persisted key survives price-ID rotation. Keep sandbox entitlements
		// attached to that tier even if its former Stripe price is no longer configured.
		catalog, ok := s.checkoutPlans[ownerType][subscription.PlanKey+":"+interval]
		if ok {
			plan.Limits.ConcurrentSandboxes = catalog.Limits.ConcurrentSandboxes
			plan.Limits.SandboxIdleTimeoutSecs = catalog.Limits.SandboxIdleTimeoutSecs
			plan.Limits.SandboxHoursPerDay = catalog.Limits.SandboxHoursPerDay
			plan.PriceCents = catalog.PriceCents
		}
	}
	if plan.Key == "" {
		plan = s.checkoutPlans[ownerType][BillingPlanCustom]
		if plan.Key == "" {
			plan = s.defaultPlan(ownerType)
		}
	}
	if plan.Interval == "" {
		plan.Interval = interval
	}
	return plan
}

func (s *BillingService) planFromPrice(ownerType, priceID, interval string) billingPlanDefinition {
	if plan, ok := s.priceCatalog[strings.TrimSpace(priceID)]; ok {
		return plan
	}
	customPlan := s.checkoutPlans[ownerType][BillingPlanCustom]
	if customPlan.Key != "" {
		customPlan.Interval = normalizeBillingInterval(interval)
		return customPlan
	}
	plan := s.defaultPlan(ownerType)
	plan.Interval = normalizeBillingInterval(interval)
	return plan
}

// smithersTermsURL is where the Terms of Service, including the renewal and
// cancellation terms, are published.
const smithersTermsURL = "https://smithers.sh/terms"

// checkoutRenewalTerms is the automatic-renewal disclosure shown beside the
// required Terms checkbox (Stripe allows 1200 characters).
func checkoutRenewalTerms(interval string) string {
	period := "month"
	if normalizeBillingInterval(interval) == BillingIntervalAnnual {
		period = "year"
	}
	return "Your subscription renews automatically every " + period + " at the price shown, charged to this payment method, until you cancel. " +
		"You can cancel online at any time from Billing in Smithers; cancellation stops the next renewal. " +
		"I agree to the [Terms of Service](" + smithersTermsURL + "), including these renewal terms."
}

func (s *BillingService) checkoutPlan(ownerType, planKey, interval string) (billingPlanDefinition, error) {
	key := strings.TrimSpace(planKey)
	if key == "" {
		if ownerType == BillingOwnerTypeUser {
			// Pro is the sold user plan; Personal is hidden and unpriced.
			key = BillingPlanPro
		} else {
			key = BillingPlanTeam
		}
	}
	normalizedInterval := normalizeBillingInterval(interval)
	if normalizedInterval == "" {
		if strings.TrimSpace(interval) != "" {
			return billingPlanDefinition{}, pkgerrors.BadRequest("unsupported billing interval")
		}
		normalizedInterval = BillingIntervalMonthly
	}
	if normalizedInterval == BillingIntervalAnnual {
		// Annual pricing is not approved; a configured annual price id must
		// not make it purchasable.
		return billingPlanDefinition{}, pkgerrors.BadRequest("annual billing is not offered")
	}
	plan, ok := s.checkoutPlans[ownerType][key+":"+normalizedInterval]
	if !ok || plan.Unlisted || strings.TrimSpace(plan.PriceID) == "" {
		return billingPlanDefinition{}, pkgerrors.BadRequest("requested billing plan is not configured")
	}
	return plan, nil
}

func (s *BillingService) findBillingAccountByOwner(ctx context.Context, ownerType string, ownerID int64) (*db.BillingAccount, error) {
	account, err := s.queries.GetBillingAccountByOwner(ctx, db.GetBillingAccountByOwnerParams{
		OwnerType: ownerType,
		OwnerID:   ownerID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, pkgerrors.Internal("failed to load billing account").WithCause(err)
	}
	return &account, nil
}

func (s *BillingService) findBillingAccountByCustomerID(ctx context.Context, customerID string) (*db.BillingAccount, error) {
	customerID = strings.TrimSpace(customerID)
	if customerID == "" {
		return nil, nil
	}
	account, err := s.queries.GetBillingAccountByStripeCustomerID(ctx, customerID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, pkgerrors.Internal("failed to load billing account").WithCause(err)
	}
	return &account, nil
}

func (s *BillingService) claimStripeProcessedEvent(ctx context.Context, eventID, eventType string) (bool, error) {
	_, err := s.queries.ClaimStripeProcessedEvent(ctx, db.ClaimStripeProcessedEventParams{
		EventID:   strings.TrimSpace(eventID),
		EventType: strings.TrimSpace(eventType),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, pkgerrors.Internal("failed to record stripe webhook event").WithCause(err)
	}
	return true, nil
}

// billingNotice is a billing email held until its webhook commits.
type billingNotice struct {
	account       db.BillingAccount
	subject, body string
}

func (s *BillingService) sendBillingNotification(ctx context.Context, account db.BillingAccount, subject, body string) {
	if s.notices != nil {
		*s.notices = append(*s.notices, billingNotice{account, subject, body})
		return
	}
	if s.emailSender == nil {
		return
	}
	toEmail := strings.TrimSpace(account.StripeCustomerEmail)
	if toEmail == "" {
		return
	}
	s.emailSender.SendBillingNotification(ctx, toEmail, subject, body)
}

func (s *BillingService) billingPortalURLForAccount(account db.BillingAccount) string {
	owner := billingOwnerRef{
		OwnerType: account.OwnerType,
		OwnerID:   account.OwnerID,
		OwnerName: account.StripeCustomerName,
	}
	return s.portalReturnURL(owner)
}

// recordStripeCreditAudit appends one Stripe refund or dispute notice to the
// billing history, once per Stripe event. It moves no credit.
func (s *BillingService) recordStripeCreditAudit(ctx context.Context, account db.BillingAccount, eventID string, category string, metricKey string, reason string) error {
	idempotencyKey := "stripe_event:" + strings.TrimSpace(eventID)
	if idempotencyKey == "stripe_event:" {
		return nil
	}
	if _, err := s.queries.GetCreditLedgerByIdempotencyKey(ctx, db.GetCreditLedgerByIdempotencyKeyParams{
		BillingAccountID: account.ID,
		IdempotencyKey:   idempotencyKey,
	}); err == nil {
		return nil
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Internal("failed to load billing credit ledger")
	}
	var balanceCents int64
	if s.credits != nil {
		balance, err := s.credits.OwnerBalance(ctx, account.OwnerType, account.OwnerID)
		if err != nil {
			return pkgerrors.Internal("failed to load credit balance").WithCause(err)
		}
		balanceCents = balance / credits.NanosPerCent
	}
	if _, err := s.queries.InsertCreditLedgerEntry(ctx, db.InsertCreditLedgerEntryParams{
		BillingAccountID:  account.ID,
		AmountCents:       0,
		BalanceAfterCents: balanceCents,
		Reason:            strings.TrimSpace(reason),
		Category:          strings.TrimSpace(category),
		MetricKey:         strings.TrimSpace(metricKey),
		IdempotencyKey:    idempotencyKey,
	}); err != nil {
		return pkgerrors.Internal("failed to record billing credit ledger").WithCause(err)
	}
	return nil
}

func (s *BillingService) portalReturnURL(owner billingOwnerRef) string {
	if strings.TrimSpace(s.config.PortalReturnURL) != "" {
		return strings.TrimSpace(s.config.PortalReturnURL)
	}
	if owner.OwnerType == BillingOwnerTypeOrg {
		return s.config.BaseURL + "/orgs/" + owner.OwnerName + "/settings/billing"
	}
	return s.config.BaseURL + "/settings/billing"
}

func (s *BillingService) checkoutSuccessURL(owner billingOwnerRef) string {
	if strings.TrimSpace(s.config.CheckoutSuccessURL) != "" {
		return strings.TrimSpace(s.config.CheckoutSuccessURL)
	}
	return s.portalReturnURL(owner) + "?checkout=success"
}

func (s *BillingService) checkoutCancelURL(owner billingOwnerRef) string {
	if strings.TrimSpace(s.config.CheckoutCancelURL) != "" {
		return strings.TrimSpace(s.config.CheckoutCancelURL)
	}
	return s.portalReturnURL(owner) + "?checkout=cancelled"
}

func (s *BillingService) enforceMetricLimit(limit int64, usage BillingUsageSummary, label string) error {
	if limit >= unlimitedBillingQuantity {
		return nil
	}
	if usage.ConsumedQuantity < limit {
		return nil
	}
	return pkgerrors.Forbidden(fmt.Sprintf("%s quota exceeded for the current billing plan", label))
}

func verifyStripeWebhookSignature(payload []byte, header, secret string) bool {
	var timestamp, provided string
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			timestamp = value
		case "v1":
			provided = value
		}
	}
	if timestamp == "" || provided == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(payload)
	expected, err := hex.DecodeString(provided)
	if err != nil {
		return false
	}
	return hmac.Equal(mac.Sum(nil), expected)
}
