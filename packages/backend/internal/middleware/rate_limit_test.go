package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type bucketState struct {
	tokens     float64
	lastRefill time.Time
}

type mockRateLimitStore struct {
	mu       sync.Mutex
	buckets  map[string]bucketState
	keysSeen []string
}

func (m *mockRateLimitStore) ConsumeSearchRateLimitToken(_ context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.buckets == nil {
		m.buckets = make(map[string]bucketState)
	}

	key := arg.Scope + "|" + arg.PrincipalKey
	m.keysSeen = append(m.keysSeen, key)

	state, ok := m.buckets[key]
	if !ok {
		state = bucketState{
			tokens:     float64(arg.Capacity),
			lastRefill: arg.NowAt,
		}
	}

	elapsedSeconds := arg.NowAt.Sub(state.lastRefill).Seconds()
	if elapsedSeconds > 0 {
		state.tokens += elapsedSeconds * arg.RefillPerSecond
	}
	if state.tokens > float64(arg.Capacity) {
		state.tokens = float64(arg.Capacity)
	}

	allowed := state.tokens >= 1
	if allowed {
		state.tokens -= 1
	}
	state.lastRefill = arg.NowAt
	m.buckets[key] = state

	return db.ConsumeSearchRateLimitTokenRow{
		Allowed:         allowed,
		RemainingTokens: state.tokens,
		NowAt:           arg.NowAt,
	}, nil
}

func (m *mockRateLimitStore) DeleteExpiredSearchRateLimits(_ context.Context, cutoffAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for key, state := range m.buckets {
		if state.lastRefill.Before(cutoffAt) {
			delete(m.buckets, key)
		}
	}
	return nil
}

func TestSearchRateLimit_EnforcesLimit(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 30, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 30; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=auth", nil)
		req.RemoteAddr = "203.0.113.10:12345"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=auth", nil)
	req.RemoteAddr = "203.0.113.10:12345"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "30", rec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))

	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "rate limit exceeded", payload["message"])
}

func TestAuthRateLimit_EnforcesLimit(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewAuthRateLimit(store, 2, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", nil)
		req.RemoteAddr = "203.0.113.11:12345"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", nil)
	req.RemoteAddr = "203.0.113.11:12345"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "2", rec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
	assert.Contains(t, store.keysSeen, "auth|ip:203.0.113.11")
}

// Pin token-store time so burst assertions do not depend on runner scheduling.
type fixedTimeRateLimitStore struct {
	mockRateLimitStore
	now time.Time
}

func (m *fixedTimeRateLimitStore) ConsumeSearchRateLimitToken(ctx context.Context, arg db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	arg.NowAt = m.now
	return m.mockRateLimitStore.ConsumeSearchRateLimitToken(ctx, arg)
}

func TestSSETicketRateLimit_IsolatesConnectionsByUserAndFromCredentials(t *testing.T) {
	t.Parallel()

	store := &fixedTimeRateLimitStore{now: time.Now().UTC()}
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	tickets := RequireAuth(SSETicketRateLimit(store)(ok))
	credentials := AuthRateLimit(store)(ok)
	request := func(handler http.Handler, userID int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/sse-ticket", nil)
		req.RemoteAddr = "203.0.113.11:12345"
		if userID != 0 {
			req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: userID}}))
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// Anonymous callers never consume the authenticated connection bucket.
	require.Equal(t, http.StatusUnauthorized, request(tickets, 0).Code)
	require.Empty(t, store.keysSeen)
	// Credential attempts retain their five-request limit.
	for i := 0; i < 5; i++ {
		require.Equal(t, http.StatusNoContent, request(credentials, 1).Code)
	}
	require.Equal(t, http.StatusTooManyRequests, request(credentials, 1).Code)
	// Stream subscriptions, terminal sockets and reconnects have their own budget.
	for i := 0; i < 60; i++ {
		rec := request(tickets, 1)
		require.Equal(t, http.StatusNoContent, rec.Code, "ticket %d", i+1)
		require.Equal(t, "60", rec.Header().Get("X-RateLimit-Limit"))
	}
	rec := request(tickets, 1)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	require.NotEmpty(t, rec.Header().Get("Retry-After"))
	require.Equal(t, http.StatusNoContent, request(tickets, 2).Code, "another user on the same IP has a separate budget")
	require.Equal(t, http.StatusTooManyRequests, request(credentials, 1).Code)
	assert.Contains(t, store.keysSeen, "sse_ticket|user:1")
	assert.Contains(t, store.keysSeen, "sse_ticket|user:2")
}

