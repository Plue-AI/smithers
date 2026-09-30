package compose

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type sandboxPlanStub struct {
	services.BillingPolicy
	limit     int64
	refuseErr error
	lookupErr error
}

func (s sandboxPlanStub) AuthorizeSandboxStart(context.Context, int64) error { return s.refuseErr }

func (s sandboxPlanStub) SandboxEntitlement(context.Context, int64) (services.SandboxEntitlement, error) {
	return services.SandboxEntitlement{ConcurrentSandboxes: s.limit}, s.lookupErr
}

func TestSandboxPlanAdmissionRaisesTheCapOnlyForLargerFinitePlans(t *testing.T) {
	ctx := context.Background()

	aboveCap, err := sandboxPlanAdmission(sandboxPlanStub{limit: 64})(ctx, 7)
	require.NoError(t, err)
	assert.True(t, aboveCap, "Max admits starts past the default cap up to its plan limit")

	aboveCap, err = sandboxPlanAdmission(sandboxPlanStub{limit: 3})(ctx, 7)
	require.NoError(t, err)
	assert.False(t, aboveCap, "a plan below the default cap keeps the cap")

	aboveCap, err = sandboxPlanAdmission(services.NewUnlimitedBillingPolicy())(ctx, 7)
	require.NoError(t, err)
	assert.False(t, aboveCap, "unlimited billing keeps the default cap")

	refused := errors.New("plan limit reached")
	_, err = sandboxPlanAdmission(sandboxPlanStub{limit: 64, refuseErr: refused})(ctx, 7)
	require.ErrorIs(t, err, refused)

	unavailable := errors.New("entitlement unavailable")
	aboveCap, err = sandboxPlanAdmission(sandboxPlanStub{limit: 64, lookupErr: unavailable})(ctx, 7)
	require.ErrorIs(t, err, unavailable)
	assert.False(t, aboveCap, "a failed lookup never lifts the cap")

	assert.Nil(t, sandboxPlanAdmission(nil))
}
