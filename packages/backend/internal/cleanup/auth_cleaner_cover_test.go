package cleanup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// authCoverStore is a fully-configurable, thread-safe CleanupStore. Unlike the
// sibling mockCleanupStore it also lets tests inject a DeleteExpiredSSETickets
// failure, which is the one sweep branch that mock cannot reach.
type authCoverStore struct {
	mu    sync.Mutex
	calls int32

	sseFn func(context.Context) error
}

func (m *authCoverStore) DeleteExpiredSessions(ctx context.Context) error    { return nil }
func (m *authCoverStore) DeleteExpiredNonces(ctx context.Context) error      { return nil }
func (m *authCoverStore) DeleteExpiredOAuthStates(ctx context.Context) error { return nil }
func (m *authCoverStore) DeleteExpiredVerificationTokens(ctx context.Context) error {
	return nil
}

func (m *authCoverStore) DeleteExpiredSSETickets(ctx context.Context) error {
	if m.sseFn != nil {
		return m.sseFn(ctx)
	}
	return nil
}

func (m *authCoverStore) DeleteExpiredAccessTokens(ctx context.Context) (int64, error) {
	m.mu.Lock()
	m.calls++
	m.mu.Unlock()
	return 0, nil
}

func (m *authCoverStore) sweepCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return int(m.calls)
}

// TestAuthCleaner_Cover_SweepSSETicketError covers the DeleteExpiredSSETickets
// error branch in sweep, which sibling tests never exercise.
func TestAuthCleaner_Cover_SweepSSETicketError(t *testing.T) {
	t.Parallel()

	store := &authCoverStore{
		sseFn: func(context.Context) error { return errors.New("sse tickets failed") },
	}
	cleaner := NewAuthCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "delete expired sse tickets")
}

// TestAuthCleaner_Cover_RealTickerDefault exercises the default newTicker
// closure and, via the loop, realTicker.Chan and realTicker.Stop.
func TestAuthCleaner_Cover_RealTickerDefault(t *testing.T) {
	t.Parallel()

	store := &authCoverStore{}
	cleaner := NewAuthCleaner(store, 2*time.Millisecond)

	cleaner.Start(context.Background())
	waitForCondition(t, 2*time.Second, func() bool {
		return store.sweepCount() >= 1
	})

	cleaner.Stop()
	cleaner.Wait()
	require.GreaterOrEqual(t, store.sweepCount(), 1)
}

// TestAuthCleaner_Cover_DoubleStart covers the running-guard early return in
// Start (the second Start must be a no-op).
func TestAuthCleaner_Cover_DoubleStart(t *testing.T) {
	t.Parallel()

	store := &authCoverStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewAuthCleaner(store, time.Hour)
	cleaner.newTicker = func(time.Duration) ticker { return ft }

	ctx := context.Background()
	cleaner.Start(ctx)
	cleaner.Start(ctx) // second Start is a no-op

	cleaner.Stop()
	cleaner.Wait()
	assert.Equal(t, 1, ft.StopCalls())
}

// TestAuthCleaner_Cover_StopWithoutStart covers Stop's not-running early return.
func TestAuthCleaner_Cover_StopWithoutStart(t *testing.T) {
	t.Parallel()

	cleaner := NewAuthCleaner(&authCoverStore{}, time.Hour)
	// Must not panic or block.
	cleaner.Stop()
}