func TestSSETicketRateLimit_StoreErrorFailsClosed(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	called := false
	handler := SSETicketRateLimit(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/auth/sse-ticket", nil))
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.False(t, called)
	require.Equal(t, "1", rec.Header().Get("Retry-After"))
}

func TestRateLimit_ScopeIsolation(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	searchMW := NewSearchRateLimit(store, 1, time.Minute)
	authMW := NewAuthRateLimit(store, 1, time.Minute)

	searchHandler := searchMW(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	authHandler := authMW(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	searchReq1 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	searchReq1.RemoteAddr = "192.0.2.200:8080"
	searchRec1 := httptest.NewRecorder()
	searchHandler.ServeHTTP(searchRec1, searchReq1)
	require.Equal(t, http.StatusNoContent, searchRec1.Code)

	authReq1 := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", nil)
	authReq1.RemoteAddr = "192.0.2.200:8080"
	authRec1 := httptest.NewRecorder()
	authHandler.ServeHTTP(authRec1, authReq1)
	require.Equal(t, http.StatusNoContent, authRec1.Code)

	searchReq2 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	searchReq2.RemoteAddr = "192.0.2.200:8080"
	searchRec2 := httptest.NewRecorder()
	searchHandler.ServeHTTP(searchRec2, searchReq2)
	require.Equal(t, http.StatusTooManyRequests, searchRec2.Code)

	authReq2 := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", nil)
	authReq2.RemoteAddr = "192.0.2.200:8080"
	authRec2 := httptest.NewRecorder()
	authHandler.ServeHTTP(authRec2, authReq2)
	require.Equal(t, http.StatusTooManyRequests, authRec2.Code)

	assert.Contains(t, store.keysSeen, "search|ip:192.0.2.200")
	assert.Contains(t, store.keysSeen, "auth|ip:192.0.2.200")
}

func TestSearchRateLimit_UsesUserIDWhenAuthenticatedElseRemoteAddr(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 1, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=auth", nil)
	anonReq.RemoteAddr = "198.51.100.4:8080"
	anonReq.Header.Set("X-Forwarded-For", "192.0.2.9")
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)

	anonReq2 := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=auth", nil)
	anonReq2.RemoteAddr = "198.51.100.4:8080"
	anonRec2 := httptest.NewRecorder()
	handler.ServeHTTP(anonRec2, anonReq2)
	require.Equal(t, http.StatusTooManyRequests, anonRec2.Code)

	authReq := httptest.NewRequest(http.MethodGet, "/api/search/repositories?q=auth", nil)
	authReq.RemoteAddr = "198.51.100.4:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 22, Username: "alice", LowerUsername: "alice"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusNoContent, authRec.Code)

	require.GreaterOrEqual(t, len(store.keysSeen), 3)
	assert.Contains(t, store.keysSeen, "search|ip:198.51.100.4")
	assert.Contains(t, store.keysSeen, "search|user:22")
	assert.NotContains(t, store.keysSeen, "search|ip:192.0.2.9")
}

func TestSearchRateLimit_WritesRateLimitHeaders(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 2, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.11:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "2", rec.Header().Get("X-RateLimit-Limit"))
	assert.Equal(t, "1", rec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
}

func TestSearchRateLimit_RefillsOverTime(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 1, 100*time.Millisecond)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req1.RemoteAddr = "192.0.2.30:9000"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	require.Equal(t, http.StatusNoContent, rec1.Code)

	req2 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req2.RemoteAddr = "192.0.2.30:9000"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusTooManyRequests, rec2.Code)

	time.Sleep(120 * time.Millisecond)

	req3 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req3.RemoteAddr = "192.0.2.30:9000"
	rec3 := httptest.NewRecorder()
	handler.ServeHTTP(rec3, req3)
	require.Equal(t, http.StatusNoContent, rec3.Code)
}

func TestSearchRateLimit_NilStoreFailsOpenWithHeaders(t *testing.T) {
	t.Parallel()

	mw := SearchRateLimit(nil)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.40:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "30", rec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
}

// errorStore always returns an error from ConsumeSearchRateLimitToken.
type errorStore struct {
	consumeCalls int
	cleanupCalls int
}

func (e *errorStore) ConsumeSearchRateLimitToken(_ context.Context, _ db.ConsumeSearchRateLimitTokenParams) (db.ConsumeSearchRateLimitTokenRow, error) {
	e.consumeCalls++
	return db.ConsumeSearchRateLimitTokenRow{}, assert.AnError
}

