package credits

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestFastQuotaConcurrentAdmissionRecoveryAndCredentialIsolationPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var owner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('quota-owner','quota-owner') RETURNING id`).Scan(&owner))
	now := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	quota := FastQuota{DB: pool, DailyTokens: 100, Now: func() time.Time { return now }}
	install := uuid.NewString()
	token, err := quota.Issue(ctx, owner, install)
	require.NoError(t, err)
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- quota.Execute(ctx, install, token, 80, func() (int64, bool, error) { close(entered); <-release; return 30, true, nil })
	}()
	<-entered
	var upstream atomic.Int64
	err = quota.Execute(ctx, install, token, 21, func() (int64, bool, error) { upstream.Add(1); return 1, true, nil })
	require.ErrorIs(t, err, ErrFastCapacity)
	require.Zero(t, upstream.Load())
	left, err := quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.EqualValues(t, 20, left)
	// A recreated meter sees the durable pending reservation.
	recreated := FastQuota{DB: pool, DailyTokens: 100, Now: quota.Now}
	require.ErrorIs(t, recreated.Execute(ctx, install, token, 21, func() (int64, bool, error) { t.Error("pending reservation lost on restart"); return 0, true, nil }), ErrFastCapacity)
	// Revocation does not cancel an admitted provider call, but refuses the next.
	require.NoError(t, quota.Revoke(ctx, owner, install))
	require.ErrorIs(t, quota.Execute(ctx, install, token, 1, func() (int64, bool, error) { t.Error("revoked credential spent"); return 0, true, nil }), ErrInstallCredential)
	close(release)
	require.NoError(t, <-done)
	rotated, err := quota.Issue(ctx, owner, install)
	require.NoError(t, err)
	require.NotEqual(t, token, rotated)
	require.ErrorIs(t, quota.Verify(ctx, install, token), ErrInstallCredential)
	left, err = recreated.Remaining(ctx, install, rotated)
	require.NoError(t, err)
	require.EqualValues(t, 70, left)
	// Definite failures release capacity, ambiguous outcomes keep the bound.
	failure := errors.New("provider refused before execution")
	require.ErrorIs(t, quota.Execute(ctx, install, rotated, 70, func() (int64, bool, error) { return 0, true, failure }), failure)
	require.NoError(t, quota.Execute(ctx, install, rotated, 70, func() (int64, bool, error) { return 0, false, nil }))
	left, err = quota.Remaining(ctx, install, rotated)
	require.NoError(t, err)
	require.Zero(t, left)
	// The UTC day boundary restores exactly the quota; the old day is exported.
	now = now.Add(24 * time.Hour)
	left, err = quota.Remaining(ctx, install, rotated)
	require.NoError(t, err)
	require.EqualValues(t, 100, left)
	require.NoError(t, quota.Execute(ctx, install, rotated, 100, func() (int64, bool, error) { return 100, true, nil }))
	totals, err := quota.DailyTotals(ctx, now.Add(-24*time.Hour), now.Add(24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, []FastDailyTotal{{Install: install, Day: "2026-10-08", Tokens: 100}, {Install: install, Day: "2026-10-09", Tokens: 100}}, totals)
	other := uuid.NewString()
	otherToken, err := quota.Issue(ctx, owner, other)
	require.NoError(t, err)
	require.ErrorIs(t, quota.Verify(ctx, other, rotated), ErrInstallCredential)
	require.ErrorIs(t, quota.Verify(ctx, install, otherToken), ErrInstallCredential)
	require.NoError(t, quota.Execute(ctx, other, otherToken, 100, func() (int64, bool, error) { return 1, true, nil }))
}

func TestFastQuotaCancelledCallerSettlesOnDetachedContextPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var owner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('cancel-owner','cancel-owner') RETURNING id`).Scan(&owner))
	quota := FastQuota{DB: pool, DailyTokens: 100}
	install := uuid.NewString()
	token, err := quota.Issue(ctx, owner, install)
	require.NoError(t, err)
	cancelled, cancel := context.WithCancel(ctx)
	defer cancel()
	require.NoError(t, quota.Execute(cancelled, install, token, 100, func() (int64, bool, error) { cancel(); return 9, true, nil }))
	left, err := quota.Remaining(ctx, install, token)
	require.NoError(t, err)
	require.EqualValues(t, 91, left)
}
