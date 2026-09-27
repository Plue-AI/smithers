package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type billingCovQuerier struct {
	*billingQuerierMock
	deactivatedAccounts []int64
	entitlementUpserts  []db.UpsertBillingEntitlementParams
	entitlementsByAcct  map[int64][]db.BillingEntitlement
	usersByID           map[int64]db.User
	orgsByID            map[int64]db.Organization
	reposByID           map[int64]db.Repository
	orgMemberRole       string
	orgMemberErr        error
}

func billingCovNewQuerier() *billingCovQuerier {
	return &billingCovQuerier{
		billingQuerierMock: newBillingQuerierMock(),
		entitlementsByAcct: map[int64][]db.BillingEntitlement{},
		usersByID:          map[int64]db.User{},
		orgsByID:           map[int64]db.Organization{},
		reposByID:          map[int64]db.Repository{},
		orgMemberRole:      "owner",
	}
}

func (m *billingCovQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	if user, ok := m.usersByID[id]; ok {
		return user, nil
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *billingCovQuerier) GetOrgByID(_ context.Context, id int64) (db.Organization, error) {
	if org, ok := m.orgsByID[id]; ok {
		return org, nil
	}
	return db.Organization{}, pgx.ErrNoRows
}

func (m *billingCovQuerier) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	if repo, ok := m.reposByID[id]; ok {
		return repo, nil
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *billingCovQuerier) GetOrgMember(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
	if m.orgMemberErr != nil {
		return db.OrgMember{}, m.orgMemberErr
	}
	return db.OrgMember{Role: m.orgMemberRole}, nil
}

func (m *billingCovQuerier) DeactivateBillingEntitlementsByAccount(_ context.Context, billingAccountID int64) error {
	m.deactivatedAccounts = append(m.deactivatedAccounts, billingAccountID)
	return nil
}

func (m *billingCovQuerier) UpsertBillingEntitlement(_ context.Context, arg db.UpsertBillingEntitlementParams) (db.BillingEntitlement, error) {
	m.entitlementUpserts = append(m.entitlementUpserts, arg)
	return db.BillingEntitlement{
		ID:               int64(len(m.entitlementUpserts)),
		BillingAccountID: arg.BillingAccountID,
		FeatureKey:       arg.FeatureKey,
		Active:           arg.Active,
		LastSyncedAt:     arg.LastSyncedAt,
	}, nil
}

func (m *billingCovQuerier) ListBillingEntitlementsByAccount(_ context.Context, billingAccountID int64) ([]db.BillingEntitlement, error) {
	return m.entitlementsByAcct[billingAccountID], nil
}

func TestBilling_Cov_UserOverviewPortalRefreshAndGuards(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	trialEnd := pgtype.Timestamptz{Time: now.Add(7 * 24 * time.Hour), Valid: true}
	periodStart := pgtype.Timestamptz{Time: now.Add(-24 * time.Hour), Valid: true}
	periodEnd := pgtype.Timestamptz{Time: now.Add(30 * 24 * time.Hour), Valid: true}

	queries := billingCovNewQuerier()
	account := db.BillingAccount{
		ID:                  11,
		OwnerType:           BillingOwnerTypeUser,
		OwnerID:             42,
		StripeCustomerID:    "cus_user_42",
		StripeCustomerEmail: "alice@example.com",
		StripeCustomerName:  "Alice Billing",
		CreatedAt:           now.Add(-time.Hour),
		UpdatedAt:           now,
	}
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   55,
			BillingAccountID:     account.ID,
			StripeSubscriptionID: "sub_user_42",
			StripePriceID:        "price_pro_annual",
			BillingInterval:      BillingIntervalAnnual,
			Status:               "active",
			Quantity:             1,
			TrialEnd:             trialEnd,
			CurrentPeriodStart:   periodStart,
			CurrentPeriodEnd:     periodEnd,
		}, nil
	}
	queries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) { return 3, nil }
	queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) { return 4096, nil }
	queries.sumWorkflowMinutesByOwnerFn = func(context.Context, db.SumWorkflowMinutesByOwnerParams) (int64, error) { return 17, nil }
	queries.countAgentRunsByOwnerFn = func(context.Context, db.CountAgentRunsByOwnerParams) (int64, error) { return 5, nil }
	queries.entitlementsByAcct[account.ID] = []db.BillingEntitlement{
		{FeatureKey: "priority_support", Active: true, LastSyncedAt: now},
	}

	var gotPortal StripeCreatePortalSessionInput
	client := &stripeBillingClientMock{
		createPortalFn: func(_ context.Context, input StripeCreatePortalSessionInput) (string, error) {
			gotPortal = input
			return "https://billing.stripe.test/portal", nil
		},
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			require.Equal(t, "sub_user_42", id)
			return StripeSubscriptionSnapshot{
				ID:       id,
				PriceID:  "price_pro_annual",
				Interval: BillingIntervalAnnual,
				Status:   "active",
				Quantity: 1,
				Metadata: map[string]string{"owner_type": "user", "owner_id": "42", "plan_key": "pro", "interval": "annual"},
			}, nil
		},
		listEntitlementsFn: func(context.Context, string) ([]string, error) {
			return []string{" team ", "priority", "team", "", "audit"}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:            "https://smithers.test/",
		ProAnnualPriceID:   "price_pro_annual",
		PortalReturnURL:    " https://app.example.test/billing ",
		CheckoutSuccessURL: " https://app.example.test/success ",
		CheckoutCancelURL:  " https://app.example.test/cancel ",
	})
	svc.now = func() time.Time { return now }

	user := &db.User{ID: 42, Username: "alice", DisplayName: "Alice", Email: pgtype.Text{String: "alice@example.com", Valid: true}}
	overview, err := svc.GetUserOverview(ctx, user)
	require.NoError(t, err)
	assert.Equal(t, BillingOwnerTypeUser, overview.OwnerType)
	assert.Equal(t, BillingPlanPro, overview.PlanKey)
	assert.Equal(t, BillingIntervalAnnual, overview.BillingInterval)
	require.NotNil(t, overview.Account)
	assert.Equal(t, "cus_user_42", overview.Account.StripeCustomerID)
	require.NotNil(t, overview.Subscription)
	require.NotNil(t, overview.Subscription.TrialEnd)
	assert.Equal(t, trialEnd.Time, *overview.Subscription.TrialEnd)
	require.Len(t, overview.Entitlements, 1)
	assert.Equal(t, "priority_support", overview.Entitlements[0].FeatureKey)
	require.Len(t, overview.Usage, 6)
	assert.Equal(t, []string{BillingMetricPrivateRepos, BillingMetricStorageBytes, BillingMetricCIMinutes, BillingMetricAgentRuns, BillingMetricSeats, BillingMetricSandboxHours},
		[]string{overview.Usage[0].MetricKey, overview.Usage[1].MetricKey, overview.Usage[2].MetricKey, overview.Usage[3].MetricKey, overview.Usage[4].MetricKey, overview.Usage[5].MetricKey})
	assert.Equal(t, int64(5), overview.Usage[3].ConsumedQuantity)

	portal, err := svc.CreateUserPortal(ctx, user)
	require.NoError(t, err)
	assert.Equal(t, "https://billing.stripe.test/portal", portal.URL)
	assert.Equal(t, "cus_user_42", gotPortal.CustomerID)
	assert.Equal(t, "https://app.example.test/billing", gotPortal.ReturnURL)

	refreshed, err := svc.RefreshUserBilling(ctx, user)
	require.NoError(t, err)
	assert.Equal(t, BillingPlanPro, refreshed.PlanKey)
	assert.Equal(t, []int64{account.ID}, queries.deactivatedAccounts)
	require.Len(t, queries.entitlementUpserts, 3)
	assert.Equal(t, []string{"audit", "priority", "team"},
		[]string{queries.entitlementUpserts[0].FeatureKey, queries.entitlementUpserts[1].FeatureKey, queries.entitlementUpserts[2].FeatureKey})

	_, err = svc.GetUserOverview(ctx, nil)
	assert.Equal(t, 401, httpStatus(err))
	_, err = svc.CreateUserPortal(ctx, nil)
	assert.Equal(t, 401, httpStatus(err))
	_, err = NewBillingService(queries, nil, BillingServiceConfig{}).CreateUserPortal(ctx, user)
	assert.Equal(t, 400, httpStatus(err))
	_, err = NewBillingService(billingCovNewQuerier(), client, BillingServiceConfig{}).CreateUserPortal(ctx, user)
	assert.Equal(t, 404, httpStatus(err))
	_, err = NewBillingService(queries, nil, BillingServiceConfig{}).RefreshUserBilling(ctx, user)
	assert.Equal(t, 400, httpStatus(err))
}