func (e *errorStore) DeleteExpiredSearchRateLimits(_ context.Context, _ time.Time) error {
	e.cleanupCalls++
	return nil
}

func TestSearchRateLimit_StoreErrorFailsOpenWithHeaders(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	mw := NewSearchRateLimit(store, 5, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.50:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Should fail open — allow the request through
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Limit"))
	assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
	assert.Equal(t, 1, store.consumeCalls)
}

func TestAuthRateLimit_StoreErrorFailsClosed(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	called := false
	handler := NewAuthRateLimit(store, 5, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", nil)
	req.RemoteAddr = "203.0.113.50:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.False(t, called)
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))
}

func TestInteractiveAuthRateLimit_StoreErrorFailsClosed(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	called := false
	handler := NewInteractiveAuthRateLimit(store, 20, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
	req.RemoteAddr = "203.0.113.51:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.False(t, called)
}

func TestSharedBearerAwareAuthRateLimit_WorkerBucketStoreErrorFailsClosed(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	called := false
	handler := SharedBearerAwareAuthRateLimit(store, "shared-secret", 120, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/exchange", nil)
	req.RemoteAddr = "203.0.113.52:9000"
	req.Header.Set("Authorization", "Bearer shared-secret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.False(t, called)
}

func TestSearchRateLimit_InvalidLimitAndWindowDefaultTo30PerMinute(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	// Negative values should clamp to defaults (30/minute)
	mw := NewSearchRateLimit(store, -5, -time.Second)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.60:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "30", rec.Header().Get("X-RateLimit-Limit"))
}

func TestSearchRateLimit_ZeroLimitAndWindowDefaultTo30PerMinute(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 0, 0)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.61:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "30", rec.Header().Get("X-RateLimit-Limit"))
}

func TestSearchRateLimit_EmptyRemoteAddrUsesUnknown(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 1, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = ""
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Contains(t, store.keysSeen, "search|ip:unknown")
}

func TestSearchRateLimit_RemoteAddrWithoutPortUsedDirectly(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 1, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.70" // No port → SplitHostPort fails → use raw
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Contains(t, store.keysSeen, "search|ip:192.0.2.70")
}

func TestSearchRateLimit_WhitespaceOnlyRemoteAddrUsesUnknown(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 1, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "   "
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Contains(t, store.keysSeen, "search|ip:unknown")
}

// Expired-bucket cleanup belongs to the periodic auth cleaner. A user request
// must never wait on a DELETE over the shared bucket table.
func TestSearchRateLimit_RequestPathNeverRunsCleanup(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	mw := NewSearchRateLimit(store, 5, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
		req.RemoteAddr = "192.0.2.80:9000"
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}

	assert.Equal(t, 0, store.cleanupCalls)
}

func TestSearchRateLimit_TypedNilStoreHandledLikeNilStore(t *testing.T) {
	t.Parallel()

	// Pass a typed nil (interface is non-nil, but underlying value is nil)
	var store *mockRateLimitStore // nil pointer
	mw := NewSearchRateLimit(store, 5, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req.RemoteAddr = "192.0.2.90:9000"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Limit"))
}

func TestSearchRateLimit_RemainingClampedToZeroWhenNegative(t *testing.T) {
	t.Parallel()

	// Use a store that returns a row with negative remaining tokens
	store := &mockRateLimitStore{}
	mw := NewSearchRateLimit(store, 1, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// First request uses the token
	req1 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req1.RemoteAddr = "192.0.2.100:9000"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	require.Equal(t, http.StatusNoContent, rec1.Code)

	// Second request is rate limited — remaining should be "0" (clamped)
	req2 := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	req2.RemoteAddr = "192.0.2.100:9000"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusTooManyRequests, rec2.Code)
	assert.Equal(t, "0", rec2.Header().Get("X-RateLimit-Remaining"))
}

// --- GlobalAPIRateLimit tests ---

func TestGlobalAPIRateLimit_AuthenticatedUser5000PerHour(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewGlobalAPIRateLimit(store, 5, 2, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
		req.RemoteAddr = "203.0.113.10:12345"
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code, "request %d should succeed", i+1)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	req.RemoteAddr = "203.0.113.10:12345"
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "rate limit exceeded", payload["message"])
}

func TestGlobalAPIRateLimit_UnauthenticatedUserPerIPLimit(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewGlobalAPIRateLimit(store, 10, 3, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
		req.RemoteAddr = "203.0.113.20:12345"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code, "request %d should succeed", i+1)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	req.RemoteAddr = "203.0.113.20:12345"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "rate limit exceeded", payload["message"])
}

