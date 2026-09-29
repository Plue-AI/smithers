package services

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type billingQuerierMock struct {
	paymentReversals          []int64
	countActiveSandboxesFn    func(context.Context, int64) (int, error)
	countOtherSandboxResumeFn func(context.Context, db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error)
	countActiveAgentsFn       func(context.Context, int64) (int64, error)
	sumSandboxSecondsFn       func(context.Context, int64, time.Time) (int64, error)
	accountsByOwner           map[string]db.BillingAccount
	accountsByCustomer        map[string]db.BillingAccount
	processedEvents           map[string]string
	creditLedger              map[string]db.BillingCreditLedger
	creditEntries             []db.BillingCreditLedger
	usage                     map[string]db.BillingUsageCounter
	nextUsageID               int64
	nextLedgerID              int64
	usageUpsertCalls          int

	getBillingAccountByOwnerFn          func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error)
	getBillingAccountByStripeCustomerFn func(context.Context, string) (db.BillingAccount, error)
	upsertBillingAccountFn              func(context.Context, db.UpsertBillingAccountParams) (db.BillingAccount, error)
	upsertBillingSubscriptionFn         func(context.Context, db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error)
	listBillingSubscriptionsByAccountFn func(context.Context, int64) ([]db.BillingSubscription, error)
	claimStripeProcessedEventFn         func(context.Context, db.ClaimStripeProcessedEventParams) (string, error)
	countPrivateReposByOwnerFn          func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error)
	sumStorageBytesByOwnerFn            func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error)
	sumStorageBytesByRepositoryFn       func(context.Context, int64) (int64, error)
	sumWorkflowMinutesByOwnerFn         func(context.Context, db.SumWorkflowMinutesByOwnerParams) (int64, error)
	countAgentRunsByOwnerFn             func(context.Context, db.CountAgentRunsByOwnerParams) (int64, error)
	countAgentRunAdmissionsByOwnerFn    func(context.Context, db.CountAgentRunAdmissionsByOwnerParams) (int64, error)
	countOrgMembersFn                   func(context.Context, int64) (int64, error)
	getLatestSubscriptionFn             func(context.Context, int64) (db.BillingSubscription, error)
	getLatestLiveSubscriptionFn         func(context.Context, int64) (db.BillingSubscription, error)
}

func newBillingQuerierMock() *billingQuerierMock {
	return &billingQuerierMock{
		accountsByOwner:    map[string]db.BillingAccount{},
		accountsByCustomer: map[string]db.BillingAccount{},
		processedEvents:    map[string]string{},
		creditLedger:       map[string]db.BillingCreditLedger{},
		usage:              map[string]db.BillingUsageCounter{},
		nextUsageID:        1,
		nextLedgerID:       1,
	}
}

func (m *billingQuerierMock) ownerKey(ownerType string, ownerID int64) string {
	return fmt.Sprintf("%s:%d", ownerType, ownerID)
}

func (m *billingQuerierMock) usageKey(ownerType string, ownerID int64, metricKey string, periodStart, periodEnd time.Time) string {
	return fmt.Sprintf("%s:%d:%s:%s:%s", ownerType, ownerID, metricKey, periodStart.UTC().Format(time.RFC3339), periodEnd.UTC().Format(time.RFC3339))
}

func (m *billingQuerierMock) GetUserByID(context.Context, int64) (db.User, error) {
	return db.User{}, nil
}

func (m *billingQuerierMock) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return db.Organization{}, nil
}

func (m *billingQuerierMock) GetOrgByLowerName(_ context.Context, lowerName string) (db.Organization, error) {
	return db.Organization{ID: 7, Name: lowerName, LowerName: lowerName}, nil
}

func (m *billingQuerierMock) GetOrgMember(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
	return db.OrgMember{Role: "owner"}, nil
}

func (m *billingQuerierMock) CountOrgMembers(ctx context.Context, orgID int64) (int64, error) {
	if m.countOrgMembersFn != nil {
		return m.countOrgMembersFn(ctx, orgID)
	}
	return 1, nil
}

func (m *billingQuerierMock) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	return db.Repository{ID: id, UserID: pgtype.Int8{Int64: 42, Valid: true}}, nil
}

func (m *billingQuerierMock) GetBillingAccountByOwner(ctx context.Context, arg db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
	if m.getBillingAccountByOwnerFn != nil {
		return m.getBillingAccountByOwnerFn(ctx, arg)
	}
	account, ok := m.accountsByOwner[m.ownerKey(arg.OwnerType, arg.OwnerID)]
	if !ok {
		return db.BillingAccount{}, pgx.ErrNoRows
	}
	return account, nil
}

func (m *billingQuerierMock) GetBillingAccountByStripeCustomerID(ctx context.Context, stripeCustomerID string) (db.BillingAccount, error) {
	if m.getBillingAccountByStripeCustomerFn != nil {
		return m.getBillingAccountByStripeCustomerFn(ctx, stripeCustomerID)
	}
	account, ok := m.accountsByCustomer[stripeCustomerID]
	if !ok {
		return db.BillingAccount{}, pgx.ErrNoRows
	}
	return account, nil
}

func (m *billingQuerierMock) UpsertBillingAccount(ctx context.Context, arg db.UpsertBillingAccountParams) (db.BillingAccount, error) {
	if m.upsertBillingAccountFn != nil {
		return m.upsertBillingAccountFn(ctx, arg)
	}
	account := db.BillingAccount{
		ID:                  1,
		OwnerType:           arg.OwnerType,
		OwnerID:             arg.OwnerID,
		StripeCustomerID:    arg.StripeCustomerID,
		StripeCustomerEmail: arg.StripeCustomerEmail,
		StripeCustomerName:  arg.StripeCustomerName,
		CreatedAt:           time.Now().UTC(),
		UpdatedAt:           time.Now().UTC(),
	}
	m.accountsByOwner[m.ownerKey(arg.OwnerType, arg.OwnerID)] = account
	m.accountsByCustomer[arg.StripeCustomerID] = account
	return account, nil
}

func (m *billingQuerierMock) GetLatestBillingSubscriptionByAccount(ctx context.Context, accountID int64) (db.BillingSubscription, error) {
	if m.getLatestSubscriptionFn != nil {
		return m.getLatestSubscriptionFn(ctx, accountID)
	}
	return db.BillingSubscription{}, pgx.ErrNoRows
}

func (m *billingQuerierMock) GetLatestLiveBillingSubscriptionByAccount(ctx context.Context, accountID int64) (db.BillingSubscription, error) {
	if m.getLatestLiveSubscriptionFn != nil {
		return m.getLatestLiveSubscriptionFn(ctx, accountID)
	}
	if m.getLatestSubscriptionFn != nil {
		row, err := m.getLatestSubscriptionFn(ctx, accountID)
		if err != nil {
			return row, err
		}
		if paidSubscriptionStatus(row.Status) {
			return row, nil
		}
	}
	return db.BillingSubscription{}, pgx.ErrNoRows
}

func (m *billingQuerierMock) ListBillingSubscriptionsByAccount(ctx context.Context, accountID int64) ([]db.BillingSubscription, error) {
	if m.listBillingSubscriptionsByAccountFn != nil {
		return m.listBillingSubscriptionsByAccountFn(ctx, accountID)
	}
	return nil, nil
}

func (m *billingQuerierMock) UpsertBillingSubscription(ctx context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
	if m.upsertBillingSubscriptionFn != nil {
		return m.upsertBillingSubscriptionFn(ctx, arg)
	}
	return db.BillingSubscription{
		ID:                   1,
		BillingAccountID:     arg.BillingAccountID,
		StripeSubscriptionID: arg.StripeSubscriptionID,
		StripePriceID:        arg.StripePriceID,
		PlanKey:              arg.PlanKey,
		BillingInterval:      arg.BillingInterval,
		Status:               arg.Status,
		Quantity:             arg.Quantity,
		TrialEnd:             arg.TrialEnd,
		CurrentPeriodStart:   arg.CurrentPeriodStart,
		CurrentPeriodEnd:     arg.CurrentPeriodEnd,
		CancelAtPeriodEnd:    arg.CancelAtPeriodEnd,
		CanceledAt:           arg.CanceledAt,
		RawPayload:           arg.RawPayload,
		CreatedAt:            time.Now().UTC(),
		UpdatedAt:            time.Now().UTC(),
	}, nil
}

func (m *billingQuerierMock) BillingSnapshotClock(context.Context) (time.Time, error) {
	return time.Now().UTC(), nil
}

func (m *billingQuerierMock) MarkBillingSubscriptionsPaymentReversed(_ context.Context, arg db.MarkBillingSubscriptionsPaymentReversedParams) (int64, error) {
	m.paymentReversals = append(m.paymentReversals, arg.BillingAccountID)
	return 1, nil
}