func TestBilling_Cov_OrgCheckoutOverviewAndRepoAuthorizations(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "owner", Email: pgtype.Text{String: "owner@example.com", Valid: true}}

	queries := billingCovNewQuerier()
	queries.countOrgMembersFn = func(context.Context, int64) (int64, error) { return 0, nil }
	queries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) { return 2, nil }
	queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) { return 100, nil }
	queries.sumWorkflowMinutesByOwnerFn = func(context.Context, db.SumWorkflowMinutesByOwnerParams) (int64, error) { return 200, nil }
	queries.countAgentRunsByOwnerFn = func(context.Context, db.CountAgentRunsByOwnerParams) (int64, error) { return 300, nil }
	queries.usersByID[99] = db.User{ID: 99, Username: "repo-owner"}
	queries.orgsByID[77] = db.Organization{ID: 77, Name: "Acme", LowerName: "acme"}
	queries.reposByID[1] = db.Repository{ID: 1, UserID: pgtype.Int8{Int64: 99, Valid: true}}
	queries.reposByID[2] = db.Repository{ID: 2, OrgID: pgtype.Int8{Int64: 77, Valid: true}}

	var gotCheckout StripeCreateCheckoutSessionInput
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, input StripeCreateCustomerInput) (string, error) {
			assert.Equal(t, "org", input.Metadata["owner_type"])
			assert.Equal(t, "7", input.Metadata["owner_id"])
			assert.Equal(t, "owner@example.com", input.Email)
			return "cus_org_7", nil
		},
		createCheckoutFn: func(_ context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			gotCheckout = input
			return StripeCheckoutSessionResult{ID: "cs_org", URL: "https://checkout.stripe.test/org"}, nil
		},
		createPortalFn: func(_ context.Context, input StripeCreatePortalSessionInput) (string, error) {
			assert.Equal(t, "cus_org_7", input.CustomerID)
			assert.Equal(t, "https://smithers.test/orgs/acme/settings/billing", input.ReturnURL)
			return "https://billing.stripe.test/org-portal", nil
		},
		listEntitlementsFn: func(context.Context, string) ([]string, error) { return nil, nil },
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:            "https://smithers.test",
		TeamMonthlyPriceID: "price_team_monthly",
		TeamAnnualPriceID:  "price_team_annual",
	})

	// Annual billing is refused even with an annual price configured.
	_, err := svc.CreateOrgCheckout(ctx, actor, " Acme ", BillingPlanTeam, "year")
	assert.Equal(t, 400, httpStatus(err))
	checkout, err := svc.CreateOrgCheckout(ctx, actor, " Acme ", BillingPlanTeam, "month")
	require.NoError(t, err)
	assert.Equal(t, "https://checkout.stripe.test/org", checkout.URL)
	assert.Equal(t, "price_team_monthly", gotCheckout.PriceID)
	assert.Equal(t, int64(1), gotCheckout.Quantity, "empty orgs still buy at least one seat")
	assert.Equal(t, "org", gotCheckout.Metadata["owner_type"])
	assert.Equal(t, BillingIntervalMonthly, gotCheckout.Metadata["interval"])

	overview, err := svc.GetOrgOverview(ctx, actor, "acme")
	require.NoError(t, err)
	assert.Equal(t, BillingOwnerTypeOrg, overview.OwnerType)
	assert.Equal(t, "acme", overview.OwnerName)
	assert.Equal(t, BillingPlanFree, overview.PlanKey)
	assert.Equal(t, int64(1), overview.Usage[4].ConsumedQuantity)

	portal, err := svc.CreateOrgPortal(ctx, actor, "acme")
	require.NoError(t, err)
	assert.Equal(t, "https://billing.stripe.test/org-portal", portal.URL)
	_, err = svc.RefreshOrgBilling(ctx, actor, "acme")
	require.NoError(t, err)

	require.NoError(t, svc.AuthorizeWorkflowDispatch(ctx, 1))
	require.NoError(t, svc.AuthorizeAgentRun(ctx, 2))
	require.NoError(t, svc.AuthorizeStorageIncrease(ctx, 1, 0))
	require.NoError(t, svc.AuthorizeStorageIncrease(ctx, 1, 50))
	_, _, err = svc.resolveRepoOwner(ctx, 999)
	assert.Equal(t, 404, httpStatus(err))

	queries.orgMemberRole = "member"
	_, err = svc.GetOrgOverview(ctx, actor, "acme")
	assert.Equal(t, 403, httpStatus(err))
	queries.orgMemberRole = "owner"
	_, err = svc.GetOrgOverview(ctx, nil, "acme")
	assert.Equal(t, 401, httpStatus(err))
	_, err = svc.GetOrgOverview(ctx, actor, " ")
	assert.Equal(t, 400, httpStatus(err))
	queries.orgMemberErr = pgx.ErrNoRows
	_, err = svc.GetOrgOverview(ctx, actor, "acme")
	assert.Equal(t, 403, httpStatus(err))
}

