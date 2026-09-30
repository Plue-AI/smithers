package cleanup

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

type mockCleanupStore struct {
	mu sync.Mutex

	calls []string

	deleteExpiredSessionsFn           func(context.Context) error
	deleteExpiredNoncesFn             func(context.Context) error
	deleteExpiredOAuthStatesFn        func(context.Context) error
	deleteExpiredVerificationTokensFn func(context.Context) error
	deleteExpiredAccessTokensFn       func(context.Context) (int64, error)
}

func (m *mockCleanupStore) DeleteExpiredSessions(ctx context.Context) error {
	m.mu.Lock()
	m.calls = append(m.calls, "sessions")
	m.mu.Unlock()
	if m.deleteExpiredSessionsFn != nil {
		return m.deleteExpiredSessionsFn(ctx)
	}
	return nil
}

func (m *mockCleanupStore) DeleteExpiredNonces(ctx context.Context) error {
	m.mu.Lock()
	m.calls = append(m.calls, "nonces")
	m.mu.Unlock()
	if m.deleteExpiredNoncesFn != nil {
		return m.deleteExpiredNoncesFn(ctx)
	}
	return nil
}

func (m *mockCleanupStore) DeleteExpiredOAuthStates(ctx context.Context) error {
	m.mu.Lock()
	m.calls = append(m.calls, "oauth_states")
	m.mu.Unlock()
	if m.deleteExpiredOAuthStatesFn != nil {
		return m.deleteExpiredOAuthStatesFn(ctx)
	}
	return nil
}

func (m *mockCleanupStore) DeleteExpiredVerificationTokens(ctx context.Context) error {
	m.mu.Lock()
	m.calls = append(m.calls, "verification_tokens")
	m.mu.Unlock()
	if m.deleteExpiredVerificationTokensFn != nil {
		return m.deleteExpiredVerificationTokensFn(ctx)
	}
	return nil
}

func (m *mockCleanupStore) DeleteExpiredSSETickets(ctx context.Context) error {
	m.mu.Lock()
	m.calls = append(m.calls, "sse_tickets")
	m.mu.Unlock()
	return nil
}

func (m *mockCleanupStore) DeleteExpiredAccessTokens(ctx context.Context) (int64, error) {
	m.mu.Lock()
	m.calls = append(m.calls, "access_tokens")
	m.mu.Unlock()
	if m.deleteExpiredAccessTokensFn != nil {
		return m.deleteExpiredAccessTokensFn(ctx)
	}
	return 0, nil
}

func (m *mockCleanupStore) callSnapshot() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.calls))
	copy(out, m.calls)
	return out
}

type fakeTicker struct {
	ch        chan time.Time
	stopCalls int32
}

type oauth2ExpiryCleanupStore struct {
	*mockCleanupStore
	expired []db.Oauth2AccessToken
}

func (s *oauth2ExpiryCleanupStore) DeleteExpiredOAuth2AccessTokens(context.Context) ([]db.Oauth2AccessToken, error) {
	return s.expired, nil
}

type cleanupRecordingPublisher struct {
	events chan revocation.Event
}

func (p *cleanupRecordingPublisher) Publish(_ context.Context, event revocation.Event) error {
	p.events <- event
	return nil
}

func TestAuthCleanerSweepPublishesExpiredOAuth2TokenHashes(t *testing.T) {
	t.Parallel()
	store := &oauth2ExpiryCleanupStore{
		mockCleanupStore: &mockCleanupStore{},
		expired:          []db.Oauth2AccessToken{{ID: 8, UserID: 5, TokenHash: "expired-oauth-hash"}},
	}
	publisher := &cleanupRecordingPublisher{events: make(chan revocation.Event, 1)}
	cleaner := NewAuthCleaner(store, time.Minute)
	cleaner.SetRevocationPublisher(publisher)

	require.NoError(t, cleaner.sweep(context.Background()))
	select {
	case event := <-publisher.events:
		require.Equal(t, revocation.KindTokenRevoked, event.Kind)
		require.Equal(t, int64(8), event.TokenID)
		require.Equal(t, int64(5), event.UserID)
		require.Equal(t, "expired-oauth-hash", event.TokenHash)
	case <-time.After(time.Second):
		t.Fatal("expired OAuth2 token revocation was not published within the bound")
	}
}

func (t *fakeTicker) Chan() <-chan time.Time {
	return t.ch
}

func (t *fakeTicker) Stop() {
	atomic.AddInt32(&t.stopCalls, 1)
}

func (t *fakeTicker) StopCalls() int {
	return int(atomic.LoadInt32(&t.stopCalls))
}

func waitForCondition(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}

func TestAuthCleanerSweep_CallsAllDeleteQueries(t *testing.T) {
	t.Parallel()

	store := &mockCleanupStore{}
	cleaner := NewAuthCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.NoError(t, err)
	assert.Equal(t, []string{"sessions", "nonces", "oauth_states", "verification_tokens", "sse_tickets", "access_tokens"}, store.callSnapshot())
}

func TestAuthCleanerSweep_ContinuesOnPartialErrors(t *testing.T) {
	t.Parallel()

	store := &mockCleanupStore{
		deleteExpiredNoncesFn:      func(context.Context) error { return errors.New("nonces failed") },
		deleteExpiredOAuthStatesFn: func(context.Context) error { return errors.New("oauth states failed") },
	}
	cleaner := NewAuthCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "delete expired nonces")
	assert.Contains(t, err.Error(), "delete expired oauth states")
	assert.Equal(t, []string{"sessions", "nonces", "oauth_states", "verification_tokens", "sse_tickets", "access_tokens"}, store.callSnapshot())
}

