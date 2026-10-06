package chat

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestProducerRenewalRechecksExpiryAfterRowLockWait(t *testing.T) {
	store, clock := clockedStore(needStore(t))
	ctx, cancel := context.WithTimeout(t.Context(), dbWait)
	defer cancel()
	scope := testScope()
	accepted := admit(t, store, scope, uuid.NewString(), testJournal())
	grant, err := store.Claim(ctx, scope, accepted.TurnID, time.Second)
	require.NoError(t, err)
	blocker, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer blocker.Rollback(context.Background())
	var blockerPID int
	require.NoError(t, blocker.QueryRow(ctx, `SELECT pg_backend_pid() FROM chat_turns WHERE id=$1 FOR UPDATE`, grant.TurnID).Scan(&blockerPID))
	result := make(chan error, 1)
	go func() {
		_, err := store.RenewProducer(ctx, grant, time.Minute)
		result <- err
	}()
	// Observe the actual database lock wait, then advance the store's clock;
	// no timing assumption about when the renewal goroutine starts is needed.
	require.Eventually(t, func() bool {
		var waiting bool
		err := store.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&waiting)
		return err == nil && waiting
	}, dbWait/2, time.Millisecond)
	clock.advance(2 * time.Second)
	require.NoError(t, blocker.Commit(ctx))
	select {
	case err := <-result:
		require.ErrorIs(t, err, ErrProducerFenced)
	case <-ctx.Done():
		t.Fatal("renewal did not finish after the row lock was released")
	}
	_, err = store.Producer(ctx, grant.TurnID, grant.Generation, grant.Token)
	require.ErrorIs(t, err, ErrProducerFenced)
}

func TestProducerRenewalCannotReviveExpiredOrReleasedLease(t *testing.T) {
	for _, tc := range []struct {
		name    string
		elapsed time.Duration
		release bool
		live    bool
	}{
		{"before expiry", time.Second - time.Microsecond, false, true},
		{"at expiry", time.Second, false, false},
		{"after expiry", time.Second + time.Microsecond, false, false},
		{"released", 0, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, clock := clockedStore(needStore(t))
			clock.now = clock.now.Truncate(time.Microsecond)
			ctx, scope := t.Context(), testScope()
			accepted := admit(t, store, scope, uuid.NewString(), testJournal())
			grant, err := store.Claim(ctx, scope, accepted.TurnID, time.Second)
			require.NoError(t, err)
			clock.advance(tc.elapsed)
			if tc.release {
				require.NoError(t, store.ReleaseProducer(ctx, grant))
			}
			var previous time.Time
			require.NoError(t, store.pool.QueryRow(ctx, `SELECT producer_lease_expires_at FROM chat_turns WHERE id=$1`, grant.TurnID).Scan(&previous))
			expires, err := store.RenewProducer(ctx, grant, time.Minute)
			if tc.live {
				require.NoError(t, err)
				require.Equal(t, clock.Now().UTC().Add(time.Minute), expires)
				clock.advance(time.Second)
				_, err = store.Producer(ctx, grant.TurnID, grant.Generation, grant.Token)
				require.NoError(t, err, "timely renewal keeps the producer alive past its original deadline")
				return
			}
			require.ErrorIs(t, err, ErrProducerFenced)
			require.True(t, expires.IsZero())
			var after time.Time
			require.NoError(t, store.pool.QueryRow(ctx, `SELECT producer_lease_expires_at FROM chat_turns WHERE id=$1`, grant.TurnID).Scan(&after))
			require.True(t, previous.Equal(after), "refused renewal must not alter the recorded lease")
			_, err = store.Producer(ctx, grant.TurnID, grant.Generation, grant.Token)
			require.ErrorIs(t, err, ErrProducerFenced)
			require.True(t, recoveryHas(t, store, grant.TurnID))
			replacement, err := store.Claim(ctx, scope, accepted.TurnID, time.Minute)
			require.NoError(t, err)
			require.Equal(t, grant.Generation+1, replacement.Generation)
			_, err = store.RenewProducer(ctx, grant, time.Minute)
			require.ErrorIs(t, err, ErrProducerFenced, "old generation must remain fenced after recovery")
		})
	}
}
