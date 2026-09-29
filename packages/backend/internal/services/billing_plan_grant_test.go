package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestBillingServiceGrantPlanValidatesBeforeDatabase(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	base := PlanGrant{OwnerType: BillingOwnerTypeUser, OwnerID: 7, PlanKey: BillingPlanPro,
		Key: "operator:case-1", ExpiresAt: now.Add(time.Hour), Actor: "will", Reason: "support case"}
	tests := map[string]func(*PlanGrant){
		"owner type":   func(g *PlanGrant) { g.OwnerType = BillingOwnerTypeOrg },
		"owner id":     func(g *PlanGrant) { g.OwnerID = 0 },
		"free plan":    func(g *PlanGrant) { g.PlanKey = BillingPlanFree },
		"team plan":    func(g *PlanGrant) { g.PlanKey = BillingPlanTeam },
		"unknown plan": func(g *PlanGrant) { g.PlanKey = "unknown" },
		"key":          func(g *PlanGrant) { g.Key = "  " },
		"actor":        func(g *PlanGrant) { g.Actor = "  " },
		"reason":       func(g *PlanGrant) { g.Reason = "  " },
		"zero end":     func(g *PlanGrant) { g.ExpiresAt = time.Time{} },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			grant := base
			mutate(&grant)
			svc := NewBillingService(nil, nil, BillingServiceConfig{})
			svc.now = func() time.Time { return now }
			require.Error(t, svc.GrantPlan(t.Context(), grant))
		})
	}
}

func planGrantTestUser(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES ('grant-owner','grant-owner') RETURNING id`).Scan(&id))
	return id
}

func planGrantRowCount(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, table string) int {
	t.Helper()
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), "SELECT count(*) FROM "+table).Scan(&count))
	return count
}

func TestBillingServiceGrantPlanAuditReplayAndExpiry(t *testing.T) {
	pool := newProductTestPool(t)
	ownerID := planGrantTestUser(t, pool)
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	svc := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	svc.now = func() time.Time { return now }
	grant := PlanGrant{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID, PlanKey: BillingPlanPro,
		Key: "operator:case-1", ExpiresAt: now.Add(2*time.Hour + 123456789*time.Nanosecond),
		Actor: "will", Reason: "support case"}
	require.NoError(t, svc.GrantPlan(t.Context(), grant))
	var plan, key, actor, reason string
	var expiresAt time.Time
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT plan_key,source_key,actor,reason,expires_at FROM billing_plan_grants`).Scan(&plan, &key, &actor, &reason, &expiresAt))
	require.Equal(t, BillingPlanPro, plan)
	require.Equal(t, grant.Key, key)
	require.Equal(t, grant.Actor, actor)
	require.Equal(t, grant.Reason, reason)
	require.True(t, expiresAt.Equal(grant.ExpiresAt.Truncate(time.Microsecond)))
	require.Equal(t, 1, planGrantRowCount(t, pool, "billing_plan_grants"))
	require.Equal(t, 0, planGrantRowCount(t, pool, "billing_accounts"))
	require.Equal(t, 0, planGrantRowCount(t, pool, "credit_grants"))

	resolved, err := svc.resolvePlan(t.Context(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID})
	require.NoError(t, err)
	require.Equal(t, BillingPlanPro, resolved.Key)
	require.Equal(t, int64(15000), resolved.Limits.AgentRuns)
	local, usage, account, subscription, err := svc.resolveLocalState(t.Context(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID})
	require.NoError(t, err)
	require.Equal(t, BillingPlanPro, local.Key)
	require.Equal(t, int64(15000), usage[BillingMetricAgentRuns].IncludedQuantity)
	require.Nil(t, account)
	require.Nil(t, subscription)
	paid, err := svc.OwnerHasPaidPlan(t.Context(), BillingOwnerTypeUser, ownerID)
	require.NoError(t, err)
	require.True(t, paid)

	// The original receipt remains replayable after the entitlement expires.
	svc.now = func() time.Time { return now.Add(3 * time.Hour) }
	require.NoError(t, svc.GrantPlan(t.Context(), grant))
	require.Equal(t, 1, planGrantRowCount(t, pool, "billing_plan_grants"))
	resolved, err = svc.resolvePlan(t.Context(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID})
	require.NoError(t, err)
	require.Equal(t, BillingPlanFree, resolved.Key)
	paid, err = svc.OwnerHasPaidPlan(t.Context(), BillingOwnerTypeUser, ownerID)
	require.NoError(t, err)
	require.False(t, paid)

	for name, change := range map[string]func(*PlanGrant){
		"plan":   func(g *PlanGrant) { g.PlanKey = BillingPlanMax },
		"end":    func(g *PlanGrant) { g.ExpiresAt = g.ExpiresAt.Add(time.Microsecond) },
		"actor":  func(g *PlanGrant) { g.Actor = "another operator" },
		"reason": func(g *PlanGrant) { g.Reason = "another reason" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := grant
			change(&changed)
			require.True(t, errors.Is(svc.GrantPlan(t.Context(), changed), credits.ErrConflict))
		})
	}
	require.Equal(t, 1, planGrantRowCount(t, pool, "billing_plan_grants"))
}

