package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type billingHQuerier struct {
	*billingCovQuerier

	listUsageErr         error
	upsertUsageErr       error
	listEntitlementsErr  error
	resetEntitlementsErr error
	upsertEntitlementErr error
	orgLowerErr          error
	repoErr              error
	creditLedgerErr      error
	insertCreditErr      error
}

func billingHNewQuerier() *billingHQuerier {
	return &billingHQuerier{billingCovQuerier: billingCovNewQuerier()}
}

func (m *billingHQuerier) UpsertBillingUsageCounter(ctx context.Context, arg db.UpsertBillingUsageCounterParams) (db.BillingUsageCounter, error) {
	if m.upsertUsageErr != nil {
		return db.BillingUsageCounter{}, m.upsertUsageErr
	}
	return m.billingCovQuerier.UpsertBillingUsageCounter(ctx, arg)
}

func (m *billingHQuerier) ListBillingUsageCountersByOwnerAndPeriod(ctx context.Context, arg db.ListBillingUsageCountersByOwnerAndPeriodParams) ([]db.BillingUsageCounter, error) {
	if m.listUsageErr != nil {
		return nil, m.listUsageErr
	}
	return m.billingCovQuerier.ListBillingUsageCountersByOwnerAndPeriod(ctx, arg)
}

func (m *billingHQuerier) ListBillingEntitlementsByAccount(ctx context.Context, billingAccountID int64) ([]db.BillingEntitlement, error) {
	if m.listEntitlementsErr != nil {
		return nil, m.listEntitlementsErr
	}
	return m.billingCovQuerier.ListBillingEntitlementsByAccount(ctx, billingAccountID)
}

func (m *billingHQuerier) DeactivateBillingEntitlementsByAccount(ctx context.Context, billingAccountID int64) error {
	if m.resetEntitlementsErr != nil {
		return m.resetEntitlementsErr
	}
	return m.billingCovQuerier.DeactivateBillingEntitlementsByAccount(ctx, billingAccountID)
}

func (m *billingHQuerier) UpsertBillingEntitlement(ctx context.Context, arg db.UpsertBillingEntitlementParams) (db.BillingEntitlement, error) {
	if m.upsertEntitlementErr != nil {
		return db.BillingEntitlement{}, m.upsertEntitlementErr
	}
	return m.billingCovQuerier.UpsertBillingEntitlement(ctx, arg)
}

func (m *billingHQuerier) GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error) {
	if m.orgLowerErr != nil {
		return db.Organization{}, m.orgLowerErr
	}
	return m.billingCovQuerier.GetOrgByLowerName(ctx, lowerName)
}

func (m *billingHQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.repoErr != nil {
		return db.Repository{}, m.repoErr
	}
	return m.billingCovQuerier.GetRepoByID(ctx, id)
}

func (m *billingHQuerier) GetCreditLedgerByIdempotencyKey(ctx context.Context, arg db.GetCreditLedgerByIdempotencyKeyParams) (db.BillingCreditLedger, error) {
	if m.creditLedgerErr != nil {
		return db.BillingCreditLedger{}, m.creditLedgerErr
	}
	return m.billingCovQuerier.GetCreditLedgerByIdempotencyKey(ctx, arg)
}

func (m *billingHQuerier) InsertCreditLedgerEntry(ctx context.Context, arg db.InsertCreditLedgerEntryParams) (db.BillingCreditLedger, error) {
	if m.insertCreditErr != nil {
		return db.BillingCreditLedger{}, m.insertCreditErr
	}
	return m.billingCovQuerier.InsertCreditLedgerEntry(ctx, arg)
}

func billingHConfig() BillingServiceConfig {
	return BillingServiceConfig{
		BaseURL:                  "https://smithers.h.test/",
		StripeWebhookSecret:      "whsec_test_secret",
		PersonalMonthlyPriceID:   "price_personal_monthly",
		PersonalAnnualPriceID:    "price_personal_annual",
		ProMonthlyPriceID:        "price_pro_monthly",
		ProAnnualPriceID:         "price_pro_annual",
		TeamMonthlyPriceID:       "price_team_monthly",
		TeamAnnualPriceID:        "price_team_annual",
		EnterpriseMonthlyPriceID: "price_enterprise_monthly",
		EnterpriseAnnualPriceID:  "price_enterprise_annual",
	}
}

func billingHService(q BillingQuerier, stripe StripeBillingClient) *BillingService {
	svc := NewBillingService(q, stripe, billingHConfig())
	svc.now = func() time.Time { return time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC) }
	return svc
}

func billingHStripeClient() *stripeBillingClientMock {
	return &stripeBillingClientMock{
		createCustomerFn: func(context.Context, StripeCreateCustomerInput) (string, error) {
			return "cus_h", nil
		},
		createCheckoutFn: func(context.Context, StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			return StripeCheckoutSessionResult{ID: "cs_h", URL: "https://checkout.h.test/session"}, nil
		},
		createPortalFn: func(context.Context, StripeCreatePortalSessionInput) (string, error) {
			return "https://portal.h.test/session", nil
		},
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			return StripeSubscriptionSnapshot{
				ID:       id,
				PriceID:  "price_personal_monthly",
				Interval: BillingIntervalMonthly,
				Status:   "active",
				Quantity: 1,
				Metadata: map[string]string{"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly"},
			}, nil
		},
		getChargeFn: func(_ context.Context, id string) (StripeChargeSnapshot, error) {
			return StripeChargeSnapshot{ID: id, CustomerID: "cus_h", AmountRefunded: 1234, Currency: "usd"}, nil
		},
		listEntitlementsFn: func(context.Context, string) ([]string, error) {
			return []string{"h_feature"}, nil
		},
	}
}