func TestBilling_Cov_WebhookErrorsCheckoutEntitlementsAndAudits(t *testing.T) {
	ctx := context.Background()

	queries := billingCovNewQuerier()
	account := db.BillingAccount{ID: 9, OwnerType: BillingOwnerTypeUser, OwnerID: 44, StripeCustomerID: "cus_webhook", StripeCustomerEmail: "webhook@example.com", StripeCustomerName: "Webhook User"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	var gotSubscription db.UpsertBillingSubscriptionParams
	queries.upsertBillingAccountFn = func(_ context.Context, arg db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		updated := db.BillingAccount{
			ID:                  account.ID,
			OwnerType:           arg.OwnerType,
			OwnerID:             arg.OwnerID,
			StripeCustomerID:    arg.StripeCustomerID,
			StripeCustomerEmail: arg.StripeCustomerEmail,
			StripeCustomerName:  arg.StripeCustomerName,
		}
		queries.accountsByCustomer[arg.StripeCustomerID] = updated
		queries.accountsByOwner[queries.ownerKey(arg.OwnerType, arg.OwnerID)] = updated
		return updated, nil
	}
	queries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		gotSubscription = arg
		return db.BillingSubscription{ID: 1, BillingAccountID: arg.BillingAccountID, StripeSubscriptionID: arg.StripeSubscriptionID}, nil
	}
	client := &stripeBillingClientMock{
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			return StripeSubscriptionSnapshot{
				ID:       id,
				PriceID:  "price_personal_monthly",
				Interval: BillingIntervalMonthly,
				Status:   "active",
				Quantity: 1,
				Metadata: map[string]string{"owner_type": "user", "owner_id": "44", "plan_key": "personal", "interval": "monthly"},
			}, nil
		},
		getChargeFn: func(_ context.Context, id string) (StripeChargeSnapshot, error) {
			return StripeChargeSnapshot{ID: id, CustomerID: "cus_webhook", AmountRefunded: 333, Currency: "eur"}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		StripeWebhookSecret:    "whsec_test_secret",
		PersonalMonthlyPriceID: "price_personal_monthly",
	})

	err := NewBillingService(queries, nil, BillingServiceConfig{}).HandleStripeWebhook(ctx, []byte(`{}`), "")
	assert.Equal(t, 400, httpStatus(err))
	err = svc.HandleStripeWebhook(ctx, []byte(`{}`), "bad")
	assert.Equal(t, 400, httpStatus(err))
	assert.NoError(t, svc.handleStripeEvent(ctx, "evt_ignored", "unhandled.event", time.Time{}, json.RawMessage(`{}`)))
	assert.Equal(t, 400, httpStatus(svc.handleStripeEvent(ctx, "evt_bad_sub", "customer.subscription.updated", time.Time{}, json.RawMessage(`{`))))

	assert.NoError(t, svc.handleStripeEvent(ctx, "evt_unknown_checkout", "checkout.session.completed", time.Time{}, json.RawMessage(`{"customer":"cus_missing"}`)))
	err = svc.handleStripeEvent(ctx, "evt_checkout", "checkout.session.completed", time.Time{}, json.RawMessage(`{
		"id":"cs_1",
		"customer":"cus_webhook",
		"subscription":"sub_from_checkout",
		"customer_details":{"email":"new@example.com","name":"New Name"}
	}`))
	require.NoError(t, err)
	assert.Equal(t, account.ID, gotSubscription.BillingAccountID)
	assert.Equal(t, "sub_from_checkout", gotSubscription.StripeSubscriptionID)
	assert.Equal(t, BillingPlanPersonal, gotSubscription.PlanKey)

	err = svc.handleStripeEvent(ctx, "evt_entitlements", "entitlements.active_entitlement_summary.updated", time.Time{}, json.RawMessage(`{
		"customer":"cus_webhook",
		"active_entitlements":[
			{"lookup_key":"beta"},
			{"lookup_key":" beta "},
			{"lookup_key":"","feature":{"lookup_key":"priority"}},
			{"lookup_key":"","feature":{"lookup_key":""}}
		]
	}`))
	require.NoError(t, err)
	assert.Equal(t, []int64{account.ID}, queries.deactivatedAccounts)
	require.Len(t, queries.entitlementUpserts, 2)
	assert.Equal(t, []string{"beta", "priority"}, []string{queries.entitlementUpserts[0].FeatureKey, queries.entitlementUpserts[1].FeatureKey})

	err = svc.handleStripeEvent(ctx, "evt_refund_refresh", "charge.refunded", time.Time{}, json.RawMessage(`{"id":"ch_needs_refresh"}`))
	require.NoError(t, err)
	require.Len(t, queries.creditEntries, 1)
	assert.Contains(t, queries.creditEntries[0].Reason, "3.33 EUR")

	badQueries := billingCovNewQuerier()
	badQueries.accountsByCustomer[account.StripeCustomerID] = account
	badQueries.upsertBillingSubscriptionFn = func(context.Context, db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		return db.BillingSubscription{}, errors.New("db offline")
	}
	badSvc := NewBillingService(badQueries, nil, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret", PersonalMonthlyPriceID: "price_personal_monthly"})
	payload, signature := signedStripeEvent(t, "evt_rollback", "customer.subscription.updated", map[string]any{
		"id":       "sub_bad",
		"customer": "cus_webhook",
		"status":   "active",
		"items": map[string]any{"data": []map[string]any{{"quantity": 1, "price": map[string]any{
			"id": "price_personal_monthly", "recurring": map[string]any{"interval": "month"},
		}}}},
	})
	err = badSvc.HandleStripeWebhook(ctx, payload, signature)
	require.Error(t, err)
	_, replayBlocked := badQueries.processedEvents["evt_rollback"]
	assert.False(t, replayBlocked, "a failed webhook must delete the processed-event claim so Stripe can retry")
}