func TestGlobalAPIRateLimit_MixedAuthStatus(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewGlobalAPIRateLimit(store, 3, 2, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
		req.RemoteAddr = "192.0.2.1:8080"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "192.0.2.1:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusTooManyRequests, anonRec.Code)

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
		req.RemoteAddr = "192.0.2.1:8080"
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User: &db.User{ID: 99, Username: "bob", LowerUsername: "bob"},
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code, "auth request %d should succeed", i+1)
	}

	authReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	authReq.RemoteAddr = "192.0.2.1:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 99, Username: "bob", LowerUsername: "bob"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusTooManyRequests, authRec.Code)
}

func TestGlobalAPIRateLimit_WritesCorrectHeaders(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewGlobalAPIRateLimit(store, 5000, 60, time.Hour)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	authReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	authReq.RemoteAddr = "10.0.0.1:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusNoContent, authRec.Code)
	assert.Equal(t, "5000", authRec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, authRec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, authRec.Header().Get("X-RateLimit-Reset"))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "10.0.0.2:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)
	assert.Equal(t, "60", anonRec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, anonRec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, anonRec.Header().Get("X-RateLimit-Reset"))
}

// The production canary principal must draw from the dedicated high-capacity
// bucket while ordinary authenticated users and anonymous callers keep the
// standard limits. Uses t.Setenv (no t.Parallel): the allowlist is read from
// process-global env at construction, mirroring RequireAgentToken.
func TestGlobalAPIRateLimit_CanaryUserGetsCanaryBucket(t *testing.T) {
	t.Setenv("SMITHERS_RATE_LIMIT_CANARY_API_USER_IDS", "1")
	t.Setenv("SMITHERS_RATE_LIMIT_CANARY_API_PER_HOUR", "50000")

	store := &mockRateLimitStore{}
	mw := GlobalAPIRateLimit(store)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	canaryReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	canaryReq.RemoteAddr = "10.0.0.1:8080"
	canaryReq = canaryReq.WithContext(ContextWithAuthInfo(canaryReq.Context(), &AuthInfo{
		User: &db.User{ID: 1, Username: "smithers-canary", LowerUsername: "smithers-canary"},
	}))
	canaryRec := httptest.NewRecorder()
	handler.ServeHTTP(canaryRec, canaryReq)
	require.Equal(t, http.StatusNoContent, canaryRec.Code)
	assert.Equal(t, "50000", canaryRec.Header().Get("X-RateLimit-Limit"))

	ordinaryReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	ordinaryReq.RemoteAddr = "10.0.0.1:8080"
	ordinaryReq = ordinaryReq.WithContext(ContextWithAuthInfo(ordinaryReq.Context(), &AuthInfo{
		User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"},
	}))
	ordinaryRec := httptest.NewRecorder()
	handler.ServeHTTP(ordinaryRec, ordinaryReq)
	require.Equal(t, http.StatusNoContent, ordinaryRec.Code)
	assert.Equal(t, "5000", ordinaryRec.Header().Get("X-RateLimit-Limit"))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "10.0.0.2:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)
	assert.Equal(t, "600", anonRec.Header().Get("X-RateLimit-Limit"))
}

func TestGlobalAPIRateLimit_CanaryBucketIsIndependentlyEnforced(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewGlobalAPIRateLimitWithCanary(store, 10, 2, time.Minute, []int64{7}, 3)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	send := func(userID int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
		req.RemoteAddr = "10.0.0.3:8080"
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User: &db.User{ID: userID, Username: "u", LowerUsername: "u"},
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	for i := 0; i < 3; i++ {
		require.Equal(t, http.StatusNoContent, send(7).Code, "canary request %d should succeed", i+1)
	}
	require.Equal(t, http.StatusTooManyRequests, send(7).Code, "canary bucket exhausted at its own capacity")

	// The ordinary user's bucket is untouched by the canary's exhaustion.
	rec := send(42)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "10", rec.Header().Get("X-RateLimit-Limit"))
}

func TestCanaryAPIRateLimitFromEnv_SkipsInvalidEntries(t *testing.T) {
	t.Setenv("SMITHERS_RATE_LIMIT_CANARY_API_USER_IDS", "1, bogus, -5, 2, ")
	t.Setenv("SMITHERS_RATE_LIMIT_CANARY_API_PER_HOUR", "not-a-number")

	ids, limit := canaryAPIRateLimitFromEnv()
	assert.Equal(t, []int64{1, 2}, ids)
	assert.Equal(t, 0, limit, "invalid capacity falls back to the constructor default")
}