func (m *billingQuerierMock) RecordBillingAccountPaymentReversal(context.Context, db.RecordBillingAccountPaymentReversalParams) error {
	return nil
}

func (m *billingQuerierMock) SettleBillingSubscriptionPayment(ctx context.Context, arg db.SettleBillingSubscriptionPaymentParams) (db.BillingSubscription, error) {
	rows, err := m.ListBillingSubscriptionsByAccount(ctx, arg.BillingAccountID)
	if err != nil {
		return db.BillingSubscription{}, err
	}
	for _, row := range rows {
		if row.StripeSubscriptionID == arg.StripeSubscriptionID {
			row.PaymentSettledAt = arg.SettledAt
			if row.PaymentReversedAt.Valid && row.PaymentReversedAt.Time.Before(arg.SettledAt.Time) {
				row.PaymentReversedAt = pgtype.Timestamptz{}
			}
			return row, nil
		}
	}
	return db.BillingSubscription{}, pgx.ErrNoRows
}

func (m *billingQuerierMock) DeactivateBillingEntitlementsByAccount(context.Context, int64) error {
	return nil
}

func (m *billingQuerierMock) UpsertBillingEntitlement(_ context.Context, arg db.UpsertBillingEntitlementParams) (db.BillingEntitlement, error) {
	return db.BillingEntitlement{
		ID:               1,
		BillingAccountID: arg.BillingAccountID,
		FeatureKey:       arg.FeatureKey,
		Active:           arg.Active,
		LastSyncedAt:     arg.LastSyncedAt,
		CreatedAt:        time.Now().UTC(),
		UpdatedAt:        time.Now().UTC(),
	}, nil
}

func (m *billingQuerierMock) ListBillingEntitlementsByAccount(context.Context, int64) ([]db.BillingEntitlement, error) {
	return nil, nil
}

func (m *billingQuerierMock) UpsertBillingUsageCounter(_ context.Context, arg db.UpsertBillingUsageCounterParams) (db.BillingUsageCounter, error) {
	m.usageUpsertCalls++
	key := m.usageKey(arg.OwnerType, arg.OwnerID, arg.MetricKey, arg.PeriodStart, arg.PeriodEnd)
	counter := db.BillingUsageCounter{
		ID:                       m.nextUsageID,
		OwnerType:                arg.OwnerType,
		OwnerID:                  arg.OwnerID,
		MetricKey:                arg.MetricKey,
		PeriodStart:              arg.PeriodStart,
		PeriodEnd:                arg.PeriodEnd,
		IncludedQuantity:         arg.IncludedQuantity,
		ConsumedQuantity:         arg.ConsumedQuantity,
		OverageQuantity:          arg.OverageQuantity,
		LastReportedMeterEventID: arg.LastReportedMeterEventID,
		LastSyncedAt:             arg.LastSyncedAt,
		CreatedAt:                time.Now().UTC(),
		UpdatedAt:                time.Now().UTC(),
	}
	m.nextUsageID++
	m.usage[key] = counter
	return counter, nil
}

func (m *billingQuerierMock) ListBillingUsageCountersByOwnerAndPeriod(_ context.Context, arg db.ListBillingUsageCountersByOwnerAndPeriodParams) ([]db.BillingUsageCounter, error) {
	var out []db.BillingUsageCounter
	for _, row := range m.usage {
		if row.OwnerType == arg.OwnerType && row.OwnerID == arg.OwnerID && row.PeriodStart.Equal(arg.PeriodStart) && row.PeriodEnd.Equal(arg.PeriodEnd) {
			out = append(out, row)
		}
	}
	return out, nil
}

func (m *billingQuerierMock) CountPrivateReposByOwner(ctx context.Context, arg db.CountPrivateReposByOwnerParams) (int64, error) {
	if m.countPrivateReposByOwnerFn != nil {
		return m.countPrivateReposByOwnerFn(ctx, arg)
	}
	return 0, nil
}

func (m *billingQuerierMock) SumStorageBytesByOwner(ctx context.Context, arg db.SumStorageBytesByOwnerParams) (int64, error) {
	if m.sumStorageBytesByOwnerFn != nil {
		return m.sumStorageBytesByOwnerFn(ctx, arg)
	}
	return 0, nil
}

func (m *billingQuerierMock) SumStorageBytesByRepository(ctx context.Context, repositoryID int64) (int64, error) {
	if m.sumStorageBytesByRepositoryFn != nil {
		return m.sumStorageBytesByRepositoryFn(ctx, repositoryID)
	}
	return 0, nil
}

func (m *billingQuerierMock) SumWorkflowMinutesByOwner(ctx context.Context, arg db.SumWorkflowMinutesByOwnerParams) (int64, error) {
	if m.sumWorkflowMinutesByOwnerFn != nil {
		return m.sumWorkflowMinutesByOwnerFn(ctx, arg)
	}
	return 0, nil
}

func (m *billingQuerierMock) CountAgentRunsByOwner(ctx context.Context, arg db.CountAgentRunsByOwnerParams) (int64, error) {
	if m.countAgentRunsByOwnerFn != nil {
		return m.countAgentRunsByOwnerFn(ctx, arg)
	}
	return 0, nil
}

func (m *billingQuerierMock) CountAgentRunAdmissionsByOwner(ctx context.Context, arg db.CountAgentRunAdmissionsByOwnerParams) (int64, error) {
	if m.countAgentRunAdmissionsByOwnerFn != nil {
		return m.countAgentRunAdmissionsByOwnerFn(ctx, arg)
	}
	return 0, nil
}

func (m *billingQuerierMock) ClaimStripeProcessedEvent(ctx context.Context, arg db.ClaimStripeProcessedEventParams) (string, error) {
	if m.claimStripeProcessedEventFn != nil {
		return m.claimStripeProcessedEventFn(ctx, arg)
	}
	if _, ok := m.processedEvents[arg.EventID]; ok {
		return "", pgx.ErrNoRows
	}
	m.processedEvents[arg.EventID] = arg.EventType
	return arg.EventID, nil
}

func (m *billingQuerierMock) DeleteStripeProcessedEvent(_ context.Context, eventID string) error {
	delete(m.processedEvents, eventID)
	return nil
}

func (m *billingQuerierMock) InsertCreditLedgerEntry(_ context.Context, arg db.InsertCreditLedgerEntryParams) (db.BillingCreditLedger, error) {
	row := db.BillingCreditLedger{
		ID:                m.nextLedgerID,
		BillingAccountID:  arg.BillingAccountID,
		AmountCents:       arg.AmountCents,
		BalanceAfterCents: arg.BalanceAfterCents,
		Reason:            arg.Reason,
		Category:          arg.Category,
		MetricKey:         arg.MetricKey,
		IdempotencyKey:    arg.IdempotencyKey,
		CreatedAt:         time.Now().UTC(),
	}
	m.nextLedgerID++
	m.creditEntries = append(m.creditEntries, row)
	m.creditLedger[m.creditKey(arg.BillingAccountID, arg.IdempotencyKey)] = row
	return row, nil
}

func (m *billingQuerierMock) GetCreditLedgerByIdempotencyKey(_ context.Context, arg db.GetCreditLedgerByIdempotencyKeyParams) (db.BillingCreditLedger, error) {
	row, ok := m.creditLedger[m.creditKey(arg.BillingAccountID, arg.IdempotencyKey)]
	if !ok {
		return db.BillingCreditLedger{}, pgx.ErrNoRows
	}
	return row, nil
}

func (m *billingQuerierMock) creditKey(accountID int64, key string) string {
	return fmt.Sprintf("%d:%s", accountID, key)
}

type stripeBillingClientMock struct {
	createCustomerFn   func(context.Context, StripeCreateCustomerInput) (string, error)
	createCheckoutFn   func(context.Context, StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error)
	createPortalFn     func(context.Context, StripeCreatePortalSessionInput) (string, error)
	getSubscriptionFn  func(context.Context, string) (StripeSubscriptionSnapshot, error)
	getChargeFn        func(context.Context, string) (StripeChargeSnapshot, error)
	listEntitlementsFn func(context.Context, string) ([]string, error)

	latestCheckoutSession StripeCheckoutSessionSnapshot
	latestCheckoutFound   bool
	latestCheckoutErr     error
	latestCheckoutCalls   int
	expiredSessions       []string
	canceledSubscriptions []string
	cancelSubscriptionErr error

	updatedSeatQuantities         map[string]int64
	updateSubscriptionQuantityErr error
}