func TestAuthCleanerSweep_RespectsContext(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	store := &mockCleanupStore{
		deleteExpiredSessionsFn: func(got context.Context) error {
			assert.Same(t, ctx, got)
			return got.Err()
		},
		deleteExpiredNoncesFn: func(got context.Context) error {
			assert.Same(t, ctx, got)
			return got.Err()
		},
		deleteExpiredOAuthStatesFn: func(got context.Context) error {
			assert.Same(t, ctx, got)
			return got.Err()
		},
		deleteExpiredVerificationTokensFn: func(got context.Context) error {
			assert.Same(t, ctx, got)
			return got.Err()
		},
		deleteExpiredAccessTokensFn: func(got context.Context) (int64, error) {
			assert.Same(t, ctx, got)
			return 0, got.Err()
		},
	}

	cleaner := NewAuthCleaner(store, time.Minute)
	err := cleaner.sweep(ctx)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, []string{"sessions", "nonces", "oauth_states", "verification_tokens", "sse_tickets", "access_tokens"}, store.callSnapshot())
}

func TestAuthCleanerLifecycle_TickerRunsSweep(t *testing.T) {
	t.Parallel()

	store := &mockCleanupStore{}
	cleaner := NewAuthCleaner(store, time.Hour)

	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner.newTicker = func(time.Duration) ticker {
		return ft
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cleaner.Start(ctx)
	ft.ch <- time.Now()

	waitForCondition(t, 500*time.Millisecond, func() bool {
		return len(store.callSnapshot()) == 6
	})

	cleaner.Stop()
	cleaner.Wait()

	assert.Equal(t, 1, ft.StopCalls())
	assert.Equal(t, []string{"sessions", "nonces", "oauth_states", "verification_tokens", "sse_tickets", "access_tokens"}, store.callSnapshot())
}

func TestAuthCleanerLifecycle_StopBlocksUntilSweepCompletes(t *testing.T) {
	t.Parallel()

	sweepEntered := make(chan struct{})
	releaseSweep := make(chan struct{})

	store := &mockCleanupStore{
		deleteExpiredSessionsFn: func(context.Context) error {
			close(sweepEntered)
			<-releaseSweep
			return nil
		},
	}
	cleaner := NewAuthCleaner(store, time.Hour)

	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner.newTicker = func(time.Duration) ticker {
		return ft
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleaner.Start(ctx)
	ft.ch <- time.Now()

	<-sweepEntered

	stopped := make(chan struct{})
	go func() {
		cleaner.Stop()
		close(stopped)
	}()

	select {
	case <-stopped:
		t.Fatal("Stop returned before in-flight sweep completed")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseSweep)

	select {
	case <-stopped:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Stop did not return after sweep completed")
	}
}

func TestAuthCleanerLifecycle_ContextCancelExitsLoop(t *testing.T) {
	t.Parallel()

	store := &mockCleanupStore{}
	cleaner := NewAuthCleaner(store, time.Hour)

	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner.newTicker = func(time.Duration) ticker {
		return ft
	}

	ctx, cancel := context.WithCancel(context.Background())
	cleaner.Start(ctx)
	cancel()

	done := make(chan struct{})
	go func() {
		cleaner.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Wait did not unblock after context cancellation")
	}
}

func TestCleanupStoreInterfaceCompliance(t *testing.T) {
	t.Parallel()
	var _ CleanupStore = (*db.Queries)(nil)
}

func TestAuthCleanerSweep_AccessTokenPruneErrorSurfaces(t *testing.T) {
	t.Parallel()

	store := &mockCleanupStore{
		deleteExpiredAccessTokensFn: func(context.Context) (int64, error) {
			return 0, errors.New("access tokens failed")
		},
	}
	cleaner := NewAuthCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "delete expired access tokens")
}

func TestAuthCleanerSweep_AccessTokenPruneCountIsNotAnError(t *testing.T) {
	t.Parallel()

	// A bounded prune reporting deleted rows is a success, not an error; the
	// count is logged, and the rest of the sweep proceeds.
	store := &mockCleanupStore{
		deleteExpiredAccessTokensFn: func(context.Context) (int64, error) {
			return 42, nil
		},
	}
	cleaner := NewAuthCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.NoError(t, err)
	assert.Contains(t, store.callSnapshot(), "access_tokens")
}

type oauth2GrantCleanupStore struct {
	*mockCleanupStore
	codes, refresh int
}

func (s *oauth2GrantCleanupStore) DeleteExpiredOAuth2AuthorizationCodes(context.Context) error {
	s.codes++
	return nil
}

func (s *oauth2GrantCleanupStore) DeleteExpiredOAuth2RefreshTokens(context.Context) error {
	s.refresh++
	return errors.New("refresh boom")
}

// The production store must satisfy the optional grant cleanup seam, or the
// sweep silently skips expired codes and refresh tokens.
var _ expiredOAuth2GrantStore = (*db.Queries)(nil)

func TestAuthCleanerSweepDeletesExpiredOAuth2Grants(t *testing.T) {
	t.Parallel()
	store := &oauth2GrantCleanupStore{mockCleanupStore: &mockCleanupStore{}}
	err := NewAuthCleaner(store, time.Minute).sweep(context.Background())
	require.ErrorContains(t, err, "refresh boom")
	assert.Equal(t, 1, store.codes)
	assert.Equal(t, 1, store.refresh)
}