func billingHAccount(ownerType string, ownerID int64, customerID string) db.BillingAccount {
	return db.BillingAccount{
		ID:                  ownerID + 1000,
		OwnerType:           ownerType,
		OwnerID:             ownerID,
		StripeCustomerID:    customerID,
		StripeCustomerEmail: "billing-h@example.com",
		StripeCustomerName:  "Billing H",
		CreatedAt:           time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		UpdatedAt:           time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC),
	}
}

func billingHSeedAccount(q *billingHQuerier, account db.BillingAccount) {
	q.accountsByOwner[q.ownerKey(account.OwnerType, account.OwnerID)] = account
	q.accountsByCustomer[account.StripeCustomerID] = account
}

func billingHSeedUserRepo(q *billingHQuerier, repoID int64, userID int64) {
	q.usersByID[userID] = db.User{ID: userID, Username: "user-h"}
	q.reposByID[repoID] = db.Repository{ID: repoID, UserID: pgtype.Int8{Int64: userID, Valid: true}}
}

func TestBilling_H_PublicEntryGuardsAndPolicyErrors(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "owner", Email: pgtype.Text{String: "owner@example.com", Valid: true}}

	_, err := billingHService(billingHNewQuerier(), nil).CreateUserCheckout(ctx, nil, "", "")
	assert.Equal(t, 401, httpStatus(err))
	_, err = billingHService(billingHNewQuerier(), billingHStripeClient()).CreateOrgCheckout(ctx, nil, "acme", BillingPlanTeam, BillingIntervalMonthly)
	assert.Equal(t, 401, httpStatus(err))
	_, err = billingHService(billingHNewQuerier(), billingHStripeClient()).CreateOrgPortal(ctx, nil, "acme")
	assert.Equal(t, 401, httpStatus(err))
	_, err = billingHService(billingHNewQuerier(), nil).RefreshUserBilling(ctx, nil)
	assert.Equal(t, 401, httpStatus(err))
	_, err = billingHService(billingHNewQuerier(), nil).RefreshOrgBilling(ctx, nil, "acme")
	assert.Equal(t, 401, httpStatus(err))
	_, err = billingHService(billingHNewQuerier(), nil).RefreshOrgBilling(ctx, actor, "acme")
	assert.Equal(t, 400, httpStatus(err))

	seatErrQueries := billingHNewQuerier()
	seatErrQueries.countOrgMembersFn = func(context.Context, int64) (int64, error) {
		return 0, errors.New("seat counter failed")
	}
	_, err = billingHService(seatErrQueries, billingHStripeClient()).CreateOrgCheckout(ctx, actor, "acme", BillingPlanTeam, BillingIntervalMonthly)
	assert.Equal(t, 500, httpStatus(err))

	policyQueries := billingHNewQuerier()
	policySvc := billingHService(policyQueries, nil)
	require.NoError(t, policySvc.AuthorizePrivateRepo(ctx, "workspace", 123))

	policyQueries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
		return 0, errors.New("private repo read failed")
	}
	err = policySvc.AuthorizePrivateRepo(ctx, BillingOwnerTypeUser, 42)
	assert.Equal(t, 500, httpStatus(err))

	pairingQueries := billingHNewQuerier()
	pairingQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account read failed")
	}
	err = billingHService(pairingQueries, nil).AuthorizePairing(ctx, 42)
	assert.Equal(t, 500, httpStatus(err))

	planErrQueries := billingHNewQuerier()
	billingHSeedAccount(planErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_plan_err"))
	planErrQueries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription read failed")
	}
	err = billingHService(planErrQueries, nil).AuthorizePairing(ctx, 42)
	assert.Equal(t, 500, httpStatus(err))

	authQueries := billingHNewQuerier()
	authSvc := billingHService(authQueries, nil)
	err = authSvc.AuthorizeWorkflowDispatch(ctx, 404)
	assert.Equal(t, 404, httpStatus(err))
	err = authSvc.AuthorizeAgentRun(ctx, 404)
	assert.Equal(t, 404, httpStatus(err))

	billingHSeedUserRepo(authQueries, 10, 42)
	authQueries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
		return 0, errors.New("usage failed")
	}
	err = authSvc.AuthorizeWorkflowDispatch(ctx, 10)
	assert.Equal(t, 500, httpStatus(err))
	err = authSvc.AuthorizeAgentRun(ctx, 10)
	assert.Equal(t, 500, httpStatus(err))

	err = billingHService(billingHNewQuerier(), nil).AuthorizeStorageIncrease(ctx, 404, 1)
	assert.Equal(t, 404, httpStatus(err))

	storageErrQueries := billingHNewQuerier()
	billingHSeedUserRepo(storageErrQueries, 11, 42)
	storageErrQueries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
		return 0, errors.New("usage failed")
	}
	err = billingHService(storageErrQueries, nil).AuthorizeStorageIncrease(ctx, 11, 1)
	assert.Equal(t, 500, httpStatus(err))

	storageLimitQueries := billingHNewQuerier()
	billingHSeedUserRepo(storageLimitQueries, 12, 42)
	storageLimitQueries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
		return 100 * 1024 * 1024 * 1024, nil
	}
	err = billingHService(storageLimitQueries, nil).AuthorizeStorageIncrease(ctx, 12, 1)
	assert.Equal(t, 403, httpStatus(err))
}

