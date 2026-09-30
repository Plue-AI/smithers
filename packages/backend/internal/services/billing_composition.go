package services

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// BillingMode selects the account/usage authority for one product process.
// It is deployment configuration, not a route-level edition branch.
type BillingMode string

const (
	BillingModeUnlimited BillingMode = "unlimited"
	BillingModeStripe    BillingMode = "stripe"
)

// BillingCapabilities is the commerce surface the selected authority can
// actually serve. Admission remains available in both modes.
type BillingCapabilities struct {
	Overview bool
	Plans    bool
	Checkout bool
	Portal   bool
	Webhook  bool
}

// BillingCompositionConfig contains the complete billing provider choice.
// Stripe prices remain data supplied by the hosted deployment; the product
// does not infer or preserve an obsolete schedule.
type BillingCompositionConfig struct {
	Mode            BillingMode
	StripeSecretKey string
	Service         BillingServiceConfig
}

// BillingComposition gives every product service one admission policy while
// exposing commerce routes only when there is a real account provider.
type BillingComposition struct {
	Policy       BillingPolicy
	Service      *BillingService
	Capabilities BillingCapabilities
}

// ErrStripeBillingUnavailable is returned for billing.mode=stripe: the public
// backend ships no payment client, and a hosted deployment that sells plans
// supplies its own billing composition.
var ErrStripeBillingUnavailable = errors.New("billing: stripe mode is unavailable in the public backend")

func NewBillingComposition(q BillingBaseQuerier, cfg BillingCompositionConfig, opts ...BillingServiceOption) (BillingComposition, error) {
	mode := BillingMode(strings.ToLower(strings.TrimSpace(string(cfg.Mode))))
	if mode == "" {
		mode = BillingModeUnlimited
	}
	switch mode {
	case BillingModeUnlimited:
		if billingHasStripeConfiguration(cfg) {
			return BillingComposition{}, fmt.Errorf("billing: stripe configuration requires mode %q", BillingModeStripe)
		}
		policy := NewUnlimitedBillingPolicy()
		return BillingComposition{Policy: policy}, nil
	case BillingModeStripe:
		return BillingComposition{}, ErrStripeBillingUnavailable
	default:
		return BillingComposition{}, fmt.Errorf("billing: mode must be %q or %q", BillingModeUnlimited, BillingModeStripe)
	}
}

func billingHasStripeConfiguration(cfg BillingCompositionConfig) bool {
	values := []string{
		cfg.StripeSecretKey,
		cfg.Service.StripeWebhookSecret,
		cfg.Service.PortalReturnURL,
		cfg.Service.CheckoutSuccessURL,
		cfg.Service.CheckoutCancelURL,
		cfg.Service.PersonalMonthlyPriceID,
		cfg.Service.PersonalAnnualPriceID,
		cfg.Service.ProMonthlyPriceID,
		cfg.Service.ProAnnualPriceID,
		cfg.Service.MaxMonthlyPriceID,
		cfg.Service.MaxAnnualPriceID,
		cfg.Service.TeamMonthlyPriceID,
		cfg.Service.TeamAnnualPriceID,
		cfg.Service.EnterpriseMonthlyPriceID,
		cfg.Service.EnterpriseAnnualPriceID,
	}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// UnlimitedBillingPolicy is the explicit single-owner self-host entitlement.
// It has no account, usage ledger, purchase, or hosted-plan semantics.
type UnlimitedBillingPolicy struct{}

func NewUnlimitedBillingPolicy() *UnlimitedBillingPolicy { return &UnlimitedBillingPolicy{} }

func (*UnlimitedBillingPolicy) AuthorizeSandboxStart(context.Context, int64) error { return nil }

func (*UnlimitedBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{
		PlanKey:           BillingPlanCustom,
		EgressBytesPerDay: -1,
		// Billing admission is unlimited; fleet/provider capacity guards are
		// independent and continue to run after this policy authorizes a start.
		ConcurrentSandboxes: unlimitedBillingQuantity,
		// Zero removes a billing-plan idle deadline. Service-specific runtime
		// policies and repository overrides remain independent controls.
		IdleTimeoutSecs: 0,
		HoursPerDay:     -1,
	}, nil
}

func (*UnlimitedBillingPolicy) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}

func (*UnlimitedBillingPolicy) AuthorizeWorkflowDispatchCommitted(ctx context.Context, _ int64, commit func(context.Context, pgx.Tx) error) error {
	if commit == nil {
		return errors.New("workflow run commit is required")
	}
	return commit(ctx, nil)
}
func (*UnlimitedBillingPolicy) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	if commit == nil {
		return errors.New("agent run commit is required")
	}
	return commit(ctx, nil)
}
func (*UnlimitedBillingPolicy) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}
func (*UnlimitedBillingPolicy) AuthorizePairing(context.Context, int64) error { return nil }

func (*UnlimitedBillingPolicy) AuthorizeBranchLockJoin(context.Context, int64) error { return nil }

func (*UnlimitedBillingPolicy) AuthorizePrivateRepoCommitted(
	ctx context.Context,
	_ string,
	_ int64,
	commit func(context.Context) error,
) error {
	return runUnlimitedCommit(ctx, commit)
}

func (*UnlimitedBillingPolicy) AuthorizeRepoCreateCommitted(
	ctx context.Context,
	_ string,
	_ int64,
	_ bool,
	commit func(context.Context) error,
) error {
	return runUnlimitedCommit(ctx, commit)
}

func (*UnlimitedBillingPolicy) AuthorizeOrgCreateCommitted(ctx context.Context, _ int64, commit func(context.Context) error) error {
	return runUnlimitedCommit(ctx, commit)
}

// RemainingStorageBytes reports no storage limit.
func (*UnlimitedBillingPolicy) RemainingStorageBytes(context.Context, int64) (int64, bool, error) {
	return 0, false, nil
}

func (*UnlimitedBillingPolicy) AuthorizeStorageIncreaseCommitted(
	ctx context.Context,
	_ int64,
	_ int64,
	commit func(context.Context) error,
) error {
	return runUnlimitedCommit(ctx, commit)
}

func (*UnlimitedBillingPolicy) AuthorizeStorageIncreaseCommittedDynamic(
	ctx context.Context,
	_ int64,
	resolveAdditionalBytes func(context.Context) (int64, error),
	commit func(context.Context) error,
) error {
	if resolveAdditionalBytes == nil {
		return fmt.Errorf("billing: storage size resolver is required")
	}
	if _, err := resolveAdditionalBytes(ctx); err != nil {
		return err
	}
	return runUnlimitedCommit(ctx, commit)
}

func (*UnlimitedBillingPolicy) AuthorizeRepositoryTransferCommitted(
	ctx context.Context,
	_ int64,
	_ string,
	_ int64,
	_ bool,
	commit func(context.Context) error,
) error {
	return runUnlimitedCommit(ctx, commit)
}

func (*UnlimitedBillingPolicy) AuthorizeRepositoryTransferCommittedInTransaction(
	ctx context.Context,
	_ db.DBTX,
	_ int64,
	_ string,
	_ int64,
	_ bool,
	commit func(context.Context) error,
) error {
	return runUnlimitedCommit(ctx, commit)
}

func runUnlimitedCommit(ctx context.Context, commit func(context.Context) error) error {
	if commit == nil {
		return fmt.Errorf("billing: commit is required")
	}
	return commit(ctx)
}

// Unlimited counted resume keeps the explicit single-owner policy complete.
func (*UnlimitedBillingPolicy) AuthorizeCountedSandboxResume(context.Context, int64, string, string) error {
	return nil
}