func TestBilling_Cov_PlanHelpersCheckoutAndFormatting(t *testing.T) {
	ctx := context.Background()

	svc := NewBillingService(newBillingQuerierMock(), nil, BillingServiceConfig{
		BaseURL:                "https://smithers.test",
		PersonalMonthlyPriceID: "price_personal_monthly",
	})
	svc.registerPlan(billingPlanDefinition{AllowedOwner: "lab", Key: "research", Interval: BillingIntervalAnnual, PriceID: " price_research "})
	assert.Equal(t, "research", svc.priceCatalog[" price_research "].Key)
	assert.Equal(t, " price_research ", svc.checkoutPlans["lab"]["research:annual"].PriceID)
	svc.registerPlan(billingPlanDefinition{AllowedOwner: "lab", Key: "", Interval: BillingIntervalMonthly, PriceID: "price_incomplete"})
	assert.NotContains(t, svc.checkoutPlans["lab"], ":monthly")

	assert.Equal(t, 0, pairingPlanRank(" free "))
	assert.Equal(t, 5, pairingPlanRank("custom"))
	assert.Equal(t, "custom", svc.planFromPrice(BillingOwnerTypeOrg, "missing", "year").Key)
	assert.Equal(t, BillingIntervalAnnual, svc.planFromPrice(BillingOwnerTypeOrg, "missing", "year").Interval)
	assert.Equal(t, BillingPlanFree, svc.defaultPlan("unknown").Key)
	assert.Equal(t, unlimitedBillingQuantity, svc.defaultPlan("unknown").Limits.AgentRuns)

	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, 42)] = db.BillingAccount{ID: 1, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_existing"}
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{Status: "active", PlanKey: BillingPlanPersonal}, nil
	}
	client := &stripeBillingClientMock{
		createCustomerFn: func(context.Context, StripeCreateCustomerInput) (string, error) {
			t.Fatal("active subscribers must not create a new customer")
			return "", nil
		},
		createCheckoutFn: func(context.Context, StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			t.Fatal("active subscribers must not create checkout")
			return StripeCheckoutSessionResult{}, nil
		},
	}
	activeSvc := NewBillingService(queries, client, BillingServiceConfig{PersonalMonthlyPriceID: "price_personal_monthly"})
	_, err := activeSvc.CreateUserCheckout(ctx, &db.User{ID: 42, Username: "alice"}, "", "")
	assert.Equal(t, 400, httpStatus(err))

	_, ok := ownerFromMetadata(map[string]string{"owner_type": "team", "owner_id": "1"})
	assert.False(t, ok)
	owner, ok := ownerFromMetadata(map[string]string{"owner_type": "org", "owner_id": "77"})
	require.True(t, ok)
	assert.Equal(t, int64(77), owner.OwnerID)
	assert.Equal(t, "Acme", billingOwnerDisplayName(db.BillingAccount{StripeCustomerName: " Acme "}))
	assert.Equal(t, "org:77", billingOwnerDisplayName(db.BillingAccount{OwnerType: "org", OwnerID: 77}))
	assert.Equal(t, "fallback", nonEmpty(" ", " fallback "))
	assert.Equal(t, "-12.34 USD", formatMoneyCents(-1234, ""))
	assert.Equal(t, "1-day", formatDurationDays(24*time.Hour))
	assert.Equal(t, "2-day", formatDurationDays(48*time.Hour))
	assert.Nil(t, nullableTime(pgtype.Timestamptz{}))
	require.NotNil(t, nullableTime(pgtype.Timestamptz{Time: time.Unix(1, 0).UTC(), Valid: true}))
	assert.Equal(t, int64(0), overageQuantity(10, unlimitedBillingQuantity))
	assert.NoError(t, svc.enforceMetricLimit(10, BillingUsageSummary{ConsumedQuantity: 9}, "widgets"))
	assert.Equal(t, 403, httpStatus(svc.enforceMetricLimit(10, BillingUsageSummary{ConsumedQuantity: 10}, "widgets")))
}