func TestBilling_H_UsageAndOverviewFailureBranches(t *testing.T) {
	ctx := context.Background()
	baseLimits := billingPlanLimits{PrivateRepos: 1, StorageBytes: 2, CIMinutes: 3, AgentRuns: 4, Seats: 5}
	fail := errors.New("billing usage failed")

	cases := []struct {
		name  string
		owner billingOwnerRef
		setup func(*billingHQuerier)
	}{
		{
			name:  "private repo count",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42},
			setup: func(q *billingHQuerier) {
				q.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
					return 0, fail
				}
			},
		},
		{
			name:  "storage sum",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42},
			setup: func(q *billingHQuerier) {
				q.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
					return 0, fail
				}
			},
		},
		{
			name:  "workflow minutes",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42},
			setup: func(q *billingHQuerier) {
				q.sumWorkflowMinutesByOwnerFn = func(context.Context, db.SumWorkflowMinutesByOwnerParams) (int64, error) {
					return 0, fail
				}
			},
		},
		{
			name:  "agent runs",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42},
			setup: func(q *billingHQuerier) {
				q.countAgentRunsByOwnerFn = func(context.Context, db.CountAgentRunsByOwnerParams) (int64, error) {
					return 0, fail
				}
			},
		},
		{
			name:  "seat count",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeOrg, OwnerID: 7},
			setup: func(q *billingHQuerier) {
				q.countOrgMembersFn = func(context.Context, int64) (int64, error) {
					return 0, fail
				}
			},
		},
		{
			name:  "usage upsert",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42},
			setup: func(q *billingHQuerier) {
				q.upsertUsageErr = fail
			},
		},
		{
			name:  "usage list",
			owner: billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42},
			setup: func(q *billingHQuerier) {
				q.listUsageErr = fail
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := billingHNewQuerier()
			tc.setup(q)
			_, err := billingHService(q, nil).computeAndPersistUsage(ctx, tc.owner, baseLimits)
			assert.Equal(t, 500, httpStatus(err))
		})
	}

	entitlementQueries := billingHNewQuerier()
	account := billingHAccount(BillingOwnerTypeUser, 42, "cus_entitlements")
	billingHSeedAccount(entitlementQueries, account)
	entitlementQueries.listEntitlementsErr = errors.New("entitlement read failed")
	_, err := billingHService(entitlementQueries, nil).ownerOverview(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42})
	assert.Equal(t, 500, httpStatus(err))

	overviewUsageErrQueries := billingHNewQuerier()
	overviewUsageErrQueries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
		return 0, errors.New("overview usage failed")
	}
	_, err = billingHService(overviewUsageErrQueries, nil).ownerOverview(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42})
	assert.Equal(t, 500, httpStatus(err))

	stateFindErrQueries := billingHNewQuerier()
	stateFindErrQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account read failed")
	}
	_, _, _, _, err = billingHService(stateFindErrQueries, nil).resolveLocalState(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42})
	assert.Equal(t, 500, httpStatus(err))

	stateSubErrQueries := billingHNewQuerier()
	billingHSeedAccount(stateSubErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_state_sub_err"))
	stateSubErrQueries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription read failed")
	}
	_, _, _, _, err = billingHService(stateSubErrQueries, nil).resolveLocalState(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42})
	assert.Equal(t, 500, httpStatus(err))
}