func TestBillingServiceGrantPlanOwnerAndConcurrentReplay(t *testing.T) {
	pool := newProductTestPool(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	svc := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	svc.now = func() time.Time { return now }
	grant := PlanGrant{OwnerType: BillingOwnerTypeUser, OwnerID: 999999999, PlanKey: BillingPlanMax,
		Key: "operator:case-2", ExpiresAt: now.Add(time.Hour), Actor: "will", Reason: "support case"}
	require.Error(t, svc.GrantPlan(t.Context(), grant))
	require.Equal(t, 0, planGrantRowCount(t, pool, "billing_plan_grants"))
	grant.OwnerID = planGrantTestUser(t, pool)
	for _, end := range []time.Time{now.Add(-time.Second), now} {
		invalid := grant
		invalid.ExpiresAt = end
		require.Error(t, svc.GrantPlan(t.Context(), invalid))
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	require.Error(t, svc.GrantPlan(canceled, grant))
	require.Equal(t, 0, planGrantRowCount(t, pool, "billing_plan_grants"))
	const workers = 8
	var wg sync.WaitGroup
	errorsByWorker := make([]error, workers)
	for i := range errorsByWorker {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errorsByWorker[i] = svc.GrantPlan(context.Background(), grant)
		}(i)
	}
	wg.Wait()
	for i, err := range errorsByWorker {
		require.NoError(t, err, fmt.Sprintf("worker %d", i))
	}
	require.Equal(t, 1, planGrantRowCount(t, pool, "billing_plan_grants"))

	// Distinct keys race against the same owner lock and retain both receipts.
	distinct := []PlanGrant{
		{OwnerType: BillingOwnerTypeUser, OwnerID: grant.OwnerID, PlanKey: BillingPlanPro,
			Key: "operator:concurrent-pro", ExpiresAt: now.Add(time.Hour), Actor: "will", Reason: "pro case"},
		{OwnerType: BillingOwnerTypeUser, OwnerID: grant.OwnerID, PlanKey: BillingPlanMax,
			Key: "operator:concurrent-max", ExpiresAt: now.Add(time.Hour), Actor: "will", Reason: "max case"},
	}
	wg = sync.WaitGroup{}
	for i := range distinct {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errorsByWorker[i] = svc.GrantPlan(context.Background(), distinct[i])
		}(i)
	}
	wg.Wait()
	require.NoError(t, errorsByWorker[0])
	require.NoError(t, errorsByWorker[1])
	require.Equal(t, 3, planGrantRowCount(t, pool, "billing_plan_grants"))
	var latestPlan string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT plan_key FROM billing_plan_grants ORDER BY id DESC LIMIT 1`).Scan(&latestPlan))
	resolved, err := svc.resolvePlan(t.Context(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: grant.OwnerID})
	require.NoError(t, err)
	require.Equal(t, latestPlan, resolved.Key)
}

func TestBillingServiceGrantPlanPrecedence(t *testing.T) {
	pool := newProductTestPool(t)
	ownerID := planGrantTestUser(t, pool)
	now := time.Now().UTC().Truncate(time.Microsecond)
	svc := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	svc.now = func() time.Time { return now }
	grant := PlanGrant{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID, PlanKey: BillingPlanPro,
		Key: "operator:case-3", ExpiresAt: now.Add(time.Hour), Actor: "will", Reason: "support case"}
	require.NoError(t, svc.GrantPlan(t.Context(), grant))
	grant.Key = "operator:case-4"
	grant.PlanKey = BillingPlanMax
	require.NoError(t, svc.GrantPlan(t.Context(), grant))
	assertPlan := func(want string) {
		t.Helper()
		resolved, err := svc.resolvePlan(t.Context(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID})
		require.NoError(t, err)
		require.Equal(t, want, resolved.Key)
	}
	assertPlan(BillingPlanMax)
	var accountID int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO billing_accounts(owner_type,owner_id,stripe_customer_id)
		VALUES ('user',$1,'cus_plan_grant') RETURNING id`, ownerID).Scan(&accountID))
	_, err := pool.Exec(t.Context(), `INSERT INTO billing_subscriptions(billing_account_id,stripe_subscription_id,plan_key,billing_interval,status,quantity)
		VALUES ($1,'sub_plan_grant','personal','monthly','active',1)`, accountID)
	require.NoError(t, err)
	assertPlan(BillingPlanPersonal)
	_, err = pool.Exec(t.Context(), `UPDATE billing_subscriptions SET status='past_due'`)
	require.NoError(t, err)
	assertPlan(BillingPlanPersonal)
	_, err = pool.Exec(t.Context(), `UPDATE billing_subscriptions SET payment_reversed_at=$1`, now)
	require.NoError(t, err)
	assertPlan(BillingPlanFree)
	_, err = pool.Exec(t.Context(), `UPDATE billing_subscriptions SET status='canceled'`)
	require.NoError(t, err)
	assertPlan(BillingPlanMax)
	local, usage, account, subscription, err := svc.resolveLocalState(t.Context(), billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: ownerID})
	require.NoError(t, err)
	require.Equal(t, BillingPlanMax, local.Key)
	require.Equal(t, local.Limits.AgentRuns, usage[BillingMetricAgentRuns].IncludedQuantity)
	require.NotNil(t, account)
	require.Equal(t, accountID, account.ID)
	require.Nil(t, subscription)
	// A newer expired grant cannot hide a still-active earlier grant.
	grant.Key = "operator:case-5"
	grant.PlanKey = BillingPlanPro
	grant.ExpiresAt = now.Add(10 * time.Minute)
	require.NoError(t, svc.GrantPlan(t.Context(), grant))
	assertPlan(BillingPlanPro)
	svc.now = func() time.Time { return now.Add(15 * time.Minute) }
	assertPlan(BillingPlanMax)
}

