package email

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

type rejectingProvider struct{}

func (rejectingProvider) Send(context.Context, Message) error {
	return errors.New("provider unavailable")
}

type acceptingProvider struct{}

func (acceptingProvider) Send(context.Context, Message) error { return nil }

// recipientLimitPools creates independent connections to one isolated database.
// Applying the production migration keeps these tests coupled to the deployed
// schema, including its constraints and indexes.
func recipientLimitPools(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	url := testdb.New(t).URL
	ctx := context.Background()
	first, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	t.Cleanup(first.Close)
	second, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	t.Cleanup(second.Close)
	migration, err := os.ReadFile("../../db/product/migrations/0072_email_recipient_rate_limits.sql")
	require.NoError(t, err)
	_, err = first.Exec(ctx, string(migration))
	require.NoError(t, err)
	return first, second
}

func recipientCount(t *testing.T, pool *pgxpool.Pool, address string) int64 {
	t.Helper()
	var count int64
	require.NoError(t, pool.QueryRow(context.Background(),
		"SELECT count FROM email_recipient_rate_limits WHERE recipient = $1", address).Scan(&count))
	return count
}

func TestRateLimitedTransport_ConcurrentSharedBudget(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	const attempts = 24
	const limit = 7
	var transports [attempts]Transport
	var inners [attempts]*NoopTransport
	for i := range transports {
		inners[i] = &NoopTransport{}
		pool := firstPool
		if i%2 == 1 {
			pool = secondPool
		}
		transports[i] = NewRateLimitedTransport(inners[i], RateLimitConfig{
			MaxPerRecipientPerHour: limit,
			RecipientPool:          pool,
		})
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan error, attempts)
	for i := range transports {
		wg.Add(1)
		go func(tr Transport) {
			defer wg.Done()
			<-start
			results <- tr.Send(context.Background(), Message{To: []string{"shared@example.com"}})
		}(transports[i])
	}
	close(start)
	wg.Wait()
	close(results)
	successes, failures := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			require.ErrorContains(t, err, "per-recipient rate limit exceeded")
			failures++
		}
	}
	require.Equal(t, limit, successes)
	require.Equal(t, attempts-limit, failures)
	require.EqualValues(t, limit, recipientCount(t, firstPool, "shared@example.com"))
	delivered := 0
	for _, inner := range inners {
		delivered += len(inner.Sent)
	}
	require.Equal(t, limit, delivered)
}

func TestRateLimitedTransport_MultiRecipientAdmissionIsAtomic(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	first := NewRateLimitedTransport(&NoopTransport{}, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: firstPool,
	})
	inner := &NoopTransport{}
	second := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: secondPool,
	})
	require.NoError(t, first.Send(context.Background(), Message{To: []string{"z-blocked@example.com"}}))
	require.ErrorContains(t, second.Send(context.Background(), Message{
		To: []string{"a-free@example.com", "z-blocked@example.com"},
	}), "per-recipient rate limit exceeded")
	require.Empty(t, inner.Sent)
	var freeRows int
	require.NoError(t, firstPool.QueryRow(context.Background(),
		"SELECT count(*) FROM email_recipient_rate_limits WHERE recipient = 'a-free@example.com'").Scan(&freeRows))
	require.Zero(t, freeRows, "a rejected multi-recipient message must roll back all reservations")
	require.NoError(t, second.Send(context.Background(), Message{To: []string{"a-free@example.com"}}))
	require.EqualValues(t, 1, recipientCount(t, firstPool, "a-free@example.com"))
}

func TestRateLimitedTransport_RecipientWindowExpires(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	first := NewRateLimitedTransport(&NoopTransport{}, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: firstPool,
	})
	second := NewRateLimitedTransport(&NoopTransport{}, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: secondPool,
	})
	msg := Message{To: []string{"expired@example.com"}}
	require.NoError(t, first.Send(context.Background(), msg))
	require.ErrorContains(t, second.Send(context.Background(), msg), "per-recipient rate limit exceeded")
	_, err := firstPool.Exec(context.Background(),
		"UPDATE email_recipient_rate_limits SET reset_at = $1 WHERE recipient = $2",
		time.Now().Add(-time.Minute), "expired@example.com")
	require.NoError(t, err)
	require.NoError(t, second.Send(context.Background(), msg))
	require.EqualValues(t, 1, recipientCount(t, firstPool, "expired@example.com"))
}

