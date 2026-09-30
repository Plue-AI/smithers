package admission_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// smithersai/plue#593: recorded git bytes count toward the owner's storage.
// A repository's allowance is what the owner has left plus the repository's
// own recorded bytes, so its other repositories' bytes shrink it; a newer
// measurement replaces the stored one and a late older one is dropped.
func TestMeteredGitBytesCountTowardStorage(t *testing.T) {
	ctx := context.Background()
	pool := database(t)
	owner := user(t, pool)
	first, second := repository(t, pool, owner), repository(t, pool, owner)
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	queries := db.New(pool)
	meter := services.NewGitStorageMeter(policy, queries)
	const freeStorage = int64(100 << 30)
	at := time.Unix(1700000000, 0)

	allowance, limited, err := meter.GitBytesAllowance(ctx, first)
	require.NoError(t, err)
	require.True(t, limited)
	require.Equal(t, freeStorage, allowance)

	require.NoError(t, meter.RecordGitBytes(ctx, first, 40<<30, at))
	require.NoError(t, meter.RecordGitBytes(ctx, second, 50<<30, at))
	allowance, _, err = meter.GitBytesAllowance(ctx, second)
	require.NoError(t, err)
	require.Equal(t, int64(60<<30), allowance, "the owner's 10 GiB left plus the repository's own 50 GiB")
	allowance, _, err = meter.GitBytesAllowance(ctx, first)
	require.NoError(t, err)
	require.Equal(t, int64(50<<30), allowance)
	perRepository, err := queries.SumStorageBytesByRepository(ctx, first)
	require.NoError(t, err)
	require.Equal(t, int64(40<<30), perRepository)

	require.NoError(t, meter.RecordGitBytes(ctx, first, 1<<30, at.Add(-time.Second)))
	require.NoError(t, meter.RecordGitBytes(ctx, first, 40<<30+1, at))
	perRepository, err = queries.SumStorageBytesByRepository(ctx, first)
	require.NoError(t, err)
	require.Equal(t, int64(40<<30), perRepository, "an older or same-instant measurement never replaces the stored one")

	require.NoError(t, meter.RecordGitBytes(ctx, first, freeStorage, at.Add(time.Second)))
	allowance, _, err = meter.GitBytesAllowance(ctx, second)
	require.NoError(t, err)
	require.Zero(t, allowance, "an owner over the limit by more than the repository holds may add nothing")
}