func TestBillingServiceGrantPlanQueryFailureFailsClosed(t *testing.T) {
	sentinel := errors.New("plan grant query unavailable")
	for _, withAccount := range []bool{false, true} {
		name := "without billing account"
		if withAccount {
			name = "with billing account and no live subscription"
		}
		t.Run(name, func(t *testing.T) {
			queries := newBillingQuerierMock()
			if withAccount {
				queries.accountsByOwner[queries.ownerKey(BillingOwnerTypeUser, 42)] = db.BillingAccount{ID: 5, OwnerType: BillingOwnerTypeUser, OwnerID: 42}
			}
			queries.getActiveBillingPlanGrantFn = func(_ context.Context, arg db.GetActiveBillingPlanGrantParams) (db.BillingPlanGrant, error) {
				require.Equal(t, BillingOwnerTypeUser, arg.OwnerType)
				require.Equal(t, int64(42), arg.OwnerID)
				return db.BillingPlanGrant{}, sentinel
			}
			svc := NewBillingService(queries, nil, BillingServiceConfig{})
			owner := billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: 42}
			_, err := svc.resolvePlan(t.Context(), owner)
			requirePlanGrantQueryError(t, err, sentinel)
			_, _, _, _, err = svc.resolveLocalState(t.Context(), owner)
			requirePlanGrantQueryError(t, err, sentinel)
			paid, err := svc.OwnerHasPaidPlan(t.Context(), owner.OwnerType, owner.OwnerID)
			require.False(t, paid)
			requirePlanGrantQueryError(t, err, sentinel)
		})
	}
}

func requirePlanGrantQueryError(t *testing.T, err, cause error) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.ErrorIs(t, apiErr.Cause(), cause)
}