func TestRateLimitedTransport_FailsClosedWithoutRecipientStore(t *testing.T) {
	inner := &NoopTransport{}
	missing := NewRateLimitedTransport(inner, RateLimitConfig{MaxPerRecipientPerHour: 1})
	require.Error(t, missing.Send(context.Background(), Message{To: []string{"user@example.com"}}))
	require.Empty(t, inner.Sent)

	firstPool, _ := recipientLimitPools(t)
	closed := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: firstPool,
	})
	firstPool.Close()
	require.Error(t, closed.Send(context.Background(), Message{To: []string{"user@example.com"}}))
	require.Empty(t, inner.Sent)
}

func TestRateLimitedTransport_CancelledReservationPreservesLocalToken(t *testing.T) {
	pool, _ := recipientLimitPools(t)
	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerSecond: 1, MaxPerRecipientPerHour: 1, RecipientPool: pool,
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.Error(t, tr.Send(ctx, Message{To: []string{"user@example.com"}}))
	require.Empty(t, inner.Sent)
	require.NoError(t, tr.Send(context.Background(), Message{To: []string{"user@example.com"}}))
	require.EqualValues(t, 1, recipientCount(t, pool, "user@example.com"))
	require.Len(t, inner.Sent, 1)
}

func TestRateLimitedTransport_ProviderFailureRetainsSharedQuota(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	first := NewRateLimitedTransport(rejectingProvider{}, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: firstPool,
	})
	secondInner := &NoopTransport{}
	second := NewRateLimitedTransport(secondInner, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: secondPool,
	})
	msg := Message{To: []string{"user@example.com"}}
	require.ErrorContains(t, first.Send(context.Background(), msg), "provider unavailable")
	require.EqualValues(t, 1, recipientCount(t, secondPool, "user@example.com"))
	require.ErrorContains(t, second.Send(context.Background(), msg), "per-recipient rate limit exceeded")
	require.Empty(t, secondInner.Sent)
}