func (m *stripeBillingClientMock) CreateCustomer(ctx context.Context, input StripeCreateCustomerInput) (string, error) {
	return m.createCustomerFn(ctx, input)
}

func (m *stripeBillingClientMock) CreateCheckoutSession(ctx context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
	return m.createCheckoutFn(ctx, input)
}

func (m *stripeBillingClientMock) CreatePortalSession(ctx context.Context, input StripeCreatePortalSessionInput) (string, error) {
	if m.createPortalFn == nil {
		return "", nil
	}
	return m.createPortalFn(ctx, input)
}

func (m *stripeBillingClientMock) GetSubscription(ctx context.Context, subscriptionID string) (StripeSubscriptionSnapshot, error) {
	if m.getSubscriptionFn == nil {
		return StripeSubscriptionSnapshot{}, nil
	}
	return m.getSubscriptionFn(ctx, subscriptionID)
}

func (m *stripeBillingClientMock) GetCharge(ctx context.Context, chargeID string) (StripeChargeSnapshot, error) {
	if m.getChargeFn == nil {
		return StripeChargeSnapshot{}, nil
	}
	return m.getChargeFn(ctx, chargeID)
}

func (m *stripeBillingClientMock) ListActiveEntitlements(ctx context.Context, customerID string) ([]string, error) {
	if m.listEntitlementsFn == nil {
		return nil, nil
	}
	return m.listEntitlementsFn(ctx, customerID)
}

func (m *stripeBillingClientMock) CancelSubscription(_ context.Context, subscriptionID string) error {
	if m.cancelSubscriptionErr != nil {
		return m.cancelSubscriptionErr
	}
	m.canceledSubscriptions = append(m.canceledSubscriptions, subscriptionID)
	return nil
}

func (m *stripeBillingClientMock) UpdateSubscriptionQuantity(_ context.Context, subscriptionID string, quantity int64) error {
	if m.updateSubscriptionQuantityErr != nil {
		return m.updateSubscriptionQuantityErr
	}
	if m.updatedSeatQuantities == nil {
		m.updatedSeatQuantities = map[string]int64{}
	}
	m.updatedSeatQuantities[subscriptionID] = quantity
	return nil
}

func (m *stripeBillingClientMock) GetLatestCheckoutSession(_ context.Context, _ string) (StripeCheckoutSessionSnapshot, bool, error) {
	m.latestCheckoutCalls++
	if m.latestCheckoutErr != nil {
		return StripeCheckoutSessionSnapshot{}, false, m.latestCheckoutErr
	}
	return m.latestCheckoutSession, m.latestCheckoutFound, nil
}

func (m *stripeBillingClientMock) ExpireCheckoutSession(_ context.Context, sessionID string) error {
	m.expiredSessions = append(m.expiredSessions, sessionID)
	return nil
}

type mockBillingEmailSender struct {
	calls []billingEmailCall
}

type billingEmailCall struct {
	ToEmail string
	Subject string
	Body    string
}

func (m *mockBillingEmailSender) SendBillingNotification(_ context.Context, toEmail string, subject string, body string) {
	m.calls = append(m.calls, billingEmailCall{ToEmail: toEmail, Subject: subject, Body: body})
}

func signedStripeEvent(t *testing.T, eventID string, eventType string, object map[string]any) ([]byte, string) {
	t.Helper()
	eventPayload := map[string]any{
		"id":          eventID,
		"object":      "event",
		"api_version": "2025-06-30.basil",
		"type":        eventType,
		"data": map[string]any{
			"object": object,
		},
	}
	raw, err := json.Marshal(eventPayload)
	require.NoError(t, err)
	return signedStripePayload(raw), stripeTestHeader(raw)
}

func stripeTestHeader(payload []byte) string {
	timestamp := "1700000000"
	mac := hmac.New(sha256.New, []byte("whsec_test_secret"))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(payload)
	return "t=" + timestamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func signedStripePayload(payload []byte) []byte { return payload }

func TestBillingService_CreateUserCheckout_CreatesCustomerAndCheckout(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	var gotCustomer StripeCreateCustomerInput
	var gotCheckout StripeCreateCheckoutSessionInput
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, input StripeCreateCustomerInput) (string, error) {
			gotCustomer = input
			return "cus_test_123", nil
		},
		createCheckoutFn: func(_ context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			gotCheckout = input
			return StripeCheckoutSessionResult{ID: "cs_test_123", URL: "https://checkout.stripe.test/session"}, nil
		},
	}

	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:           "https://smithers.test",
		ProMonthlyPriceID: "price_pro_monthly",
	})

	user := &db.User{
		ID:          42,
		Username:    "alice",
		DisplayName: "Alice",
		Email:       pgtype.Text{String: "alice@example.com", Valid: true},
	}
	// An empty plan is Pro, the sold user plan (plue 18fce33c3).
	result, err := svc.CreateUserCheckout(context.Background(), user, "", "")
	require.NoError(t, err)
	assert.Equal(t, "https://checkout.stripe.test/session", result.URL)
	assert.Equal(t, "alice@example.com", gotCustomer.Email)
	assert.Equal(t, "Alice", gotCustomer.Name)
	assert.Equal(t, "user", gotCustomer.Metadata["owner_type"])
	assert.Equal(t, "42", gotCustomer.Metadata["owner_id"])
	assert.Equal(t, "cus_test_123", gotCheckout.CustomerID)
	assert.Equal(t, "price_pro_monthly", gotCheckout.PriceID)
	assert.Equal(t, int64(1), gotCheckout.Quantity)
	assert.Equal(t, "pro", gotCheckout.Metadata["plan_key"])
	assert.Equal(t, "monthly", gotCheckout.Metadata["interval"])
	// Checkout states the renewal terms beside the required Terms checkbox.
	assert.Contains(t, gotCheckout.TermsOfServiceAcceptance, "renews automatically every month")
	assert.Contains(t, gotCheckout.TermsOfServiceAcceptance, "(https://smithers.sh/terms)")
}

func TestBillingService_CreateUserCheckout_ExpiresMismatchedOpenSession(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	var gotCheckout StripeCreateCheckoutSessionInput
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_test_123", nil
		},
		createCheckoutFn: func(_ context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			gotCheckout = input
			return StripeCheckoutSessionResult{ID: "cs_new", URL: "https://checkout.stripe.test/new"}, nil
		},
		latestCheckoutFound: true,
		latestCheckoutSession: StripeCheckoutSessionSnapshot{
			ID:     "cs_stale",
			URL:    "https://checkout.stripe.test/stale",
			Status: "open",
			Metadata: map[string]string{
				"owner_type":        BillingOwnerTypeUser,
				"owner_id":          "42",
				"plan_key":          BillingPlanPersonal,
				"interval":          BillingIntervalMonthly,
				"checkout_quantity": "1",
			},
		},
	}

	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:           "https://smithers.test",
		ProMonthlyPriceID: "price_pro_monthly",
	})

	user := &db.User{ID: 42, Username: "alice", Email: pgtype.Text{String: "alice@example.com", Valid: true}}
	result, err := svc.CreateUserCheckout(context.Background(), user, "", "")
	require.NoError(t, err)
	assert.Equal(t, "https://checkout.stripe.test/new", result.URL)
	assert.Equal(t, []string{"cs_stale"}, client.expiredSessions)
	assert.Equal(t, "cs_stale", gotCheckout.CheckoutGeneration)
}

func TestBillingService_CreateUserCheckout_ReusesMatchingOpenSession(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_test_123", nil
		},
		createCheckoutFn: func(context.Context, StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			t.Fatal("a matching open checkout session must be reused")
			return StripeCheckoutSessionResult{}, nil
		},
		latestCheckoutFound: true,
		latestCheckoutSession: StripeCheckoutSessionSnapshot{
			ID:     "cs_open",
			URL:    "https://checkout.stripe.test/open",
			Status: "open",
			Metadata: map[string]string{
				"owner_type":        BillingOwnerTypeUser,
				"owner_id":          "42",
				"plan_key":          BillingPlanPro,
				"interval":          BillingIntervalMonthly,
				"checkout_quantity": "1",
			},
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:           "https://smithers.test",
		ProMonthlyPriceID: "price_pro_monthly",
	})

	result, err := svc.CreateUserCheckout(context.Background(), &db.User{ID: 42, Username: "alice"}, "", "")
	require.NoError(t, err)
	assert.Equal(t, "https://checkout.stripe.test/open", result.URL)
	assert.Empty(t, client.expiredSessions)
}