func TestGlobalAPIRateLimit_StoreErrorFailsOpen(t *testing.T) {
	t.Parallel()

	store := &errorStore{}
	mw := NewGlobalAPIRateLimit(store, 5000, 60, time.Hour)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	authReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	authReq.RemoteAddr = "10.0.0.1:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusNoContent, authRec.Code)
	assert.Equal(t, "5000", authRec.Header().Get("X-RateLimit-Limit"))
	assert.Equal(t, "5000", authRec.Header().Get("X-RateLimit-Remaining"))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "10.0.0.2:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)
	assert.Equal(t, "60", anonRec.Header().Get("X-RateLimit-Limit"))
	assert.Equal(t, "60", anonRec.Header().Get("X-RateLimit-Remaining"))
}

func TestGlobalAPIRateLimit_NilStoreFailsOpen(t *testing.T) {
	t.Parallel()

	mw := NewGlobalAPIRateLimit(nil, 5000, 60, time.Hour)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	authReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	authReq.RemoteAddr = "10.0.0.1:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusNoContent, authRec.Code)
	assert.Equal(t, "5000", authRec.Header().Get("X-RateLimit-Limit"))
	assert.Equal(t, "5000", authRec.Header().Get("X-RateLimit-Remaining"))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "10.0.0.2:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)
	assert.Equal(t, "60", anonRec.Header().Get("X-RateLimit-Limit"))
	assert.Equal(t, "60", anonRec.Header().Get("X-RateLimit-Remaining"))
}

func TestGlobalAPIRateLimit_DefaultLimits(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := GlobalAPIRateLimit(store)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	authReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	authReq.RemoteAddr = "10.0.0.1:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusNoContent, authRec.Code)
	assert.Equal(t, "5000", authRec.Header().Get("X-RateLimit-Limit"))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "10.0.0.3:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)
	assert.Equal(t, "600", anonRec.Header().Get("X-RateLimit-Limit"))
}

func TestNewGlobalAPIRateLimit_AnonFallbackDefaultsTo600(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	// anonLimit <= 0 must clamp to the 600/hour default.
	mw := NewGlobalAPIRateLimit(store, 5000, 0, time.Hour)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "10.0.0.4:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)
	assert.Equal(t, "600", anonRec.Header().Get("X-RateLimit-Limit"))
}

func TestGlobalAPIRateLimit_UsesAPIScopeKey(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewGlobalAPIRateLimit(store, 5, 3, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	anonReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/myrepo", nil)
	anonReq.RemoteAddr = "192.0.2.55:8080"
	anonRec := httptest.NewRecorder()
	handler.ServeHTTP(anonRec, anonReq)
	require.Equal(t, http.StatusNoContent, anonRec.Code)

	authReq := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	authReq.RemoteAddr = "192.0.2.55:8080"
	authReq = authReq.WithContext(ContextWithAuthInfo(authReq.Context(), &AuthInfo{
		User: &db.User{ID: 7, Username: "charlie", LowerUsername: "charlie"},
	}))
	authRec := httptest.NewRecorder()
	handler.ServeHTTP(authRec, authReq)
	require.Equal(t, http.StatusNoContent, authRec.Code)

	assert.Contains(t, store.keysSeen, "api|ip:192.0.2.55")
	assert.Contains(t, store.keysSeen, "api|user:7")
}

// ExcludePaths matches literal request paths, so a chi route pattern can never
// match at runtime. Accepting one would let a bypass list look complete while
// excluding nothing.
func TestExcludePaths_RejectsRoutePatterns(t *testing.T) {
	t.Parallel()

	noop := func(next http.Handler) http.Handler { return next }
	for _, pattern := range []string{"/api/gateways/{hostID}/repository-jobs/{job}", "/api/workspaces/{workspaceID}/desktop/{token}/*", "/api/*"} {
		assert.Panics(t, func() { ExcludePaths(noop, "/api/ok", pattern) }, pattern)
	}
	assert.NotPanics(t, func() { ExcludePaths(noop, "/api/oauth2/token", "/api/search/") })
}

func TestExcludePaths_SkipsMiddlewareForMatchingPaths(t *testing.T) {
	t.Parallel()

	callCount := 0
	innerMW := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			callCount++
			next.ServeHTTP(w, r)
		})
	}

	mw := ExcludePaths(innerMW, "/api/search/")
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/search/repositories", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 0, callCount, "middleware should be skipped for /api/search/ path")

	req2 := httptest.NewRequest(http.MethodGet, "/user", nil)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusNoContent, rec2.Code)
	assert.Equal(t, 1, callCount, "middleware should run for /user path")
}

