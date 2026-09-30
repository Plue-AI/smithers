// Package admission exposes the shared, payment-key-free product quota policy.
// Deployments supply metering facts; the common services own plan evaluation,
// quota locks, and the consuming transaction.
package admission

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/billingstore"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type DBTX = db.DBTX
type Owner = db.SumStorageBytesByOwnerParams
type RepoOwner = db.CountPrivateReposByOwnerParams
type RepoCountOwner = db.CountReposByOwnerParams
type ResumeRequest = db.CountOtherActiveSandboxesForWorkspaceResumeParams
type ResumeCount = db.CountOtherActiveSandboxesForWorkspaceResumeRow
type SandboxEntitlement = services.SandboxEntitlement

// Policy includes every production extension. Narrowing this to BillingPolicy
// would silently lose lock-through-commit and counted-resume behavior.
type Policy interface {
	services.BillingPolicy
	services.BranchLockJoinAuthorizer
	services.PrivateRepoCommitAuthorizer
	services.RepoCreateAuthorizer
	services.OrgCreateAuthorizer
	services.StorageCommitAuthorizer
	services.DynamicStorageCommitAuthorizer
	services.RepositoryTransferCommitAuthorizer
	services.RepositoryTransferTransactionAuthorizer
	services.StorageBudgeter
	AuthorizeCountedSandboxResume(context.Context, int64, string, string) error
}

// Usage and UsageFactory are the complete metering contract shared by
// key-free admission and API commerce.
type Usage = billingstore.Usage
type UsageFactory = billingstore.UsageFactory

// Prices maps durable subscription price IDs to the shared plan catalog. It
// contains no payment credentials, webhook secrets, or payment transport.
type Prices struct {
	PersonalMonthly, PersonalAnnual     string
	ProMonthly, ProAnnual               string
	MaxMonthly, MaxAnnual               string
	TeamMonthly, TeamAnnual             string
	EnterpriseMonthly, EnterpriseAnnual string
}

type Config struct {
	Usage  UsageFactory
	Prices Prices
}

// NewMetered reuses the common policy and product queries. An explicit usage
// factory is required so a hosted caller cannot accidentally omit private
// reservations. ProductUsage is the explicit product-only choice.
func NewMetered(pool *pgxpool.Pool, cfg Config) (Policy, error) {
	if pool == nil {
		return nil, errors.New("admission: database pool is required")
	}
	if cfg.Usage == nil {
		return nil, errors.New("admission: usage factory is required")
	}
	queries, err := billingstore.Bind(pool, cfg.Usage)
	if err != nil {
		return nil, err
	}
	p := cfg.Prices
	return services.NewBillingService(queries, nil, services.BillingServiceConfig{
		PersonalMonthlyPriceID: p.PersonalMonthly, PersonalAnnualPriceID: p.PersonalAnnual,
		ProMonthlyPriceID: p.ProMonthly, ProAnnualPriceID: p.ProAnnual,
		MaxMonthlyPriceID: p.MaxMonthly, MaxAnnualPriceID: p.MaxAnnual,
		TeamMonthlyPriceID: p.TeamMonthly, TeamAnnualPriceID: p.TeamAnnual,
		EnterpriseMonthlyPriceID: p.EnterpriseMonthly, EnterpriseAnnualPriceID: p.EnterpriseAnnual,
	}, services.WithBillingCreditLedger(credits.Ledger{DB: pool})), nil
}

// ProductUsage supplies only canonical product metering. Private adapters can
// embed the returned interface while overriding their additional accounting.
func ProductUsage(conn DBTX) (Usage, error) {
	if conn == nil {
		return nil, errors.New("admission: usage database handle is required")
	}
	return db.New(conn), nil
}

var _ Policy = (*services.BillingService)(nil)

var _ services.BillingQuerier = (*billingstore.Queries)(nil)
var _ Policy = (*services.UnlimitedBillingPolicy)(nil)