func TestBillingService_CreateUserCheckout_CompletedSessionWaitsForProjection(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_test_123", nil
		},
		createCheckoutFn: func(context.Context, StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			t.Fatal("a completed, unprojected checkout may already have charged the customer")
			return StripeCheckoutSessionResult{}, nil
		},
		latestCheckoutFound: true,
		latestCheckoutSession: StripeCheckoutSessionSnapshot{
			ID:             "cs_complete",
			Status:         "complete",
			SubscriptionID: "sub_pending",
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:           "https://smithers.test",
		ProMonthlyPriceID: "price_pro_monthly",
	})

	_, err := svc.CreateUserCheckout(context.Background(), &db.User{ID: 42, Username: "alice"}, "", "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already complete")
}

func TestBillingService_CreateUserCheckout_CompletedLapsedSessionStartsNextGeneration(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	queries.listBillingSubscriptionsByAccountFn = func(context.Context, int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_lapsed", Status: "canceled"}}, nil
	}
	var gotCheckout StripeCreateCheckoutSessionInput
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) {
			return "cus_test_123", nil
		},
		createCheckoutFn: func(_ context.Context, input StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			gotCheckout = input
			return StripeCheckoutSessionResult{ID: "cs_next", URL: "https://checkout.stripe.test/next"}, nil
		},
		latestCheckoutFound: true,
		latestCheckoutSession: StripeCheckoutSessionSnapshot{
			ID:             "cs_complete",
			Status:         "complete",
			SubscriptionID: "sub_lapsed",
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:           "https://smithers.test",
		ProMonthlyPriceID: "price_pro_monthly",
	})

	result, err := svc.CreateUserCheckout(context.Background(), &db.User{ID: 42, Username: "alice"}, "", "")
	require.NoError(t, err)
	assert.Equal(t, "https://checkout.stripe.test/next", result.URL)
	assert.Equal(t, "cs_complete", gotCheckout.CheckoutGeneration)
}

func TestBillingService_CreateUserCheckout_RefusesWhenLiveSubscriptionPrecedesCanceledRow(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, 42)] = db.BillingAccount{
		ID:               5,
		OwnerType:        BillingOwnerTypeUser,
		OwnerID:          42,
		StripeCustomerID: "cus_dup",
	}
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   2,
			StripeSubscriptionID: "sub_B",
			PlanKey:              BillingPlanPersonal,
			Status:               "canceled",
			BillingInterval:      BillingIntervalMonthly,
		}, nil
	}
	queries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   1,
			StripeSubscriptionID: "sub_A",
			PlanKey:              BillingPlanPersonal,
			Status:               "active",
			BillingInterval:      BillingIntervalMonthly,
		}, nil
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
	svc := NewBillingService(queries, client, BillingServiceConfig{
		BaseURL:           "https://smithers.test",
		ProMonthlyPriceID: "price_pro_monthly",
	})

	_, err := svc.CreateUserCheckout(context.Background(), &db.User{ID: 42, Username: "alice"}, "", "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "billing portal")
}

func TestBillingService_UpsertSubscription_CancelsDuplicatePaidSubscription(t *testing.T) {
	t.Parallel()

	account := db.BillingAccount{ID: 5, OwnerType: "user", OwnerID: 42, StripeCustomerID: "cus_dup"}
	queries := newBillingQuerierMock()
	queries.listBillingSubscriptionsByAccountFn = func(_ context.Context, _ int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_A", Status: "active"}}, nil
	}
	client := &stripeBillingClientMock{
		// Stripe confirms the competing sub_A is genuinely still live.
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			return StripeSubscriptionSnapshot{ID: id, Status: "active"}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{BaseURL: "https://smithers.test"})

	// A second paid subscription (sub_B) created by OUR checkout flow (carries
	// all four metadata keys) must be canceled, keeping the pre-existing sub_A.
	snapshot := StripeSubscriptionSnapshot{
		ID:     "sub_B",
		Status: "active",
		Metadata: map[string]string{
			"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly",
		},
	}
	require.NoError(t, svc.upsertSubscriptionSnapshot(context.Background(), account, observedSubscription{StripeSubscriptionSnapshot: snapshot}))
	assert.Equal(t, []string{"sub_B"}, client.canceledSubscriptions, "the duplicate (newer) subscription must be canceled")
}

func TestBillingService_UpsertSubscription_DoesNotCancelWhenCompetingRowStaleInStripe(t *testing.T) {
	t.Parallel()

	account := db.BillingAccount{ID: 5, OwnerType: "user", OwnerID: 42, StripeCustomerID: "cus_dup"}
	queries := newBillingQuerierMock()
	// DB shows sub_A active, but a cancellation webhook was missed — Stripe says
	// it is canceled. The incoming sub_B is a legitimate NEW purchase and must
	// NOT be auto-canceled (it has already been charged).
	queries.listBillingSubscriptionsByAccountFn = func(_ context.Context, _ int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_A", Status: "active"}}, nil
	}
	client := &stripeBillingClientMock{
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			return StripeSubscriptionSnapshot{ID: id, Status: "canceled"}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{BaseURL: "https://smithers.test"})

	snapshot := StripeSubscriptionSnapshot{
		ID:     "sub_B",
		Status: "active",
		Metadata: map[string]string{
			"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly",
		},
	}
	require.NoError(t, svc.upsertSubscriptionSnapshot(context.Background(), account, observedSubscription{StripeSubscriptionSnapshot: snapshot}))
	assert.Empty(t, client.canceledSubscriptions, "must not cancel a legit purchase when the competing row is stale in Stripe")
}

func TestBillingService_UpsertSubscription_CancelsDuplicateAfterStaleCompetitor(t *testing.T) {
	t.Parallel()

	account := db.BillingAccount{ID: 5, OwnerType: "user", OwnerID: 42, StripeCustomerID: "cus_dup"}
	queries := newBillingQuerierMock()
	queries.listBillingSubscriptionsByAccountFn = func(_ context.Context, _ int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{
			{StripeSubscriptionID: "sub_stale", Status: "active"},
			{StripeSubscriptionID: "sub_live", Status: "active"},
		}, nil
	}
	var verified []string
	client := &stripeBillingClientMock{
		getSubscriptionFn: func(_ context.Context, id string) (StripeSubscriptionSnapshot, error) {
			verified = append(verified, id)
			if id == "sub_stale" {
				return StripeSubscriptionSnapshot{ID: id, Status: "canceled"}, nil
			}
			return StripeSubscriptionSnapshot{ID: id, Status: "active"}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{BaseURL: "https://smithers.test"})

	snapshot := StripeSubscriptionSnapshot{
		ID:     "sub_new",
		Status: "active",
		Metadata: map[string]string{
			"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly",
		},
	}
	require.NoError(t, svc.upsertSubscriptionSnapshot(context.Background(), account, observedSubscription{StripeSubscriptionSnapshot: snapshot}))
	assert.Equal(t, []string{"sub_stale", "sub_live"}, verified)
	assert.Equal(t, []string{"sub_new"}, client.canceledSubscriptions)
}

func TestBillingService_UpsertSubscription_DoesNotCancelWithoutCheckoutMetadata(t *testing.T) {
	t.Parallel()

	account := db.BillingAccount{ID: 5, OwnerType: "user", OwnerID: 42, StripeCustomerID: "cus_dup"}
	queries := newBillingQuerierMock()
	queries.listBillingSubscriptionsByAccountFn = func(_ context.Context, _ int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_A", Status: "active"}}, nil
	}
	client := &stripeBillingClientMock{}
	svc := NewBillingService(queries, client, BillingServiceConfig{BaseURL: "https://smithers.test"})

	// A manually-created enterprise sub (no plan_key/interval) must never be
	// auto-canceled even if it collides with an existing paid row.
	snapshot := StripeSubscriptionSnapshot{ID: "sub_manual", Status: "active", Metadata: map[string]string{"owner_type": "user", "owner_id": "42"}}
	require.NoError(t, svc.upsertSubscriptionSnapshot(context.Background(), account, observedSubscription{StripeSubscriptionSnapshot: snapshot}))
	assert.Empty(t, client.canceledSubscriptions, "a non-checkout subscription must never be auto-canceled")
}

func TestBillingService_UpsertSubscription_SamePlanUpdateDoesNotCancel(t *testing.T) {
	t.Parallel()

	account := db.BillingAccount{ID: 5, OwnerType: "user", OwnerID: 42, StripeCustomerID: "cus_dup"}
	queries := newBillingQuerierMock()
	queries.listBillingSubscriptionsByAccountFn = func(_ context.Context, _ int64) ([]db.BillingSubscription, error) {
		return []db.BillingSubscription{{StripeSubscriptionID: "sub_A", Status: "active"}}, nil
	}
	client := &stripeBillingClientMock{}
	svc := NewBillingService(queries, client, BillingServiceConfig{BaseURL: "https://smithers.test"})

	// A portal plan change reuses the SAME subscription id, so it must not trip
	// the duplicate-cancel branch.
	snapshot := StripeSubscriptionSnapshot{
		ID:     "sub_A",
		Status: "active",
		Metadata: map[string]string{
			"owner_type": "user", "owner_id": "42", "plan_key": "personal", "interval": "monthly",
		},
	}
	require.NoError(t, svc.upsertSubscriptionSnapshot(context.Background(), account, observedSubscription{StripeSubscriptionSnapshot: snapshot}))
	assert.Empty(t, client.canceledSubscriptions, "an update to the same subscription id must not cancel anything")
}

func TestBillingService_CreateUserCheckout_LatestSessionErrorBlocksCheckout(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	checkoutCalls := 0
	client := &stripeBillingClientMock{
		createCustomerFn: func(_ context.Context, _ StripeCreateCustomerInput) (string, error) { return "cus_x", nil },
		createCheckoutFn: func(_ context.Context, _ StripeCreateCheckoutSessionInput) (StripeCheckoutSessionResult, error) {
			checkoutCalls++
			return StripeCheckoutSessionResult{}, nil
		},
		latestCheckoutErr: errors.New("stripe down"),
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{BaseURL: "https://smithers.test", ProMonthlyPriceID: "price_pro_monthly"})

	_, err := svc.CreateUserCheckout(context.Background(), &db.User{ID: 42, Username: "alice"}, "", "")
	require.ErrorContains(t, err, "failed to inspect stripe checkout sessions")
	assert.Equal(t, 1, client.latestCheckoutCalls, "Stripe session state must be inspected")
	assert.Zero(t, checkoutCalls, "checkout must not proceed when Stripe session state is unknown")
}

func TestAuthorizePairingPlanMatrix(t *testing.T) {
	t.Parallel()

	const userID int64 = 42

	cases := []struct {
		name    string
		planKey string
		status  string
		allow   bool
	}{
		// Hobby ('personal') and above across every live status => allow.
		{"personal_trialing", BillingPlanPersonal, "trialing", true},
		{"personal_active", BillingPlanPersonal, "active", true},
		{"personal_past_due", BillingPlanPersonal, "past_due", true},
		{"pro_active", BillingPlanPro, "active", true},
		{"team_trialing", BillingPlanTeam, "trialing", true},
		{"enterprise_active", BillingPlanEnterprise, "active", true},
		// Lapsed/dead statuses collapse to the free default plan => deny.
		{"personal_canceled", BillingPlanPersonal, "canceled", false},
		{"personal_unpaid", BillingPlanPersonal, "unpaid", false},
		{"personal_incomplete", BillingPlanPersonal, "incomplete", false},
		// Free plan (even while active) is below the pairing floor => deny.
		{"free_active", BillingPlanFree, "active", false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			queries := newBillingQuerierMock()
			queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, userID)] = db.BillingAccount{
				ID:        1,
				OwnerType: BillingOwnerTypeUser,
				OwnerID:   userID,
			}
			queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
				return db.BillingSubscription{
					ID:              1,
					PlanKey:         tc.planKey,
					Status:          tc.status,
					BillingInterval: BillingIntervalMonthly,
				}, nil
			}

			svc := NewBillingService(queries, nil, BillingServiceConfig{})
			err := svc.AuthorizePairing(context.Background(), userID)
			if tc.allow {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), "pairing requires a paid plan")
			}
		})
	}
}

