package services

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"net/http"
	"strings"
	"testing"
)

func TestProviderUtilization(t *testing.T) {
	for _, tc := range []struct {
		headers http.Header
		percent float64
		valid   bool
	}{
		{http.Header{}, 0, false},
		{http.Header{"X-Codex-Primary-Used-Percent": []string{"60"}}, 60, true},
		{http.Header{"X-Codex-Primary-Used-Percent": []string{"20"}, "X-Codex-Secondary-Used-Percent": []string{"80"}}, 80, true},
		{http.Header{"Anthropic-Ratelimit-Unified-7d-Utilization": []string{"0.61"}}, 61, true},
		{http.Header{"X-Codex-Primary-Used-Percent": []string{"NaN"}}, 0, false},
		{http.Header{"X-Codex-Primary-Used-Percent": []string{"101"}}, 0, false},
	} {
		percent, ok := ProviderUsedPercent(tc.headers)
		require.Equal(t, tc.valid, ok)
		require.InDelta(t, tc.percent, percent, 0.001)
	}
}

func TestProviderUtilizationPersistsAndScopesOwner(t *testing.T) {
	pool, q, jobs, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	require.NoError(t, jobs.ReconcileFactoryRules(ctx, gateway.target.RepositoryID, strings.Repeat("a", 40), factoryFixture(t)))
	_, err := pool.Exec(ctx, "UPDATE repository_job_registrations SET next_fire_at=now()-interval '1 minute' WHERE repository_id=$1 AND schedule<>''", gateway.target.RepositoryID)
	require.NoError(t, err)
	owner := pgtype.Int8{Int64: gateway.target.UserID, Valid: true}
	connection, err := q.CreateProviderConnection(ctx, db.CreateProviderConnectionParams{
		OwnerType: "user", UserID: owner, Provider: "codex", Kind: "oauth",
		AccessTokenEncrypted: []byte("test"), CreatedBy: owner,
	})
	require.NoError(t, err)
	meter := &ProviderConnectionService{q: q}
	require.NoError(t, meter.RecordUsage(ctx, connection.ID, http.Header{"X-Codex-Primary-Used-Percent": []string{"59.9"}}))
	due, err := q.ListDueRepositoryJobSchedules(ctx, 50)
	require.NoError(t, err)
	require.Len(t, due, 1)
	paused, err := jobs.ownerAutonomyPaused(ctx, owner.Int64)
	require.NoError(t, err)
	require.False(t, paused)
	require.NoError(t, meter.RecordUsage(ctx, connection.ID, http.Header{"X-Codex-Primary-Used-Percent": []string{"60"}}))
	due, err = q.ListDueRepositoryJobSchedules(ctx, 50)
	require.NoError(t, err)
	require.Empty(t, due, "filter before pagination so a paused owner cannot block others")
	restarted := NewRepositoryJobService(q, gateway, pool)
	paused, err = restarted.ownerAutonomyPaused(ctx, owner.Int64)
	require.NoError(t, err)
	require.True(t, paused)
	paused, err = restarted.ownerAutonomyPaused(ctx, owner.Int64+9999)
	require.NoError(t, err)
	require.False(t, paused)
	require.NoError(t, meter.RecordUsage(ctx, connection.ID, http.Header{}))
	paused, err = restarted.ownerAutonomyPaused(ctx, owner.Int64)
	require.NoError(t, err)
	require.True(t, paused, "missing observation must not fabricate a reset")
	require.NoError(t, meter.RecordUsage(ctx, connection.ID, http.Header{"X-Codex-Primary-Used-Percent": []string{"5"}}))
	paused, err = restarted.ownerAutonomyPaused(ctx, owner.Int64)
	require.NoError(t, err)
	require.False(t, paused)
}