func TestExcludePaths_DoesNotSkipForUserControlledSubstringMatches(t *testing.T) {
	t.Parallel()

	callCount := 0
	innerMW := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			callCount++
			next.ServeHTTP(w, r)
		})
	}

	mw := ExcludePaths(innerMW, "/api/search/", "/api/_test/", "/api/telemetry/")
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/search/repositories", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, 1, callCount, "middleware must still run when the excluded segment only appears later in the path")
}

func TestEmailVerificationRateLimit_EnforcesFivePerHourPerUser(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewEmailVerificationRateLimit(store, 5, time.Hour)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// Authenticated user makes 5 allowed requests.
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code, "request %d should succeed", i+1)
	}

	// 6th request should be rate-limited.
	req := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Limit"))
	assert.Contains(t, store.keysSeen, "email_verify|user:42")
}

func TestEmailVerificationRateLimit_PerUserIsolation(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := NewEmailVerificationRateLimit(store, 2, time.Hour)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// Alice uses her 2 tokens.
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
			User: &db.User{ID: 10, Username: "alice", LowerUsername: "alice"},
		}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	// Alice is now rate-limited.
	aliceReq := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
	aliceReq = aliceReq.WithContext(ContextWithAuthInfo(aliceReq.Context(), &AuthInfo{
		User: &db.User{ID: 10, Username: "alice", LowerUsername: "alice"},
	}))
	aliceRec := httptest.NewRecorder()
	handler.ServeHTTP(aliceRec, aliceReq)
	require.Equal(t, http.StatusTooManyRequests, aliceRec.Code)

	// Bob can still make requests (different user).
	bobReq := httptest.NewRequest(http.MethodPost, "/api/user/emails/1/verify", nil)
	bobReq = bobReq.WithContext(ContextWithAuthInfo(bobReq.Context(), &AuthInfo{
		User: &db.User{ID: 20, Username: "bob", LowerUsername: "bob"},
	}))
	bobRec := httptest.NewRecorder()
	handler.ServeHTTP(bobRec, bobReq)
	require.Equal(t, http.StatusNoContent, bobRec.Code)
}

func TestTicket0153RateLimits_UseDedicatedUserScopesAndRetryAfter(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		scope string
		path  string
		mw    func(SearchRateLimitStore) func(http.Handler) http.Handler
	}{
		{
			name:  "workspace terminal open",
			scope: "workspace_terminal_open",
			path:  "/api/repos/alice/demo/workspace/sessions/sess-1/terminal",
			mw: func(store SearchRateLimitStore) func(http.Handler) http.Handler {
				return WorkspaceTerminalOpenRateLimit(store, 1)
			},
		},
		{
			name:  "approval decide",
			scope: "approval_decide",
			path:  "/api/repos/alice/demo/approvals/ap-1/decide",
			mw: func(store SearchRateLimitStore) func(http.Handler) http.Handler {
				return ApprovalDecideRateLimit(store, 1)
			},
		},
		{
			name:  "agent message post",
			scope: "agent_message_post",
			path:  "/api/repos/alice/demo/agent/sessions/sess-1/messages",
			mw: func(store SearchRateLimitStore) func(http.Handler) http.Handler {
				return AgentMessagePostRateLimit(store, 1)
			},
		},
		{
			name:  "devtools snapshot post",
			scope: "devtools_snapshot_post",
			path:  "/api/repos/alice/demo/devtools/snapshots",
			mw: func(store SearchRateLimitStore) func(http.Handler) http.Handler {
				return DevtoolsSnapshotPostRateLimit(store, 1)
			},
		},
		{
			name:  "workflow dispatch",
			scope: "workflow_dispatch",
			path:  "/api/repos/alice/demo/workflows/7/dispatches",
			mw: func(store SearchRateLimitStore) func(http.Handler) http.Handler {
				return WorkflowDispatchRateLimit(store, 1)
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			store := &mockRateLimitStore{}
			handler := tc.mw(store)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))

			makeReq := func() *http.Request {
				req := httptest.NewRequest(http.MethodPost, tc.path, nil)
				req.RemoteAddr = "203.0.113.9:7777"
				return req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
					User: &db.User{ID: 42, Username: "alice", LowerUsername: "alice"},
				}))
			}

			first := httptest.NewRecorder()
			handler.ServeHTTP(first, makeReq())
			require.Equal(t, http.StatusNoContent, first.Code)

			second := httptest.NewRecorder()
			handler.ServeHTTP(second, makeReq())
			require.Equal(t, http.StatusTooManyRequests, second.Code)
			assert.Contains(t, store.keysSeen, tc.scope+"|user:42")
			assert.NotEmpty(t, second.Header().Get("Retry-After"))

			var payload map[string]any
			require.NoError(t, json.Unmarshal(second.Body.Bytes(), &payload))
			assert.Equal(t, "rate_limit_exceeded", payload["code"])
			assert.Equal(t, "rate limit exceeded", payload["message"])
			assert.Equal(t, float64(1), payload["limit"])
			assert.Equal(t, float64(0), payload["remaining"])
		})
	}
}