// AuthorizePairing must resolve the plan WITHOUT recomputing/persisting usage
// counters: a transient usage-write failure must never deny a paid user, and
// the ~11 read queries + 5 upserts are pure waste on this hot path.
func TestAuthorizePairing_PaidUser_DoesNotTouchUsageCounters(t *testing.T) {
	t.Parallel()

	const userID int64 = 77

	for _, status := range []string{"active", "trialing"} {
		status := status
		t.Run(status, func(t *testing.T) {
			t.Parallel()

			queries := newBillingQuerierMock()
			queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, userID)] = db.BillingAccount{
				ID:        1,
				OwnerType: BillingOwnerTypeUser,
				OwnerID:   userID,
			}
			// Fail every usage-counting query outright: if AuthorizePairing touched
			// the usage path at all it would error, proving it must not.
			boom := errors.New("usage path must not be reached")
			queries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
				return 0, boom
			}
			queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
				return 0, boom
			}
			queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
				return db.BillingSubscription{
					ID:              1,
					PlanKey:         BillingPlanPersonal,
					Status:          status,
					BillingInterval: BillingIntervalMonthly,
				}, nil
			}

			svc := NewBillingService(queries, nil, BillingServiceConfig{})
			require.NoError(t, svc.AuthorizePairing(context.Background(), userID))
			assert.Zero(t, queries.usageUpsertCalls, "AuthorizePairing must not upsert usage counters")
		})
	}
}

func TestAuthorizePairing_UsesLiveSubscriptionWhenCanceledRowIsNewer(t *testing.T) {
	t.Parallel()

	const userID int64 = 77

	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, userID)] = db.BillingAccount{
		ID:        1,
		OwnerType: BillingOwnerTypeUser,
		OwnerID:   userID,
	}
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   2,
			StripeSubscriptionID: "sub_B",
			PlanKey:              BillingPlanPersonal,
			Status:               "canceled",
			BillingInterval:      BillingIntervalMonthly,
		}, nil
	}
	queries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   1,
			StripeSubscriptionID: "sub_A",
			PlanKey:              BillingPlanPersonal,
			Status:               "active",
			BillingInterval:      BillingIntervalMonthly,
		}, nil
	}

	svc := NewBillingService(queries, nil, BillingServiceConfig{})
	require.NoError(t, svc.AuthorizePairing(context.Background(), userID))
}

func TestBillingService_ResolveLocalState_UsesLiveSubscriptionWhenCanceledRowIsNewer(t *testing.T) {
	t.Parallel()

	const userID int64 = 77

	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, userID)] = db.BillingAccount{
		ID:        1,
		OwnerType: BillingOwnerTypeUser,
		OwnerID:   userID,
	}
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		t.Fatal("resolveLocalState must not use the latest canceled subscription for quota gates")
		return db.BillingSubscription{}, nil
	}
	queries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   1,
			StripeSubscriptionID: "sub_A",
			PlanKey:              BillingPlanPersonal,
			Status:               "active",
			BillingInterval:      BillingIntervalMonthly,
		}, nil
	}

	svc := NewBillingService(queries, nil, BillingServiceConfig{})
	plan, _, _, subscription, err := svc.resolveLocalState(context.Background(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: userID})
	require.NoError(t, err)
	assert.Equal(t, BillingPlanPersonal, plan.Key)
	require.NotNil(t, subscription)
	assert.Equal(t, "sub_A", subscription.StripeSubscriptionID)
}

func TestAuthorizePairing_NoSubscriptionDenies(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	svc := NewBillingService(queries, nil, BillingServiceConfig{})
	err := svc.AuthorizePairing(context.Background(), 99)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "pairing requires a paid plan")
}

func TestBillingService_AuthorizePrivateRepo_BlocksAtLimit(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	queries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) {
		return 100, nil
	}

	svc := NewBillingService(queries, nil, BillingServiceConfig{})
	err := svc.AuthorizePrivateRepo(context.Background(), BillingOwnerTypeUser, 99)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "private repositories quota exceeded")
}

func TestBillingService_HandleStripeWebhook_UpsertsSubscriptionProjection(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	var gotAccount db.UpsertBillingAccountParams
	var gotSubscription db.UpsertBillingSubscriptionParams
	queries.upsertBillingAccountFn = func(_ context.Context, arg db.UpsertBillingAccountParams) (db.BillingAccount, error) {
		gotAccount = arg
		return db.BillingAccount{
			ID:               7,
			OwnerType:        arg.OwnerType,
			OwnerID:          arg.OwnerID,
			StripeCustomerID: arg.StripeCustomerID,
		}, nil
	}
	queries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		gotSubscription = arg
		return db.BillingSubscription{}, nil
	}

	svc := NewBillingService(queries, nil, BillingServiceConfig{
		StripeWebhookSecret: "whsec_test_secret",
		TeamMonthlyPriceID:  "price_team_monthly",
	})

	eventPayload := map[string]any{
		"id":          "evt_test_123",
		"object":      "event",
		"api_version": "2025-06-30.basil",
		"type":        "customer.subscription.updated",
		"data": map[string]any{
			"object": map[string]any{
				"id":                   "sub_test_123",
				"customer":             "cus_test_123",
				"status":               "active",
				"cancel_at_period_end": false,
				"current_period_start": time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC).Unix(),
				"current_period_end":   time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC).Unix(),
				"metadata": map[string]any{
					"owner_type": "org",
					"owner_id":   "77",
				},
				"items": map[string]any{
					"data": []map[string]any{
						{
							"quantity": 12,
							"price": map[string]any{
								"id": "price_team_monthly",
								"recurring": map[string]any{
									"interval": "month",
								},
							},
						},
					},
				},
			},
		},
	}
	raw, err := json.Marshal(eventPayload)
	require.NoError(t, err)
	signed := signedStripePayload(raw)
	err = svc.HandleStripeWebhook(context.Background(), signed, stripeTestHeader(signed))
	require.NoError(t, err)
	assert.Equal(t, "org", gotAccount.OwnerType)
	assert.Equal(t, int64(77), gotAccount.OwnerID)
	assert.Equal(t, "cus_test_123", gotAccount.StripeCustomerID)
	assert.Equal(t, int64(7), gotSubscription.BillingAccountID)
	assert.Equal(t, "sub_test_123", gotSubscription.StripeSubscriptionID)
	assert.Equal(t, "price_team_monthly", gotSubscription.StripePriceID)
	assert.Equal(t, "team", gotSubscription.PlanKey)
	assert.Equal(t, "monthly", gotSubscription.BillingInterval)
	assert.Equal(t, "active", gotSubscription.Status)
	assert.Equal(t, int64(12), gotSubscription.Quantity)
}

