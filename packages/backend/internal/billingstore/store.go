// Package billingstore owns the shared billing query contract. Keeping this
// contract independent of services lets deployment query adapters preserve
// their metering overrides without importing the product service package.
package billingstore

import (
	"context"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Querier is the canonical product ledger and usage surface consumed by billing.
type Querier interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	CountOrgMembers(ctx context.Context, orgID int64) (int64, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)

	GetBillingAccountByOwner(ctx context.Context, arg db.GetBillingAccountByOwnerParams) (db.BillingAccount, error)
	GetBillingAccountByStripeCustomerID(ctx context.Context, stripeCustomerID string) (db.BillingAccount, error)
	UpsertBillingAccount(ctx context.Context, arg db.UpsertBillingAccountParams) (db.BillingAccount, error)
	GetLatestBillingSubscriptionByAccount(ctx context.Context, billingAccountID int64) (db.BillingSubscription, error)
	GetLatestLiveBillingSubscriptionByAccount(ctx context.Context, billingAccountID int64) (db.BillingSubscription, error)
	ListBillingSubscriptionsByAccount(ctx context.Context, billingAccountID int64) ([]db.BillingSubscription, error)
	UpsertBillingSubscription(ctx context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error)
	BillingSnapshotClock(ctx context.Context) (time.Time, error)
	MarkBillingSubscriptionsPaymentReversed(ctx context.Context, arg db.MarkBillingSubscriptionsPaymentReversedParams) (int64, error)
	RecordBillingAccountPaymentReversal(ctx context.Context, arg db.RecordBillingAccountPaymentReversalParams) error
	SettleBillingSubscriptionPayment(ctx context.Context, arg db.SettleBillingSubscriptionPaymentParams) (db.BillingSubscription, error)
	DeactivateBillingEntitlementsByAccount(ctx context.Context, billingAccountID int64) error
	UpsertBillingEntitlement(ctx context.Context, arg db.UpsertBillingEntitlementParams) (db.BillingEntitlement, error)
	ListBillingEntitlementsByAccount(ctx context.Context, billingAccountID int64) ([]db.BillingEntitlement, error)
	UpsertBillingUsageCounter(ctx context.Context, arg db.UpsertBillingUsageCounterParams) (db.BillingUsageCounter, error)
	ListBillingUsageCountersByOwnerAndPeriod(ctx context.Context, arg db.ListBillingUsageCountersByOwnerAndPeriodParams) ([]db.BillingUsageCounter, error)

	CountPrivateReposByOwner(ctx context.Context, arg db.CountPrivateReposByOwnerParams) (int64, error)
	SumStorageBytesByOwner(ctx context.Context, arg db.SumStorageBytesByOwnerParams) (int64, error)
	SumStorageBytesByRepository(ctx context.Context, repositoryID int64) (int64, error)
	SumWorkflowMinutesByOwner(ctx context.Context, arg db.SumWorkflowMinutesByOwnerParams) (int64, error)
	CountAgentRunsByOwner(ctx context.Context, arg db.CountAgentRunsByOwnerParams) (int64, error)

	ClaimStripeProcessedEvent(ctx context.Context, arg db.ClaimStripeProcessedEventParams) (string, error)
	DeleteStripeProcessedEvent(ctx context.Context, eventID string) error
	InsertCreditLedgerEntry(ctx context.Context, arg db.InsertCreditLedgerEntryParams) (db.BillingCreditLedger, error)
	GetCreditLedgerByIdempotencyKey(ctx context.Context, arg db.GetCreditLedgerByIdempotencyKeyParams) (db.BillingCreditLedger, error)
}

// Rebinder binds the complete query surface to the exact supplied handle.
// Private usage overrides must survive caller-owned transactions as well as
// the quota-lock transactions opened by shared services.
type Rebinder interface {
	RebindBillingQueries(db.DBTX) (Querier, error)
}