// --- SharedBearerAwareAuthRateLimit tests ---

const sharedBearerTestToken = "worker-exchange-secret-123"

func sharedBearerAuthReq(remoteAddr, authHeader string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/github/token-exchange", nil)
	req.RemoteAddr = remoteAddr
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	return req
}

func TestSharedBearerAwareAuthRateLimit_ValidBearerUsesWorkerScope(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := SharedBearerAwareAuthRateLimit(store, sharedBearerTestToken, 3, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// Drain the strict anonymous "auth" bucket for this IP first (5/min).
	for i := 0; i < 6; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.30:9999", ""))
	}
	drainedRec := httptest.NewRecorder()
	handler.ServeHTTP(drainedRec, sharedBearerAuthReq("203.0.113.30:9999", ""))
	require.Equal(t, http.StatusTooManyRequests, drainedRec.Code, "anonymous auth bucket should be drained")

	// Valid bearer from the SAME IP must succeed independently: it lives in
	// the generous "auth_worker" bucket, not the drained "auth" bucket.
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.30:9999", "Bearer "+sharedBearerTestToken))
		require.Equal(t, http.StatusNoContent, rec.Code, "worker request %d should succeed despite drained auth bucket", i+1)
		assert.Equal(t, "3", rec.Header().Get("X-RateLimit-Limit"))
	}
	assert.Contains(t, store.keysSeen, "auth_worker|ip:203.0.113.30")

	// The worker bucket itself is still enforced.
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.30:9999", "Bearer "+sharedBearerTestToken))
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.NotEmpty(t, rec.Header().Get("Retry-After"))

	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "rate_limit_exceeded", payload["code"])
	assert.Equal(t, "rate limit exceeded", payload["message"])
	assert.Equal(t, float64(3), payload["limit"])
	assert.Equal(t, float64(0), payload["remaining"])
}

func TestSharedBearerAwareAuthRateLimit_WorkerScopeIsolatedFromAuthScope(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := SharedBearerAwareAuthRateLimit(store, sharedBearerTestToken, 120, time.Minute)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// Burn worker tokens; the strict "auth" bucket must stay untouched.
	for i := 0; i < 10; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.31:9999", "Bearer "+sharedBearerTestToken))
		require.Equal(t, http.StatusNoContent, rec.Code)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.31:9999", ""))
	require.Equal(t, http.StatusNoContent, rec.Code, "anonymous request should still have a full auth bucket")
	assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Limit"))
	assert.Contains(t, store.keysSeen, "auth|ip:203.0.113.31")
	assert.Contains(t, store.keysSeen, "auth_worker|ip:203.0.113.31")
}