func TestBillingService_HandleStripeWebhook_CustomerUpdatedRefreshesBillingEmail(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "old@example.com", StripeCustomerName: "Old Name"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account

	svc := NewBillingService(queries, nil, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret"})
	payload, signature := signedStripeEvent(t, "evt_customer_updated", "customer.updated", map[string]any{
		"id":    "cus_test_123",
		"email": "new@example.com",
		"name":  "New Name",
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	updated := queries.accountsByCustomer["cus_test_123"]
	assert.Equal(t, "new@example.com", updated.StripeCustomerEmail)
	assert.Equal(t, "New Name", updated.StripeCustomerName)
}

func TestBillingService_HandleStripeWebhook_InvoicePaymentFailedSendsDunningNoticeAndRefreshesSubscription(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeOrg, OwnerID: 77, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "billing@example.com", StripeCustomerName: "Acme"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	var gotSubscription db.UpsertBillingSubscriptionParams
	queries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		gotSubscription = arg
		return db.BillingSubscription{}, nil
	}
	emailSender := &mockBillingEmailSender{}
	client := &stripeBillingClientMock{
		getSubscriptionFn: func(context.Context, string) (StripeSubscriptionSnapshot, error) {
			return StripeSubscriptionSnapshot{
				ID:       "sub_test_123",
				PriceID:  "price_team_monthly",
				Interval: BillingIntervalMonthly,
				Status:   "past_due",
				Quantity: 3,
			}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{
		StripeWebhookSecret: "whsec_test_secret",
		TeamMonthlyPriceID:  "price_team_monthly",
	}, WithBillingEmailSender(emailSender))
	payload, signature := signedStripeEvent(t, "evt_invoice_failed", "invoice.payment_failed", map[string]any{
		"id":       "in_test_123",
		"customer": "cus_test_123",
		// API 2026-08-26.dahlia: the subscription id lives under parent.
		"parent":               map[string]any{"subscription_details": map[string]any{"subscription": "sub_test_123"}},
		"number":               "INV-123",
		"hosted_invoice_url":   "https://invoice.stripe.test/pay",
		"amount_due":           2500,
		"currency":             "usd",
		"next_payment_attempt": time.Date(2026, 5, 10, 0, 0, 0, 0, time.UTC).Unix(),
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	assert.Equal(t, "sub_test_123", gotSubscription.StripeSubscriptionID)
	assert.Equal(t, "past_due", gotSubscription.Status)
	require.Len(t, emailSender.calls, 1)
	assert.Equal(t, "billing@example.com", emailSender.calls[0].ToEmail)
	assert.Contains(t, emailSender.calls[0].Subject, "Payment failed")
	assert.Contains(t, emailSender.calls[0].Body, "7")
	assert.Contains(t, emailSender.calls[0].Body, "free plan")
}

func TestBillingService_HandleStripeWebhook_TrialWillEndSendsNotice(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeOrg, OwnerID: 77, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "billing@example.com", StripeCustomerName: "Acme"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	emailSender := &mockBillingEmailSender{}
	svc := NewBillingService(queries, nil, BillingServiceConfig{
		StripeWebhookSecret: "whsec_test_secret",
		TeamMonthlyPriceID:  "price_team_monthly",
	}, WithBillingEmailSender(emailSender))
	payload, signature := signedStripeEvent(t, "evt_trial_will_end", "customer.subscription.trial_will_end", map[string]any{
		"id":        "sub_test_123",
		"customer":  "cus_test_123",
		"status":    "trialing",
		"trial_end": time.Date(2026, 5, 12, 0, 0, 0, 0, time.UTC).Unix(),
		"items": map[string]any{
			"data": []map[string]any{{"quantity": 3, "price": map[string]any{"id": "price_team_monthly", "recurring": map[string]any{"interval": "month"}}}},
		},
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	require.Len(t, emailSender.calls, 1)
	assert.Equal(t, "billing@example.com", emailSender.calls[0].ToEmail)
	assert.Contains(t, emailSender.calls[0].Subject, "trial")
	assert.Contains(t, emailSender.calls[0].Body, "May 12, 2026")
}

func TestBillingService_HandleStripeWebhook_ChargeRefundedRecordsLedgerAudit(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "alice@example.com", StripeCustomerName: "Alice"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	svc := NewBillingService(queries, nil, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret"})
	payload, signature := signedStripeEvent(t, "evt_charge_refunded", "charge.refunded", map[string]any{
		"id":              "ch_test_123",
		"customer":        "cus_test_123",
		"amount_refunded": 1200,
		"currency":        "usd",
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	require.Len(t, queries.creditEntries, 1)
	assert.Equal(t, "refund", queries.creditEntries[0].Category)
	assert.Equal(t, "stripe_event:evt_charge_refunded", queries.creditEntries[0].IdempotencyKey)
	assert.Contains(t, queries.creditEntries[0].Reason, "ch_test_123")
}

func TestBillingService_HandleStripeWebhook_DisputeCreatedRecordsLedgerAudit(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "alice@example.com", StripeCustomerName: "Alice"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	client := &stripeBillingClientMock{
		getChargeFn: func(context.Context, string) (StripeChargeSnapshot, error) {
			return StripeChargeSnapshot{ID: "ch_test_123", CustomerID: "cus_test_123"}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret"})
	payload, signature := signedStripeEvent(t, "evt_dispute_created", "charge.dispute.created", map[string]any{
		"id":       "dp_test_123",
		"charge":   "ch_test_123",
		"amount":   1200,
		"currency": "usd",
		"reason":   "fraudulent",
		"status":   "needs_response",
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	require.Len(t, queries.creditEntries, 1)
	assert.Equal(t, "adjustment", queries.creditEntries[0].Category)
	assert.Equal(t, "stripe_dispute", queries.creditEntries[0].MetricKey)
	assert.Contains(t, queries.creditEntries[0].Reason, "dp_test_123")
}

func TestBillingService_HandleStripeWebhook_DisputeCreatedRevokesPaidAccessAndCredit(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_disputed"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	subscription := db.BillingSubscription{
		ID:                   8,
		BillingAccountID:     account.ID,
		StripeSubscriptionID: "sub_disputed",
		PlanKey:              BillingPlanPro,
		BillingInterval:      BillingIntervalMonthly,
		Status:               "active",
	}
	reversedAt := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		row := subscription
		if len(queries.paymentReversals) > 0 {
			row.PaymentReversedAt = reversedAt
		}
		return row, nil
	}
	ledger := newFakeCreditLedger()
	creditAccountID, err := ledger.EnsureAccount(ctx, account.OwnerType, account.OwnerID)
	require.NoError(t, err)
	const paidCreditCents int64 = 1000
	require.NoError(t, ledger.Grant(ctx, creditAccountID, "invoice:in_disputed", paidCreditCents*credits.NanosPerCent, nil))
	client := &stripeBillingClientMock{
		getChargeFn: func(_ context.Context, chargeID string) (StripeChargeSnapshot, error) {
			assert.Equal(t, "ch_disputed", chargeID)
			return StripeChargeSnapshot{ID: chargeID, CustomerID: account.StripeCustomerID}, nil
		},
	}
	svc := NewBillingService(queries, client, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret"}, WithBillingCreditLedger(ledger))
	user := &db.User{ID: account.OwnerID, Username: "alice"}
	before, err := svc.GetUserOverview(ctx, user)
	require.NoError(t, err)
	require.NotNil(t, before.Subscription)
	assert.Equal(t, "active", before.Subscription.Status)
	assert.Equal(t, BillingPlanPro, before.PlanKey)
	assert.Equal(t, paidCreditCents*credits.NanosPerCent, before.CreditBalanceNanos)

	payload, signature := signedStripeEvent(t, "evt_disputed_credit", "charge.dispute.created", map[string]any{
		"id": "dp_disputed", "charge": "ch_disputed", "amount": 1000, "currency": "usd",
	})
	require.NoError(t, svc.HandleStripeWebhook(ctx, payload, signature))
	after, err := svc.GetUserOverview(ctx, user)
	require.NoError(t, err)
	require.NotNil(t, after.Subscription)
	// Stored subscription status is covered by the public commerce database test.
	assert.Equal(t, BillingPlanFree, after.PlanKey)
	assert.Zero(t, after.CreditBalanceNanos)
	assert.Equal(t, []int64{account.ID}, queries.paymentReversals)
	require.Len(t, queries.creditEntries, 1)
	assert.Equal(t, "stripe_event:evt_disputed_credit", queries.creditEntries[0].IdempotencyKey)

	require.NoError(t, svc.HandleStripeWebhook(ctx, payload, signature))
	replayed, err := svc.GetUserOverview(ctx, user)
	require.NoError(t, err)
	assert.Equal(t, after.Subscription, replayed.Subscription)
	assert.Equal(t, after.PlanKey, replayed.PlanKey)
	assert.Equal(t, after.CreditBalanceNanos, replayed.CreditBalanceNanos)
	assert.Equal(t, []int64{account.ID}, queries.paymentReversals)
	assert.Len(t, queries.creditEntries, 1)
}

func TestBillingService_HandleStripeWebhook_ReplayDoesNotDoubleApply(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "alice@example.com", StripeCustomerName: "Alice"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	svc := NewBillingService(queries, nil, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret"})
	payload, signature := signedStripeEvent(t, "evt_replayed_refund", "charge.refunded", map[string]any{
		"id":              "ch_test_123",
		"customer":        "cus_test_123",
		"amount_refunded": 1200,
		"currency":        "usd",
	})

	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature))
	require.Len(t, queries.creditEntries, 1)
}

func TestBillingService_HandleStripeWebhook_FailedProcessingReleasesClaimForRetry(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	account := db.BillingAccount{ID: 7, OwnerType: BillingOwnerTypeUser, OwnerID: 42, StripeCustomerID: "cus_test_123", StripeCustomerEmail: "alice@example.com", StripeCustomerName: "Alice"}
	queries.accountsByCustomer[account.StripeCustomerID] = account
	queries.accountsByOwner[queries.ownerKey(account.OwnerType, account.OwnerID)] = account
	failNextLookup := true
	queries.getBillingAccountByStripeCustomerFn = func(_ context.Context, customerID string) (db.BillingAccount, error) {
		if failNextLookup {
			failNextLookup = false
			return db.BillingAccount{}, errors.New("transient db error")
		}
		got, ok := queries.accountsByCustomer[customerID]
		if !ok {
			return db.BillingAccount{}, pgx.ErrNoRows
		}
		return got, nil
	}
	svc := NewBillingService(queries, nil, BillingServiceConfig{StripeWebhookSecret: "whsec_test_secret"})
	payload, signature := signedStripeEvent(t, "evt_retried_refund", "charge.refunded", map[string]any{
		"id":              "ch_test_123",
		"customer":        "cus_test_123",
		"amount_refunded": 1200,
		"currency":        "usd",
	})

	require.Error(t, svc.HandleStripeWebhook(context.Background(), payload, signature),
		"a failed side effect must surface so Stripe retries the delivery")
	require.NoError(t, svc.HandleStripeWebhook(context.Background(), payload, signature),
		"the failed delivery must release its processed-event claim so the retry is not swallowed as a duplicate")
	require.Len(t, queries.creditEntries, 1)
}

func TestBillingService_PastDueSubscription_LosesPaidAccessAfterGracePeriod(t *testing.T) {
	t.Parallel()

	const userID int64 = 42
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	owner := billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: userID}

	newService := func(sub db.BillingSubscription) *BillingService {
		queries := newBillingQuerierMock()
		queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, userID)] = db.BillingAccount{
			ID:        1,
			OwnerType: BillingOwnerTypeUser,
			OwnerID:   userID,
		}
		queries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
			return sub, nil
		}
		svc := NewBillingService(queries, nil, BillingServiceConfig{})
		svc.now = func() time.Time { return now }
		return svc
	}

	base := db.BillingSubscription{
		ID:                   1,
		BillingAccountID:     1,
		StripeSubscriptionID: "sub_past_due",
		PlanKey:              BillingPlanPersonal,
		BillingInterval:      BillingIntervalMonthly,
		Status:               "past_due",
	}

	t.Run("within grace period keeps paid plan", func(t *testing.T) {
		sub := base
		sub.PastDueSince = pgtype.Timestamptz{Time: now.Add(-3 * 24 * time.Hour), Valid: true}
		sub.CurrentPeriodEnd = pgtype.Timestamptz{Time: now.Add(27 * 24 * time.Hour), Valid: true}
		plan, err := newService(sub).resolvePlan(context.Background(), owner)
		require.NoError(t, err)
		assert.Equal(t, BillingPlanPersonal, plan.Key)
	})

	t.Run("beyond grace period resolves to free", func(t *testing.T) {
		sub := base
		sub.PastDueSince = pgtype.Timestamptz{Time: now.Add(-8 * 24 * time.Hour), Valid: true}
		// The unpaid invoice starts a new period in Stripe. That future period
		// end must not extend dunning access by another month.
		sub.CurrentPeriodEnd = pgtype.Timestamptz{Time: now.Add(22 * 24 * time.Hour), Valid: true}
		plan, err := newService(sub).resolvePlan(context.Background(), owner)
		require.NoError(t, err)
		assert.Equal(t, BillingPlanFree, plan.Key)
	})

	t.Run("missing period end anchors grace on row update time", func(t *testing.T) {
		sub := base
		sub.UpdatedAt = now.Add(-8 * 24 * time.Hour)
		plan, err := newService(sub).resolvePlan(context.Background(), owner)
		require.NoError(t, err)
		assert.Equal(t, BillingPlanFree, plan.Key)
	})

	t.Run("active status is unaffected by period end", func(t *testing.T) {
		sub := base
		sub.Status = "active"
		sub.CurrentPeriodEnd = pgtype.Timestamptz{Time: now.Add(-30 * 24 * time.Hour), Valid: true}
		plan, err := newService(sub).resolvePlan(context.Background(), owner)
		require.NoError(t, err)
		assert.Equal(t, BillingPlanPersonal, plan.Key)
	})
}

func TestBillingService_ReconcileOrgSeats_UpdatesStripeQuantity(t *testing.T) {
	t.Parallel()

	const orgID int64 = 7

	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeOrg, orgID)] = db.BillingAccount{
		ID:        3,
		OwnerType: BillingOwnerTypeOrg,
		OwnerID:   orgID,
	}
	queries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   1,
			BillingAccountID:     3,
			StripeSubscriptionID: "sub_team",
			PlanKey:              BillingPlanTeam,
			BillingInterval:      BillingIntervalMonthly,
			Status:               "active",
			Quantity:             1,
		}, nil
	}
	queries.countOrgMembersFn = func(context.Context, int64) (int64, error) { return 3, nil }

	var upserted db.UpsertBillingSubscriptionParams
	queries.upsertBillingSubscriptionFn = func(_ context.Context, arg db.UpsertBillingSubscriptionParams) (db.BillingSubscription, error) {
		upserted = arg
		return db.BillingSubscription{}, nil
	}

	client := &stripeBillingClientMock{
		getSubscriptionFn: func(_ context.Context, subscriptionID string) (StripeSubscriptionSnapshot, error) {
			return StripeSubscriptionSnapshot{
				ID:       subscriptionID,
				Status:   "active",
				Quantity: 3,
				Interval: BillingIntervalMonthly,
			}, nil
		},
	}

	svc := NewBillingService(queries, client, BillingServiceConfig{})
	require.NoError(t, svc.ReconcileOrgSeats(context.Background(), orgID))
	assert.Equal(t, int64(3), client.updatedSeatQuantities["sub_team"])
	assert.Equal(t, int64(3), upserted.Quantity)
	assert.Equal(t, "sub_team", upserted.StripeSubscriptionID)
}

func TestBillingService_ReconcileOrgSeats_NoopWhenQuantityMatches(t *testing.T) {
	t.Parallel()

	const orgID int64 = 7

	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeOrg, orgID)] = db.BillingAccount{
		ID:        3,
		OwnerType: BillingOwnerTypeOrg,
		OwnerID:   orgID,
	}
	queries.getLatestLiveSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{
			ID:                   1,
			BillingAccountID:     3,
			StripeSubscriptionID: "sub_team",
			Status:               "active",
			Quantity:             2,
		}, nil
	}
	queries.countOrgMembersFn = func(context.Context, int64) (int64, error) { return 2, nil }

	client := &stripeBillingClientMock{}
	svc := NewBillingService(queries, client, BillingServiceConfig{})
	require.NoError(t, svc.ReconcileOrgSeats(context.Background(), orgID))
	assert.Empty(t, client.updatedSeatQuantities)
}

func TestBillingService_ReconcileOrgSeats_NoopWithoutAccount(t *testing.T) {
	t.Parallel()

	queries := newBillingQuerierMock()
	client := &stripeBillingClientMock{}
	svc := NewBillingService(queries, client, BillingServiceConfig{})
	require.NoError(t, svc.ReconcileOrgSeats(context.Background(), 99))
	assert.Empty(t, client.updatedSeatQuantities)
}

const testBillingMonthlyCreditGrantCents int64 = 1000

// fakeCreditLedger is an in-memory BillingCreditLedger; credits.Ledger's
// PostgreSQL tests cover the real ledger.
type fakeCreditLedger struct {
	mu       sync.Mutex
	accounts map[string]int64
	grants   map[int64]map[string]int64
	err      error
}

func newFakeCreditLedger() *fakeCreditLedger {
	return &fakeCreditLedger{accounts: map[string]int64{}, grants: map[int64]map[string]int64{}}
}

func (f *fakeCreditLedger) EnsureAccount(_ context.Context, ownerType string, ownerID int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	key := fmt.Sprintf("%s:%d", ownerType, ownerID)
	if id, ok := f.accounts[key]; ok {
		return id, nil
	}
	id := int64(len(f.accounts) + 1)
	f.accounts[key] = id
	f.grants[id] = map[string]int64{}
	return id, nil
}

func (f *fakeCreditLedger) Grant(_ context.Context, accountID int64, key string, nanos int64, _ *time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, ok := f.grants[accountID][key]; ok && existing != nanos {
		return credits.ErrConflict
	}
	f.grants[accountID][key] = nanos
	return nil
}

func (f *fakeCreditLedger) Forfeit(_ context.Context, ownerType string, ownerID int64, prefix string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	var taken int64
	grants := f.grants[f.accounts[fmt.Sprintf("%s:%d", ownerType, ownerID)]]
	for key, n := range grants {
		if strings.HasPrefix(key, prefix) {
			taken += n
			delete(grants, key)
		}
	}
	return taken, nil
}

func (f *fakeCreditLedger) OwnerBalance(_ context.Context, ownerType string, ownerID int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	var total int64
	for _, n := range f.grants[f.accounts[fmt.Sprintf("%s:%d", ownerType, ownerID)]] {
		total += n
	}
	return total, nil
}

func (f *fakeCreditLedger) OwnerSummary(ctx context.Context, ownerType string, ownerID int64) (int64, int64, int64, error) {
	balance, err := f.OwnerBalance(ctx, ownerType, ownerID)
	return balance, 0, 0, err
}

// Reading a balance grants no plan credit: only a paid invoice does.
func TestBillingService_BalanceReadGrantsNoPlanCredit(t *testing.T) {
	queries := newBillingQuerierMock()
	queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, 42)] = db.BillingAccount{ID: 1, OwnerType: BillingOwnerTypeUser, OwnerID: 42}
	queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
		return db.BillingSubscription{BillingAccountID: 1, Status: "active", PlanKey: BillingPlanPro}, nil
	}
	ledger := newFakeCreditLedger()
	svc := NewBillingService(queries, nil, BillingServiceConfig{MonthlyCreditGrantCents: testBillingMonthlyCreditGrantCents}, WithBillingCreditLedger(ledger))
	overview, err := svc.GetUserOverview(context.Background(), &db.User{ID: 42, Username: "alice"})
	require.NoError(t, err)
	assert.Zero(t, overview.CreditBalanceNanos)
	assert.Empty(t, ledger.accounts)
}