func TestBilling_H_CheckoutPortalAndRefreshFailures(t *testing.T) {
	ctx := context.Background()
	owner := billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42, OwnerName: "alice"}

	_, err := billingHService(billingHNewQuerier(), nil).createCheckoutSession(ctx, owner, "Alice", "alice@example.com", BillingPlanPersonal, BillingIntervalMonthly, 1)
	assert.Equal(t, 400, httpStatus(err))
	_, err = billingHService(billingHNewQuerier(), billingHStripeClient()).createCheckoutSession(ctx, owner, "Alice", "alice@example.com", BillingPlanTeam, BillingIntervalMonthly, 1)
	assert.Equal(t, 400, httpStatus(err))

	ensureErrQueries := billingHNewQuerier()
	ensureErrQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account read failed")
	}
	_, err = billingHService(ensureErrQueries, billingHStripeClient()).createCheckoutSession(ctx, owner, "Alice", "alice@example.com", BillingPlanPersonal, BillingIntervalMonthly, 1)
	assert.Equal(t, 500, httpStatus(err))

	liveSubErrQueries := billingHNewQuerier()
	billingHSeedAccount(liveSubErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_live_sub"))
	liveSubErrQueries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription read failed")
	}
	_, err = billingHService(liveSubErrQueries, billingHStripeClient()).createCheckoutSession(ctx, owner, "Alice", "alice@example.com", BillingPlanPersonal, BillingIntervalMonthly, 1)
	assert.Equal(t, 500, httpStatus(err))

	checkoutErrQueries := billingHNewQuerier()
	billingHSeedAccount(checkoutErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_checkout_err"))
	checkoutErrClient := billingHStripeClient()
	checkoutErrClient.createCheckoutFn = func(context.Context, StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
		return StripeCheckoutSessionResult{}, errors.New("stripe checkout failed")
	}
	_, err = billingHService(checkoutErrQueries, checkoutErrClient).createCheckoutSession(ctx, owner, "Alice", "alice@example.com", BillingPlanPersonal, BillingIntervalMonthly, 1)
	assert.Equal(t, 500, httpStatus(err))

	portalFindErrQueries := billingHNewQuerier()
	portalFindErrQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account read failed")
	}
	_, err = billingHService(portalFindErrQueries, billingHStripeClient()).createPortalSession(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))

	portalErrQueries := billingHNewQuerier()
	billingHSeedAccount(portalErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_portal_err"))
	portalErrClient := billingHStripeClient()
	portalErrClient.createPortalFn = func(context.Context, StripeCreatePortalSessionInput) (string, error) {
		return "", errors.New("stripe portal failed")
	}
	_, err = billingHService(portalErrQueries, portalErrClient).createPortalSession(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))

	refreshFindErrQueries := billingHNewQuerier()
	refreshFindErrQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account read failed")
	}
	err = billingHService(refreshFindErrQueries, billingHStripeClient()).refreshRemoteProjection(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))
	require.NoError(t, billingHService(billingHNewQuerier(), billingHStripeClient()).refreshRemoteProjection(ctx, owner))

	refreshSubErrQueries := billingHNewQuerier()
	billingHSeedAccount(refreshSubErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_refresh_sub"))
	refreshSubErrQueries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription read failed")
	}
	err = billingHService(refreshSubErrQueries, billingHStripeClient()).refreshRemoteProjection(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))

	refreshStripeErrQueries := billingHNewQuerier()
	billingHSeedAccount(refreshStripeErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_refresh_stripe"))
	refreshStripeErrQueries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{StripeSubscriptionID: "sub_refresh"}, nil
	}
	refreshStripeErrClient := billingHStripeClient()
	refreshStripeErrClient.getSubscriptionFn = func(context.Context, string) (StripeSubscriptionSnapshot, error) {
		return StripeSubscriptionSnapshot{}, errors.New("stripe subscription failed")
	}
	err = billingHService(refreshStripeErrQueries, refreshStripeErrClient).refreshRemoteProjection(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))

	refreshUpsertErrQueries := billingHNewQuerier()
	billingHSeedAccount(refreshUpsertErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_refresh_upsert"))
	refreshUpsertErrQueries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{StripeSubscriptionID: "sub_refresh"}, nil
	}
	refreshUpsertErrQueries.upsertBillingSubscriptionFn = func(context.Context, db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription write failed")
	}
	err = billingHService(refreshUpsertErrQueries, billingHStripeClient()).refreshRemoteProjection(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))

	refreshEntitlementErrQueries := billingHNewQuerier()
	billingHSeedAccount(refreshEntitlementErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_refresh_entitlements"))
	refreshEntitlementErrClient := billingHStripeClient()
	refreshEntitlementErrClient.listEntitlementsFn = func(context.Context, string) ([]string, error) {
		return nil, errors.New("stripe entitlements failed")
	}
	err = billingHService(refreshEntitlementErrQueries, refreshEntitlementErrClient).refreshRemoteProjection(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))

	refreshReplaceErrQueries := billingHNewQuerier()
	billingHSeedAccount(refreshReplaceErrQueries, billingHAccount(BillingOwnerTypeUser, 42, "cus_refresh_replace"))
	refreshReplaceErrQueries.resetEntitlementsErr = errors.New("reset failed")
	err = billingHService(refreshReplaceErrQueries, billingHStripeClient()).refreshRemoteProjection(ctx, owner)
	assert.Equal(t, 500, httpStatus(err))
}

func TestBilling_H_WebhookDispatchInvalidPayloadsAndClaims(t *testing.T) {
	ctx := context.Background()
	svc := billingHService(billingHNewQuerier(), nil)

	emptyIDPayload, emptyIDSignature := signedStripeEvent(t, "", "customer.updated", map[string]any{"id": "cus_h"})
	err := svc.HandleStripeWebhook(ctx, emptyIDPayload, emptyIDSignature)
	assert.Equal(t, 400, httpStatus(err))

	claimQueries := billingHNewQuerier()
	claimQueries.claimStripeProcessedEventFn = func(context.Context, db.ClaimStripeProcessedEventParams) (string, error) {
		return "", errors.New("claim failed")
	}
	claimPayload, claimSignature := signedStripeEvent(t, "evt_claim_h", "unhandled.event", map[string]any{"id": "object_h"})
	err = billingHService(claimQueries, nil).HandleStripeWebhook(ctx, claimPayload, claimSignature)
	assert.Equal(t, 500, httpStatus(err))

	for _, eventType := range []string{
		"checkout.session.completed",
		"customer.subscription.created",
		"customer.subscription.trial_will_end",
		"invoice.payment_failed",
		"customer.updated",
		"charge.refunded",
		"charge.dispute.created",
		"entitlements.active_entitlement_summary.updated",
	} {
		t.Run(strings.ReplaceAll(eventType, ".", "_"), func(t *testing.T) {
			err := svc.handleStripeEvent(ctx, "evt_invalid_h", eventType, time.Time{}, json.RawMessage(`{`))
			assert.Equal(t, 400, httpStatus(err))
		})
	}
}