func TestSharedBearerAwareAuthRateLimit_NonMatchingRequestsUseStrictAuthScope(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name          string
		expectedToken string
		authHeader    string
	}{
		{name: "missing header", expectedToken: sharedBearerTestToken, authHeader: ""},
		{name: "wrong token", expectedToken: sharedBearerTestToken, authHeader: "Bearer wrong-token"},
		{name: "wrong token different length", expectedToken: sharedBearerTestToken, authHeader: "Bearer a-much-longer-token-that-does-not-match-at-all"},
		{name: "non-bearer scheme", expectedToken: sharedBearerTestToken, authHeader: "Basic c2VjcmV0"},
		{name: "token only no scheme", expectedToken: sharedBearerTestToken, authHeader: sharedBearerTestToken},
		{name: "empty expected token", expectedToken: "", authHeader: "Bearer " + sharedBearerTestToken},
		{name: "empty expected token empty bearer", expectedToken: "", authHeader: "Bearer "},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			store := &mockRateLimitStore{}
			mw := SharedBearerAwareAuthRateLimit(store, tc.expectedToken, 120, time.Minute)
			handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))

			// Strict default is 5/min: the 6th request must be rejected,
			// exactly like plain AuthRateLimit.
			for i := 0; i < 5; i++ {
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.32:9999", tc.authHeader))
				require.Equal(t, http.StatusNoContent, rec.Code, "request %d should succeed", i+1)
				assert.Equal(t, "5", rec.Header().Get("X-RateLimit-Limit"))
			}

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, sharedBearerAuthReq("203.0.113.32:9999", tc.authHeader))
			require.Equal(t, http.StatusTooManyRequests, rec.Code)
			assert.Contains(t, store.keysSeen, "auth|ip:203.0.113.32")
			assert.NotContains(t, store.keysSeen, "auth_worker|ip:203.0.113.32")
		})
	}
}

func TestSharedBearerAwareAuthRateLimit_UsesConstantTimeCompare(t *testing.T) {
	t.Parallel()

	// Structural guard: the shared-token check must use
	// subtle.ConstantTimeCompare, never an early-exit string comparison
	// (== / strings.EqualFold on the token would leak timing).
	src, err := os.ReadFile("rate_limit.go")
	require.NoError(t, err)

	fnStart := strings.Index(string(src), "func requestBearsSharedToken(")
	require.GreaterOrEqual(t, fnStart, 0, "requestBearsSharedToken must exist in rate_limit.go")
	rest := string(src)[fnStart:]
	fnEnd := strings.Index(rest, "\nfunc ")
	if fnEnd == -1 {
		fnEnd = len(rest)
	}
	body := rest[:fnEnd]

	assert.Contains(t, body, "subtle.ConstantTimeCompare", "shared-token check must use constant-time comparison")
	earlyExitCompare := regexp.MustCompile(`(?:parts\[1\]|token)\s*[=!]=\s*expectedToken`)
	assert.NotRegexp(t, earlyExitCompare, body, "shared-token check must not use an early-exit string compare")
}

// --- InteractiveAuthRateLimit tests ---

func TestInteractiveAuthRateLimit_UsesInteractiveScopeAndDefaults(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	mw := InteractiveAuthRateLimit(store)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// Default is 20/min per IP — a browser retrying a few sign-in attempts
	// (2 tokens each: start + callback) must not lock itself out.
	for i := 0; i < 20; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
		req.RemoteAddr = "203.0.113.40:12345"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code, "request %d should succeed", i+1)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
	req.RemoteAddr = "203.0.113.40:12345"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "20", rec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, rec.Header().Get("Retry-After"))
	assert.Contains(t, store.keysSeen, "auth_interactive|ip:203.0.113.40")
	assert.NotContains(t, store.keysSeen, "auth|ip:203.0.113.40")

	// Canonical 429 body shape (same encoder as every other limiter).
	var payload map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, "rate_limit_exceeded", payload["code"])
	assert.Equal(t, "rate limit exceeded", payload["message"])
	assert.Equal(t, float64(20), payload["limit"])
	assert.Equal(t, float64(0), payload["remaining"])
}

func TestInteractiveAuthRateLimit_IsolatedFromStrictAuthScope(t *testing.T) {
	t.Parallel()

	store := &mockRateLimitStore{}
	interactiveHandler := NewInteractiveAuthRateLimit(store, 1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	strictHandler := NewAuthRateLimit(store, 1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	// Drain the interactive bucket for this IP.
	rec1 := httptest.NewRecorder()
	req1 := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	req1.RemoteAddr = "203.0.113.41:12345"
	interactiveHandler.ServeHTTP(rec1, req1)
	require.Equal(t, http.StatusNoContent, rec1.Code)

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	req2.RemoteAddr = "203.0.113.41:12345"
	interactiveHandler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusTooManyRequests, rec2.Code)

	// The strict "auth" scope (key/verify/token, oauth2, …) is a
	// separate bucket and still has capacity for the same IP.
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/api/auth/key/verify", nil)
	req3.RemoteAddr = "203.0.113.41:12345"
	strictHandler.ServeHTTP(rec3, req3)
	require.Equal(t, http.StatusNoContent, rec3.Code)

	assert.Contains(t, store.keysSeen, "auth_interactive|ip:203.0.113.41")
	assert.Contains(t, store.keysSeen, "auth|ip:203.0.113.41")
}