// A subscription webhook forfeits plan credit once no active or trialing
// subscription can spend it; the signup grant stays. A billing read never
// forfeits: it could race the webhook transaction that grants the credit
// (smithersai/smithers#2175).
func TestBillingService_LapsedSubscriptionForfeitsPlanCredit(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		status string
		kept   bool
	}{{"active", true}, {"trialing", true}, {"past_due", false}, {"", false}} {
		queries := newBillingQuerierMock()
		queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, 42)] = db.BillingAccount{ID: 1, OwnerType: BillingOwnerTypeUser, OwnerID: 42}
		if tc.status != "" {
			queries.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
				return db.BillingSubscription{BillingAccountID: 1, Status: tc.status, PlanKey: BillingPlanPro, PastDueSince: pgtype.Timestamptz{Time: time.Now(), Valid: true}}, nil
			}
		}
		ledger := newFakeCreditLedger()
		id, err := ledger.EnsureAccount(ctx, BillingOwnerTypeUser, 42)
		require.NoError(t, err)
		require.NoError(t, ledger.Grant(ctx, id, "invoice:in_1", 5000*credits.NanosPerCent, nil))
		require.NoError(t, ledger.Grant(ctx, id, credits.SignupGrantKey, 1000*credits.NanosPerCent, nil))
		svc := NewBillingService(queries, nil, BillingServiceConfig{MonthlyCreditGrantCents: 5000}, WithBillingCreditLedger(ledger))
		overview, err := svc.GetUserOverview(ctx, &db.User{ID: 42, Username: "alice"})
		require.NoError(t, err)
		assert.Equal(t, int64(6000), overview.CreditBalanceCents, "a read does not forfeit: %s", tc.status)
		require.NoError(t, svc.forfeitLapsedPlanCredit(ctx, queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, 42)]))
		overview, err = svc.GetUserOverview(ctx, &db.User{ID: 42, Username: "alice"})
		require.NoError(t, err)
		want := int64(1000)
		if tc.kept {
			want = 6000
		}
		assert.Equal(t, want, overview.CreditBalanceCents, tc.status)
	}
}