func TestRateLimitedTransport_ConcurrentReversedRecipientOrder(t *testing.T) {
	firstPool, secondPool := recipientLimitPools(t)
	const attempts = 20
	const limit = 5
	first := NewRateLimitedTransport(acceptingProvider{}, RateLimitConfig{
		MaxPerRecipientPerHour: limit, RecipientPool: firstPool,
	})
	second := NewRateLimitedTransport(acceptingProvider{}, RateLimitConfig{
		MaxPerRecipientPerHour: limit, RecipientPool: secondPool,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan error, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		tr := first
		to := []string{"alpha@example.com", "zulu@example.com"}
		if i%2 == 1 {
			tr = second
			to = []string{"zulu@example.com", "alpha@example.com"}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- tr.Send(ctx, Message{To: to})
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	require.NoError(t, ctx.Err(), "recipient lock ordering must avoid deadlock")
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			require.ErrorContains(t, err, "per-recipient rate limit exceeded")
		}
	}
	require.Equal(t, limit, successes)
	require.EqualValues(t, limit, recipientCount(t, firstPool, "alpha@example.com"))
	require.EqualValues(t, limit, recipientCount(t, secondPool, "zulu@example.com"))
}

func TestRateLimitedTransport_BlockedRecipientDoesNotStallUnrelatedSend(t *testing.T) {
	sendPool, lockPool := recipientLimitPools(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := lockPool.Exec(ctx, `
		INSERT INTO email_recipient_rate_limits (recipient, count, reset_at)
		VALUES ('locked@example.com', 1, NOW() + INTERVAL '1 hour')`)
	require.NoError(t, err)
	lockTx, err := lockPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = lockTx.Rollback(context.Background()) }()
	_, err = lockTx.Exec(ctx, `
		UPDATE email_recipient_rate_limits SET count = count
		WHERE recipient = 'locked@example.com'`)
	require.NoError(t, err)

	tr := NewRateLimitedTransport(acceptingProvider{}, RateLimitConfig{
		MaxPerRecipientPerHour: 2, RecipientPool: sendPool,
	})
	lockedResult := make(chan error, 1)
	go func() {
		lockedResult <- tr.Send(ctx, Message{To: []string{"locked@example.com"}})
	}()

	// Verify the first send reached PostgreSQL and is waiting on our row lock.
	deadline := time.Now().Add(3 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var waiting int
		err = lockPool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database()
			AND wait_event_type = 'Lock'
			AND query LIKE '%INSERT INTO email_recipient_rate_limits%'`).Scan(&waiting)
		require.NoError(t, err)
		if waiting > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		_ = lockTx.Rollback(context.Background())
		t.Fatal("first send never waited on the locked recipient row")
	}

	freeResult := make(chan error, 1)
	go func() {
		freeResult <- tr.Send(ctx, Message{To: []string{"free@example.com"}})
	}()
	select {
	case err := <-freeResult:
		require.NoError(t, err)
	case <-time.After(time.Second):
		_ = lockTx.Rollback(context.Background())
		<-lockedResult
		<-freeResult
		t.Fatal("unrelated recipient was stalled by another send's database lock")
	}
	require.NoError(t, lockTx.Rollback(context.Background()))
	require.NoError(t, <-lockedResult)
	require.EqualValues(t, 1, recipientCount(t, sendPool, "free@example.com"))
	require.EqualValues(t, 2, recipientCount(t, sendPool, "locked@example.com"))
}

func TestRateLimitedTransport_RejectsBlankRecipient(t *testing.T) {
	pool, _ := recipientLimitPools(t)
	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 1, RecipientPool: pool,
	})
	require.Error(t, tr.Send(context.Background(), Message{To: []string{"   "}}))
	require.Empty(t, inner.Sent)
	var rows int
	require.NoError(t, pool.QueryRow(context.Background(),
		"SELECT count(*) FROM email_recipient_rate_limits").Scan(&rows))
	require.Zero(t, rows)
}

func TestRateLimitedTransport_RecipientAdmissionWaitIsBounded(t *testing.T) {
	sendPool, lockPool := recipientLimitPools(t)
	_, err := lockPool.Exec(context.Background(), `
		INSERT INTO email_recipient_rate_limits (recipient, count, reset_at)
		VALUES ('locked@example.com', 1, NOW() + INTERVAL '1 hour')`)
	require.NoError(t, err)
	lockTx, err := lockPool.Begin(context.Background())
	require.NoError(t, err)
	defer func() { _ = lockTx.Rollback(context.Background()) }()
	_, err = lockTx.Exec(context.Background(), `
		UPDATE email_recipient_rate_limits SET count = count
		WHERE recipient = 'locked@example.com'`)
	require.NoError(t, err)
	inner := &NoopTransport{}
	tr := NewRateLimitedTransport(inner, RateLimitConfig{
		MaxPerRecipientPerHour: 2, RecipientPool: sendPool,
	})
	result := make(chan error, 1)
	go func() {
		result <- tr.Send(context.Background(), Message{To: []string{"locked@example.com"}})
	}()
	select {
	case err := <-result:
		require.Error(t, err)
	case <-time.After(8 * time.Second):
		_ = lockTx.Rollback(context.Background())
		<-result
		t.Fatal("recipient admission waited indefinitely on a database row lock")
	}
	require.Empty(t, inner.Sent)
	require.NoError(t, lockTx.Rollback(context.Background()))
	require.EqualValues(t, 1, recipientCount(t, sendPool, "locked@example.com"))
}

func TestRateLimitedTransport_OldWindowRefusalDoesNotRefundNewWindow(t *testing.T) {
	sendPool, lockPool := recipientLimitPools(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := lockPool.Exec(ctx, `
		INSERT INTO email_recipient_rate_limits (recipient, count, reset_at)
		VALUES ('at-cap@example.com', 1, NOW() + INTERVAL '1 hour')`)
	require.NoError(t, err)
	lockTx, err := lockPool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = lockTx.Rollback(context.Background()) }()
	_, err = lockTx.Exec(ctx, `
		UPDATE email_recipient_rate_limits SET count = count
		WHERE recipient = 'at-cap@example.com'`)
	require.NoError(t, err)

	tr := NewRateLimitedTransport(acceptingProvider{}, RateLimitConfig{
		MaxPerSecond: 1, MaxPerRecipientPerHour: 1, RecipientPool: sendPool,
	}).(*RateLimitedTransport)
	oldResult := make(chan error, 1)
	go func() {
		oldResult <- tr.Send(ctx, Message{To: []string{"at-cap@example.com"}})
	}()
	deadline := time.Now().Add(3 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var waiting int
		err = lockPool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database()
			AND wait_event_type = 'Lock'
			AND query LIKE '%INSERT INTO email_recipient_rate_limits%'`).Scan(&waiting)
		require.NoError(t, err)
		if waiting > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		_ = lockTx.Rollback(context.Background())
		t.Fatal("old-window reservation never waited on the locked row")
	}

	// Advance only the local one-second window; the first reservation still
	// carries the previous window's token while it waits on PostgreSQL.
	tr.mu.Lock()
	tr.lastReset = time.Now().Add(-2 * time.Second)
	tr.mu.Unlock()
	require.NoError(t, tr.Send(ctx, Message{To: []string{"new-window@example.com"}}))
	require.NoError(t, lockTx.Rollback(context.Background()))
	require.ErrorContains(t, <-oldResult, "per-recipient rate limit exceeded")
	require.ErrorContains(t, tr.Send(ctx, Message{To: []string{"extra@example.com"}}), "global rate limit exceeded")
	require.EqualValues(t, 1, recipientCount(t, sendPool, "new-window@example.com"))
}