func TestBilling_H_WebhookHandlerErrorBranches(t *testing.T) {
	ctx := context.Background()
	account := billingHAccount(BillingOwnerTypeUser, 42, "cus_h")

	checkoutUpsertErrQueries := billingHNewQuerier()
	checkoutUpsertErrQueries.upsertBillingAccountFn = func(context.Context, db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account write failed")
	}
	err := billingHService(checkoutUpsertErrQueries, nil).handleCheckoutSessionCompleted(ctx, stripeCheckoutSessionPayload{
		Customer: "cus_h",
		Metadata: map[string]string{"owner_type": BillingOwnerTypeUser, "owner_id": "42"},
	})
	assert.Equal(t, 500, httpStatus(err))

	checkoutStripeErrQueries := billingHNewQuerier()
	checkoutStripeErrClient := billingHStripeClient()
	checkoutStripeErrClient.getSubscriptionFn = func(context.Context, string) (StripeSubscriptionSnapshot, error) {
		return StripeSubscriptionSnapshot{}, errors.New("stripe subscription failed")
	}
	err = billingHService(checkoutStripeErrQueries, checkoutStripeErrClient).handleCheckoutSessionCompleted(ctx, stripeCheckoutSessionPayload{
		Customer:     "cus_h",
		Subscription: "sub_h",
		Metadata:     map[string]string{"owner_type": BillingOwnerTypeUser, "owner_id": "42"},
	})
	// A failed fetch fails the webhook so Stripe redelivers it.
	assert.Equal(t, 500, httpStatus(err))

	subscriptionLookupErrQueries := billingHNewQuerier()
	subscriptionLookupErrQueries.getBillingAccountByStripeCustomerFn = func(context.Context, string) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account lookup failed")
	}
	err = billingHService(subscriptionLookupErrQueries, nil).handleSubscriptionEvent(ctx, stripeSubscriptionPayload{Customer: "cus_h"}, nil)
	assert.Equal(t, 500, httpStatus(err))

	err = billingHService(billingHNewQuerier(), nil).handleSubscriptionEvent(ctx, stripeSubscriptionPayload{
		Customer: "cus_missing",
		Metadata: map[string]string{"owner_type": "bad", "owner_id": "42"},
	}, nil)
	require.NoError(t, err)

	subscriptionUpsertErrQueries := billingHNewQuerier()
	subscriptionUpsertErrQueries.upsertBillingAccountFn = func(context.Context, db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account write failed")
	}
	err = billingHService(subscriptionUpsertErrQueries, nil).handleSubscriptionEvent(ctx, stripeSubscriptionPayload{
		Customer: "cus_new_h",
		Metadata: map[string]string{"owner_type": BillingOwnerTypeUser, "owner_id": "42"},
	}, nil)
	assert.Equal(t, 500, httpStatus(err))

	trialEventErrQueries := billingHNewQuerier()
	trialEventErrQueries.upsertBillingSubscriptionFn = func(context.Context, db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription write failed")
	}
	billingHSeedAccount(trialEventErrQueries, account)
	err = billingHService(trialEventErrQueries, nil).handleSubscriptionTrialWillEnd(ctx, stripeSubscriptionPayload{Customer: "cus_h", Status: "trialing"}, nil)
	assert.Equal(t, 500, httpStatus(err))

	err = billingHService(billingHNewQuerier(), nil).handleSubscriptionTrialWillEnd(ctx, stripeSubscriptionPayload{
		Metadata: map[string]string{"owner_type": BillingOwnerTypeUser, "owner_id": "42"},
		Status:   "trialing",
	}, nil)
	require.NoError(t, err)

	err = billingHService(billingHNewQuerier(), nil).handleInvoicePaymentFailed(ctx, stripeInvoicePaymentFailedPayload{Customer: "cus_missing"})
	require.NoError(t, err)

	invoiceQueries := billingHNewQuerier()
	billingHSeedAccount(invoiceQueries, account)
	emailSender := &mockBillingEmailSender{}
	err = NewBillingService(invoiceQueries, nil, billingHConfig(), WithBillingEmailSender(emailSender)).handleInvoicePaymentFailed(ctx, stripeInvoicePaymentFailedPayload{
		ID:            "in_h",
		Customer:      "cus_h",
		AmountDue:     999,
		Currency:      "usd",
		CustomerEmail: "new-billing@example.com",
		CustomerName:  "New Billing H",
	})
	require.NoError(t, err)
	require.Len(t, emailSender.calls, 1)
	assert.Equal(t, "new-billing@example.com", emailSender.calls[0].ToEmail)
	assert.Contains(t, emailSender.calls[0].Body, "invoice in_h")

	invoiceUpdateErrQueries := billingHNewQuerier()
	billingHSeedAccount(invoiceUpdateErrQueries, account)
	invoiceUpdateErrQueries.upsertBillingAccountFn = func(context.Context, db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account write failed")
	}
	err = billingHService(invoiceUpdateErrQueries, nil).handleInvoicePaymentFailed(ctx, stripeInvoicePaymentFailedPayload{
		Customer:      "cus_h",
		CustomerEmail: "new-billing@example.com",
	})
	assert.Equal(t, 500, httpStatus(err))

	invoiceStripeErrQueries := billingHNewQuerier()
	billingHSeedAccount(invoiceStripeErrQueries, account)
	invoiceStripeErrClient := billingHStripeClient()
	invoiceStripeErrClient.getSubscriptionFn = func(context.Context, string) (StripeSubscriptionSnapshot, error) {
		return StripeSubscriptionSnapshot{}, errors.New("stripe subscription failed")
	}
	err = billingHService(invoiceStripeErrQueries, invoiceStripeErrClient).handleInvoicePaymentFailed(ctx, stripeInvoicePaymentFailedPayload{
		Customer:     "cus_h",
		Subscription: "sub_h",
	})
	assert.Equal(t, 500, httpStatus(err))

	invoiceUpsertErrQueries := billingHNewQuerier()
	billingHSeedAccount(invoiceUpsertErrQueries, account)
	invoiceUpsertErrQueries.upsertBillingSubscriptionFn = func(context.Context, db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("subscription write failed")
	}
	err = billingHService(invoiceUpsertErrQueries, billingHStripeClient()).handleInvoicePaymentFailed(ctx, stripeInvoicePaymentFailedPayload{
		Customer:     "cus_h",
		Subscription: "sub_h",
	})
	assert.Equal(t, 500, httpStatus(err))

	require.NoError(t, billingHService(billingHNewQuerier(), nil).handleCustomerUpdated(ctx, stripeCustomerPayload{ID: "cus_missing"}))

	refundStripeErrClient := billingHStripeClient()
	refundStripeErrClient.getChargeFn = func(context.Context, string) (StripeChargeSnapshot, error) {
		return StripeChargeSnapshot{}, errors.New("stripe charge failed")
	}
	err = billingHService(billingHNewQuerier(), refundStripeErrClient).handleChargeRefunded(ctx, "evt_refund_h", time.Time{}, stripeChargePayload{ID: "ch_h"})
	assert.Equal(t, 500, httpStatus(err))
	require.NoError(t, billingHService(billingHNewQuerier(), nil).handleChargeRefunded(ctx, "evt_refund_missing_h", time.Time{}, stripeChargePayload{Customer: "cus_missing"}))

	disputeStripeErrClient := billingHStripeClient()
	disputeStripeErrClient.getChargeFn = func(context.Context, string) (StripeChargeSnapshot, error) {
		return StripeChargeSnapshot{}, errors.New("stripe charge failed")
	}
	err = billingHService(billingHNewQuerier(), disputeStripeErrClient).handleChargeDisputeCreated(ctx, "evt_dispute_h", time.Time{}, stripeDisputePayload{Charge: "ch_h"})
	assert.Equal(t, 500, httpStatus(err))
	require.NoError(t, billingHService(billingHNewQuerier(), nil).handleChargeDisputeCreated(ctx, "evt_dispute_missing_h", time.Time{}, stripeDisputePayload{}))

	entitlementFindErrQueries := billingHNewQuerier()
	entitlementFindErrQueries.getBillingAccountByStripeCustomerFn = func(context.Context, string) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account lookup failed")
	}
	err = billingHService(entitlementFindErrQueries, nil).handleEntitlementEvent(ctx, stripeEntitlementSummaryPayload{Customer: "cus_h"})
	assert.Equal(t, 500, httpStatus(err))
	require.NoError(t, billingHService(billingHNewQuerier(), nil).handleEntitlementEvent(ctx, stripeEntitlementSummaryPayload{Customer: "cus_missing"}))

	resetErrQueries := billingHNewQuerier()
	resetErrQueries.resetEntitlementsErr = errors.New("reset failed")
	err = billingHService(resetErrQueries, nil).replaceEntitlements(ctx, 99, []string{"a"})
	assert.Equal(t, 500, httpStatus(err))

	upsertErrQueries := billingHNewQuerier()
	upsertErrQueries.upsertEntitlementErr = errors.New("upsert failed")
	err = billingHService(upsertErrQueries, nil).replaceEntitlements(ctx, 99, []string{"a"})
	assert.Equal(t, 500, httpStatus(err))
}

