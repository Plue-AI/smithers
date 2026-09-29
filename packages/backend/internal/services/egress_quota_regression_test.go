package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func TestBillingSandboxEntitlementCarriesDailyEgressGrant(t *testing.T) {
	for _, tc := range []struct {
		plan string
		want int64
	}{
		{BillingPlanFree, 1 << 30},
		{BillingPlanPro, 10 << 30},
		{BillingPlanMax, 100 << 30},
	} {
		t.Run(tc.plan, func(t *testing.T) {
			svc, _ := sandboxTestBilling(tc.plan)
			entitlement, err := svc.SandboxEntitlement(t.Context(), 7)
			require.NoError(t, err)
			assert.Equal(t, tc.want, entitlement.EgressBytesPerDay)
		})
	}

	for _, tc := range []struct {
		owner, plan string
		want        int64
	}{
		{BillingOwnerTypeUser, BillingPlanPersonal, 5 << 30},
		{BillingOwnerTypeOrg, BillingPlanTeam, 100 << 30},
		{BillingOwnerTypeOrg, BillingPlanEnterprise, 1000 << 30},
		{BillingOwnerTypeOrg, BillingPlanCustom, 1000 << 30},
		{BillingOwnerTypeUser, BillingPlanCustom, 5 << 30},
	} {
		t.Run(tc.plan, func(t *testing.T) {
			svc, _ := sandboxTestBilling(BillingPlanFree)
			key := tc.plan
			if tc.plan != BillingPlanCustom {
				key += ":" + BillingIntervalMonthly
			}
			assert.Equal(t, tc.want, svc.checkoutPlans[tc.owner][key].Limits.EgressBytesPerDay)
		})
	}
}

func TestBillingEgressGrantSurvivesStripePriceRotation(t *testing.T) {
	for _, tier := range []struct {
		plan string
		want int64
	}{
		{BillingPlanPro, 10 << 30},
		{BillingPlanMax, 100 << 30},
	} {
		for _, price := range []struct {
			name, id, interval string
		}{
			{name: "missing price ID", interval: BillingIntervalMonthly},
			{name: "retired price ID", id: "price_retired", interval: BillingIntervalMonthly},
			{name: "legacy blank interval", id: "price_retired"},
			{name: "retired annual price ID", id: "price_retired_annual", interval: BillingIntervalAnnual},
		} {
			t.Run(tier.plan+"/"+price.name, func(t *testing.T) {
				svc, q := sandboxTestBilling(tier.plan)
				svc.config.ProAnnualPriceID = "price_pro_annual_current"
				svc.config.MaxAnnualPriceID = "price_max_annual_current"
				svc.bootstrapCatalog()
				q.getLatestSubscriptionFn = func(context.Context, int64) (db.BillingSubscription, error) {
					return db.BillingSubscription{
						PlanKey: tier.plan, StripePriceID: price.id,
						Status: "active", BillingInterval: price.interval,
					}, nil
				}
				entitlement, err := svc.SandboxEntitlement(t.Context(), 7)
				require.NoError(t, err)
				assert.Equal(t, tier.plan, entitlement.PlanKey)
				assert.Equal(t, tier.want, entitlement.EgressBytesPerDay)
			})
		}
	}
}

func TestWorkspaceEgressQuotaUsesWorkspaceOwner(t *testing.T) {
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
		assert.Equal(t, "workspace-1", id)
		return db.Workspace{ID: id, UserID: 42, RepositoryID: 9}, nil
	}}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceBillingPolicy(sandboxPolicyStub{
		entitlement: SandboxEntitlement{EgressBytesPerDay: 10 << 30},
	}))
	req, err := svc.buildWorkspaceVMRequest(t.Context(), "", nil, 9, "workspace-1", "container")
	require.NoError(t, err)
	require.NotNil(t, req.EgressProxy)
	assert.Equal(t, &sandbox.EgressQuota{BillingUserID: 42, DailyBytes: 10 << 30}, req.EgressProxy.Quota)
}

func TestWorkspaceEgressQuotaFailsClosedOnOwnerOrPlanError(t *testing.T) {
	failure := errors.New("billing unavailable")
	for _, tc := range []struct {
		name string
		q    *mockWorkspaceQuerier
		bill sandboxPolicyStub
	}{
		{name: "workspace owner", q: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{}, failure
		}}},
		{name: "plan", q: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			return db.Workspace{UserID: 42, RepositoryID: 9}, nil
		}}, bill: sandboxPolicyStub{err: failure}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := newWorkspaceServiceForTests(tc.q, WithWorkspaceBillingPolicy(tc.bill))
			_, err := svc.buildWorkspaceVMRequest(t.Context(), "", nil, 9, "workspace-1", "container")
			require.ErrorIs(t, err, failure)
		})
	}
}

func TestWorkspaceEgressQuotaUsesDeploymentDefaultWithoutOwner(t *testing.T) {
	for _, tc := range []struct {
		name string
		bill BillingPolicy
		repo int64
		id   string
	}{
		{name: "golden bake", bill: sandboxPolicyStub{err: errors.New("must not read billing")}},
		{name: "self hosted", bill: nil, repo: 9, id: "workspace-1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceBillingPolicy(tc.bill))
			req, err := svc.buildWorkspaceVMRequest(t.Context(), "", nil, tc.repo, tc.id, "container")
			require.NoError(t, err)
			require.NotNil(t, req.EgressProxy)
			assert.Nil(t, req.EgressProxy.Quota)
		})
	}
}

func TestStandaloneEgressQuotaUsesAgentBillingUser(t *testing.T) {
	quota, err := egressQuotaForUser(t.Context(), sandboxPolicyStub{
		entitlement: SandboxEntitlement{EgressBytesPerDay: 5 << 30},
	}, 71)
	require.NoError(t, err)
	assert.Equal(t, &sandbox.EgressQuota{BillingUserID: 71, DailyBytes: 5 << 30}, quota)

	quota, err = egressQuotaForUser(t.Context(), NewUnlimitedBillingPolicy(), 71)
	require.NoError(t, err)
	assert.Equal(t, &sandbox.EgressQuota{BillingUserID: 71, DailyBytes: -1}, quota)

	failure := errors.New("billing unavailable")
	quota, err = egressQuotaForUser(t.Context(), sandboxPolicyStub{err: failure}, 71)
	require.ErrorIs(t, err, failure)
	assert.Nil(t, quota)
}

func TestStandaloneAgentCreateVMForwardsGrantAndFailsClosed(t *testing.T) {
	var created sandbox.CreateRequest
	createCalls := 0
	client := &mockSandboxVMClient{createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		createCalls++
		created = req
		return sandbox.CreateResult{ID: "vm-quota"}, nil
	}}
	d := newEgressDispatch(t, client)
	d.input.UserID = 71
	d.svc.billing = sandboxPolicyStub{entitlement: SandboxEntitlement{EgressBytesPerDay: 5 << 30}}
	require.NoError(t, d.createVM())
	require.NotNil(t, created.EgressProxy)
	assert.Equal(t, &sandbox.EgressQuota{BillingUserID: 71, DailyBytes: 5 << 30}, created.EgressProxy.Quota)
	assert.Equal(t, 1, createCalls)
	d.svc.cancelAgentRuntimeWatchdog(d.input.SessionID)

	failure := errors.New("billing unavailable")
	d = newEgressDispatch(t, client)
	d.input.UserID = 71
	d.svc.billing = sandboxPolicyStub{err: failure}
	require.ErrorIs(t, d.createVM(), failure)
	assert.Equal(t, 1, createCalls, "a failed entitlement must not create an unmetered VM")
}
