package compose

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit"
)

type routerCanarySource struct{ runs []services.CanaryRun }

func (s routerCanarySource) LatestCanaryRuns(context.Context) ([]services.CanaryRun, error) {
	return s.runs, nil
}

func TestPublicStatusRouteIsAnonymous(t *testing.T) {
	// A recent completed run distinguishes the mounted status handler from a
	// generic fallback while exercising the public router without auth state.
	source := routerCanarySource{runs: []services.CanaryRun{{
		Status: "success", CompletedAt: time.Now().Add(-time.Minute), FreshnessWindow: time.Hour,
	}}}
	router := routerWithExtras(routerExtras{CanaryRuns: source})
	body, err := testkit.APIClient(router, nil).GetAPIStatus(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "ok", body.Status)
	assert.Equal(t, "ok", body.Components.Canary.Status)
	assert.NotEmpty(t, body.Components.Canary.Detail)
	assert.False(t, body.CheckedAt.IsZero())
}