func TestBilling_H_CreditAuditErrorBranches(t *testing.T) {
	ctx := context.Background()
	account := billingHAccount(BillingOwnerTypeUser, 42, "cus_credit_h")

	require.NoError(t, billingHService(billingHNewQuerier(), nil).recordStripeCreditAudit(ctx, account, " ", "refund", "metric", "blank id"))

	existingQueries := billingHNewQuerier()
	existingSvc := billingHService(existingQueries, nil)
	require.NoError(t, existingSvc.recordStripeCreditAudit(ctx, account, "evt_existing", "refund", "metric", "first"))
	require.NoError(t, existingSvc.recordStripeCreditAudit(ctx, account, "evt_existing", "refund", "metric", "second"))
	assert.Len(t, existingQueries.creditEntries, 1)

	ledgerErrQueries := billingHNewQuerier()
	ledgerErrQueries.creditLedgerErr = errors.New("ledger read failed")
	err := billingHService(ledgerErrQueries, nil).recordStripeCreditAudit(ctx, account, "evt_ledger_err", "refund", "metric", "reason")
	assert.Equal(t, 500, httpStatus(err))

	balanceQueries := billingHNewQuerier()
	ledger := newFakeCreditLedger()
	creditAccount, err := ledger.EnsureAccount(ctx, account.OwnerType, account.OwnerID)
	require.NoError(t, err)
	require.NoError(t, ledger.Grant(ctx, creditAccount, "g", 250*credits.NanosPerCent+1, nil))
	svc := billingHService(balanceQueries, nil)
	WithBillingCreditLedger(ledger)(svc)
	require.NoError(t, svc.recordStripeCreditAudit(ctx, account, "evt_balance_success", "refund", "metric", "reason"))
	require.Len(t, balanceQueries.creditEntries, 1)
	assert.Zero(t, balanceQueries.creditEntries[0].AmountCents)
	assert.Equal(t, int64(250), balanceQueries.creditEntries[0].BalanceAfterCents)

	ledger.err = errors.New("balance read failed")
	err = svc.recordStripeCreditAudit(ctx, account, "evt_balance_err", "refund", "metric", "reason")
	assert.Equal(t, 500, httpStatus(err))

	insertErrQueries := billingHNewQuerier()
	insertErrQueries.insertCreditErr = errors.New("insert failed")
	err = billingHService(insertErrQueries, nil).recordStripeCreditAudit(ctx, account, "evt_insert_err", "refund", "metric", "reason")
	assert.Equal(t, 500, httpStatus(err))
}

