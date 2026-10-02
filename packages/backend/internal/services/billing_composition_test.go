package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestNewBillingComposition_UnlimitedHasNoCommerceSurface(t *testing.T) {
	t.Parallel()

	composition, err := NewBillingComposition(nil, BillingCompositionConfig{Mode: BillingModeUnlimited})
	require.NoError(t, err)
	require.IsType(t, &UnlimitedBillingPolicy{}, composition.Policy)
	assert.Nil(t, composition.Service)
	assert.Equal(t, BillingCapabilities{}, composition.Capabilities)

	entitlement, err := composition.Policy.SandboxEntitlement(t.Context(), 1)
	require.NoError(t, err)
	assert.Equal(t, BillingPlanCustom, entitlement.PlanKey)
	assert.Equal(t, unlimitedBillingQuantity, entitlement.ConcurrentSandboxes)
	assert.Zero(t, entitlement.IdleTimeoutSecs, "unlimited billing imposes no idle deadline")
	assert.Equal(t, int64(-1), entitlement.HoursPerDay)
	require.NoError(t, composition.Policy.AuthorizePrivateRepo(t.Context(), BillingOwnerTypeUser, 1))
}

func TestNewBillingComposition_UnlimitedRejectsHostedConfiguration(t *testing.T) {
	t.Parallel()

	_, err := NewBillingComposition(nil, BillingCompositionConfig{
		Mode:            BillingModeUnlimited,
		StripeSecretKey: "sk_test_configured",
	})
	require.ErrorContains(t, err, "requires mode \"stripe\"")
}

func TestNewBillingComposition_StripeModeIsRefused(t *testing.T) {
	t.Parallel()

	composition, err := NewBillingComposition(newBillingQuerierMock(), BillingCompositionConfig{
		Mode:            BillingModeStripe,
		StripeSecretKey: "sk_test_configured",
		Service:         BillingServiceConfig{StripeWebhookSecret: "whsec_configured", ProMonthlyPriceID: "price_pro_monthly"},
	})
	require.ErrorIs(t, err, ErrStripeBillingUnavailable)
	assert.Nil(t, composition.Policy, "a refused mode must not fall back to an admission policy")
	assert.Nil(t, composition.Service)
}

func TestUnlimitedBillingPolicy_CommitsExactlyTheProductMutation(t *testing.T) {
	t.Parallel()

	policy := NewUnlimitedBillingPolicy()
	want := errors.New("commit failed")
	calls := 0
	err := policy.AuthorizeStorageIncreaseCommittedDynamic(
		t.Context(),
		1,
		func(context.Context) (int64, error) { return 123, nil },
		func(context.Context) error {
			calls++
			return want
		},
	)
	assert.ErrorIs(t, err, want)
	assert.Equal(t, 1, calls)
}

func TestUnlimitedBillingPolicy_AgentRunCommitExactlyOnce(t *testing.T) {
	policy := NewUnlimitedBillingPolicy()
	assert.Error(t, policy.AuthorizeAgentRunCommitted(t.Context(), 1, nil))
	want := errors.New("run insert failed")
	calls := 0
	err := policy.AuthorizeAgentRunCommitted(t.Context(), 1, func(_ context.Context, conn db.DBTX) error {
		calls++
		assert.Nil(t, conn)
		return want
	})
	require.ErrorIs(t, err, want)
	assert.Equal(t, 1, calls)
}

func TestUnlimitedBillingPolicy_DynamicStoragePreservesResolverFailure(t *testing.T) {
	t.Parallel()

	want := errors.New("size unavailable")
	committed := false
	err := NewUnlimitedBillingPolicy().AuthorizeStorageIncreaseCommittedDynamic(
		t.Context(),
		1,
		func(context.Context) (int64, error) { return 0, want },
		func(context.Context) error { committed = true; return nil },
	)
	assert.ErrorIs(t, err, want)
	assert.False(t, committed)
}

var (
	_ BillingPolicy                           = (*UnlimitedBillingPolicy)(nil)
	_ StorageCommitAuthorizer                 = (*UnlimitedBillingPolicy)(nil)
	_ DynamicStorageCommitAuthorizer          = (*UnlimitedBillingPolicy)(nil)
	_ PrivateRepoCommitAuthorizer             = (*UnlimitedBillingPolicy)(nil)
	_ RepositoryTransferCommitAuthorizer      = (*UnlimitedBillingPolicy)(nil)
	_ RepositoryTransferTransactionAuthorizer = (*UnlimitedBillingPolicy)(nil)
)