func TestBillingService_CreditBalanceFailureFailsOverview(t *testing.T) {
	queries := newBillingQuerierMock()
	ledger := newFakeCreditLedger()
	ledger.err = errors.New("ledger down")
	svc := NewBillingService(queries, nil, BillingServiceConfig{}, WithBillingCreditLedger(ledger))
	_, err := svc.GetUserOverview(context.Background(), &db.User{ID: 42, Username: "alice"})
	assert.Equal(t, 500, httpStatus(err))
}

func (m *billingQuerierMock) CountActiveSandboxesForUser(ctx context.Context, userID int64) (int, error) {
	if m.countActiveSandboxesFn != nil {
		return m.countActiveSandboxesFn(ctx, userID)
	}
	return 0, nil
}
func (m *billingQuerierMock) CountOtherActiveSandboxesForWorkspaceResume(ctx context.Context, arg db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error) {
	if m.countOtherSandboxResumeFn != nil {
		return m.countOtherSandboxResumeFn(ctx, arg)
	}
	return db.CountOtherActiveSandboxesForWorkspaceResumeRow{}, nil
}
func (m *billingQuerierMock) CountActiveAgentSessionVMsForUser(ctx context.Context, userID int64) (int64, error) {
	if m.countActiveAgentsFn != nil {
		return m.countActiveAgentsFn(ctx, userID)
	}
	return 0, nil
}
func (m *billingQuerierMock) SumSandboxAwakeSecondsForUserSince(ctx context.Context, userID int64, since time.Time) (int64, error) {
	if m.sumSandboxSecondsFn != nil {
		return m.sumSandboxSecondsFn(ctx, userID, since)
	}
	return 0, nil
}

// Every event the deployment's Stripe endpoint subscribes to has a handler.
func TestStripeWebhookEventsAreHandled(t *testing.T) {
	svc := NewBillingService(newBillingQuerierMock(), nil, BillingServiceConfig{})
	for _, event := range StripeWebhookEvents {
		err := svc.handleStripeEvent(context.Background(), "evt_1", event, time.Time{}, json.RawMessage(`"not an object"`))
		assert.Equal(t, 400, httpStatus(err), event)
	}
	assert.NoError(t, svc.handleStripeEvent(context.Background(), "evt_1", "invoice.created", time.Time{}, json.RawMessage(`"x"`)))
}