func TestBilling_H_SubscriptionPlanResolverAndSmallHelpers(t *testing.T) {
	ctx := context.Background()
	account := billingHAccount(BillingOwnerTypeUser, 42, "cus_sub_h")

	overrideQueries := billingHNewQuerier()
	var overrideUpsert db.UpsertBillingSubscriptionParams
	overrideQueries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		overrideUpsert = arg
		return db.BillingSubscription{}, nil
	}
	require.NoError(t, billingHService(overrideQueries, nil).upsertSubscriptionSnapshot(ctx, account, StripeSubscriptionSnapshot{
		ID:      "sub_override",
		Status:  "active",
		PlanKey: "manual_override",
	}))
	assert.Equal(t, "manual_override", overrideUpsert.PlanKey)

	blankPlanQueries := billingHNewQuerier()
	var blankPlanUpsert db.UpsertBillingSubscriptionParams
	blankPlanQueries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		blankPlanUpsert = arg
		return db.BillingSubscription{}, nil
	}
	blankPlanSvc := billingHService(blankPlanQueries, nil)
	blankPlanSvc.checkoutPlans["blank"] = map[string]billingPlanDefinition{
		BillingPlanFree: {},
	}
	require.NoError(t, blankPlanSvc.upsertSubscriptionSnapshot(ctx, db.BillingAccount{ID: 444, OwnerType: "blank", OwnerID: 1}, StripeSubscriptionSnapshot{
		ID:     "sub_blank_plan",
		Status: "active",
	}))
	assert.Equal(t, BillingPlanCustom, blankPlanUpsert.PlanKey)

	uncertainQueries := billingHNewQuerier()
	uncertainQueries.listBillingSubscriptionsByAccountFn = func(context.Context, int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_competing", Status: "active"}}, nil
	}
	uncertainClient := billingHStripeClient()
	uncertainClient.getSubscriptionFn = func(context.Context, string) (StripeSubscriptionSnapshot, error) {
		return StripeSubscriptionSnapshot{}, errors.New("stripe verify failed")
	}
	require.NoError(t, billingHService(uncertainQueries, uncertainClient).upsertSubscriptionSnapshot(ctx, account, StripeSubscriptionSnapshot{
		ID:       "sub_new_uncertain",
		Status:   "active",
		Metadata: map[string]string{"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly"},
	}))
	assert.Empty(t, uncertainClient.canceledSubscriptions)

	cancelErrQueries := billingHNewQuerier()
	cancelErrQueries.listBillingSubscriptionsByAccountFn = func(context.Context, int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_competing", Status: "active"}}, nil
	}
	cancelErrClient := billingHStripeClient()
	cancelErrClient.cancelSubscriptionErr = errors.New("cancel failed")
	require.NoError(t, billingHService(cancelErrQueries, cancelErrClient).upsertSubscriptionSnapshot(ctx, account, StripeSubscriptionSnapshot{
		ID:       "sub_cancel_err",
		Status:   "active",
		Metadata: map[string]string{"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly"},
	}))
	assert.Empty(t, cancelErrClient.canceledSubscriptions)

	ensureFindErrQueries := billingHNewQuerier()
	ensureFindErrQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account read failed")
	}
	_, err := billingHService(ensureFindErrQueries, billingHStripeClient()).ensureBillingAccount(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42}, " Alice ", " alice@example.com ")
	assert.Equal(t, 500, httpStatus(err))

	createCustomerErrClient := billingHStripeClient()
	createCustomerErrClient.createCustomerFn = func(context.Context, StripeCreateCustomerInput) (string, error) {
		return "", errors.New("customer create failed")
	}
	_, err = billingHService(billingHNewQuerier(), createCustomerErrClient).ensureBillingAccount(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42}, " Alice ", " alice@example.com ")
	assert.Equal(t, 500, httpStatus(err))

	upsertAccountErrQueries := billingHNewQuerier()
	upsertAccountErrQueries.upsertBillingAccountFn = func(context.Context, db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("account write failed")
	}
	_, err = billingHService(upsertAccountErrQueries, billingHStripeClient()).ensureBillingAccount(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42}, " Alice ", " alice@example.com ")
	assert.Equal(t, 500, httpStatus(err))

	orgErrSvc := billingHService(billingHNewQuerier(), nil)
	orgNotFoundQueries := billingHNewQuerier()
	orgNotFoundQueries.orgLowerErr = pgx.ErrNoRows
	_, err = billingHService(orgNotFoundQueries, nil).resolveOrgOwner(ctx, &db.User{ID: 1}, "missing")
	assert.Equal(t, 404, httpStatus(err))
	orgInternalQueries := billingHNewQuerier()
	orgInternalQueries.orgLowerErr = errors.New("org read failed")
	_, err = billingHService(orgInternalQueries, nil).resolveOrgOwner(ctx, &db.User{ID: 1}, "acme")
	assert.Equal(t, 500, httpStatus(err))
	memberInternalQueries := billingHNewQuerier()
	memberInternalQueries.orgMemberErr = errors.New("member read failed")
	_, err = billingHService(memberInternalQueries, nil).resolveOrgOwner(ctx, &db.User{ID: 1}, "acme")
	assert.Equal(t, 500, httpStatus(err))
	count, err := orgErrSvc.currentSeatCount(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeOrg, OwnerID: 7})
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
	positiveSeatsQueries := billingHNewQuerier()
	positiveSeatsQueries.countOrgMembersFn = func(context.Context, int64) (int64, error) { return 3, nil }
	count, err = billingHService(positiveSeatsQueries, nil).currentSeatCount(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeOrg, OwnerID: 7})
	require.NoError(t, err)
	assert.Equal(t, int64(3), count)
	assert.Equal(t, int64(3), mustPositiveBillingSeatCount(3))
	assert.Panics(t, func() { mustPositiveBillingSeatCount(0) })
	resolvedAccount := billingHAccount(BillingOwnerTypeUser, 42, "cus_must_resolve")
	assert.Same(t, &resolvedAccount, mustResolvedBillingAccount(&resolvedAccount))
	assert.Panics(t, func() { mustResolvedBillingAccount(nil) })

	repoInternalQueries := billingHNewQuerier()
	repoInternalQueries.repoErr = errors.New("repo read failed")
	_, _, err = billingHService(repoInternalQueries, nil).resolveRepoOwner(ctx, 1)
	assert.Equal(t, 500, httpStatus(err))
	userOwnerErrQueries := billingHNewQuerier()
	userOwnerErrQueries.reposByID[1] = db.Repository{ID: 1, UserID: pgtype.Int8{Int64: 42, Valid: true}}
	_, _, err = billingHService(userOwnerErrQueries, nil).resolveRepoOwner(ctx, 1)
	assert.Equal(t, 500, httpStatus(err))
	orgOwnerErrQueries := billingHNewQuerier()
	orgOwnerErrQueries.reposByID[2] = db.Repository{ID: 2, OrgID: pgtype.Int8{Int64: 7, Valid: true}}
	_, _, err = billingHService(orgOwnerErrQueries, nil).resolveRepoOwner(ctx, 2)
	assert.Equal(t, 500, httpStatus(err))
	noOwnerQueries := billingHNewQuerier()
	noOwnerQueries.reposByID[3] = db.Repository{ID: 3}
	_, _, err = billingHService(noOwnerQueries, nil).resolveRepoOwner(ctx, 3)
	assert.Equal(t, 500, httpStatus(err))

	planSvc := billingHService(billingHNewQuerier(), nil)
	assert.Equal(t, BillingPlanFree, planSvc.planForSubscription(BillingOwnerTypeUser, nil).Key)
	assert.Equal(t, BillingPlanFree, planSvc.planForSubscription(BillingOwnerTypeUser, &db.BillingSubscription{Status: "canceled", PlanKey: BillingPlanPersonal}).Key)
	assert.Equal(t, BillingIntervalMonthly, planSvc.planForSubscription(BillingOwnerTypeUser, &db.BillingSubscription{Status: "active", PlanKey: BillingPlanPersonal, BillingInterval: BillingIntervalMonthly}).Interval)
	blankFallbackSvc := billingHService(billingHNewQuerier(), nil)
	blankFallbackSvc.checkoutPlans["blank"] = map[string]billingPlanDefinition{BillingPlanFree: {}}
	assert.Empty(t, blankFallbackSvc.planForSubscription("blank", &db.BillingSubscription{Status: "active"}).Key)
	assert.Equal(t, BillingPlanFree, planSvc.planFromPrice("unknown-owner", "missing", "year").Key)
	orgDefaultPlan, err := planSvc.checkoutPlan(BillingOwnerTypeOrg, "", "")
	require.NoError(t, err)
	assert.Equal(t, BillingPlanTeam, orgDefaultPlan.Key)

	findOwnerErrQueries := billingHNewQuerier()
	findOwnerErrQueries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("owner account read failed")
	}
	_, err = billingHService(findOwnerErrQueries, nil).findBillingAccountByOwner(ctx, BillingOwnerTypeUser, 42)
	assert.Equal(t, 500, httpStatus(err))
	accountByCustomer, err := planSvc.findBillingAccountByCustomerID(ctx, " ")
	require.NoError(t, err)
	assert.Nil(t, accountByCustomer)
	findCustomerErrQueries := billingHNewQuerier()
	findCustomerErrQueries.getBillingAccountByStripeCustomerFn = func(context.Context, string) (db.BillingAccount, error) {
		return db.BillingAccount{}, errors.New("customer account read failed")
	}
	_, err = billingHService(findCustomerErrQueries, nil).findBillingAccountByCustomerID(ctx, "cus_h")
	assert.Equal(t, 500, httpStatus(err))
	claimInternalQueries := billingHNewQuerier()
	claimInternalQueries.claimStripeProcessedEventFn = func(context.Context, db.ClaimStripeProcessedEventParams) (string, error) {
		return "", errors.New("claim failed")
	}
	_, err = billingHService(claimInternalQueries, nil).claimStripeProcessedEvent(ctx, "evt_h", "type_h")
	assert.Equal(t, 500, httpStatus(err))

	planSvc.sendBillingNotification(ctx, db.BillingAccount{StripeCustomerEmail: "billing@example.com"}, "subject", "body")
	emailSender := &mockBillingEmailSender{}
	emailSvc := NewBillingService(billingHNewQuerier(), nil, billingHConfig(), WithBillingEmailSender(emailSender))
	emailSvc.sendBillingNotification(ctx, db.BillingAccount{StripeCustomerEmail: " "}, "subject", "body")
	assert.Empty(t, emailSender.calls)

	urlSvc := NewBillingService(billingHNewQuerier(), nil, BillingServiceConfig{
		BaseURL:            "https://smithers.h.test",
		CheckoutSuccessURL: " https://success.h.test ",
		CheckoutCancelURL:  " https://cancel.h.test ",
	})
	assert.Equal(t, "https://success.h.test", urlSvc.checkoutSuccessURL(billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerName: "alice"}))
	assert.Equal(t, "https://cancel.h.test", urlSvc.checkoutCancelURL(billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerName: "alice"}))
	assert.NoError(t, planSvc.enforceMetricLimit(unlimitedBillingQuantity, BillingUsageSummary{ConsumedQuantity: unlimitedBillingQuantity}, "anything"))
	_, ok := ownerFromMetadata(map[string]string{"owner_type": BillingOwnerTypeUser, "owner_id": "0"})
	assert.False(t, ok)
	assert.Equal(t, int64(1), snapshotFromWebhookSubscription(stripeSubscriptionPayload{ID: "sub_no_items"}, nil).Quantity)
	assert.Equal(t, int64(3), overageQuantity(8, 5))
	ordered := orderUsageSummaries(map[string]BillingUsageSummary{
		"z_extra":                 {MetricKey: "z_extra"},
		"another_extra":           {MetricKey: "another_extra"},
		BillingMetricPrivateRepos: {MetricKey: BillingMetricPrivateRepos},
	})
	assert.Equal(t, BillingMetricPrivateRepos, ordered[0].MetricKey)
	assert.Contains(t, []string{ordered[1].MetricKey, ordered[2].MetricKey}, "z_extra")
}
