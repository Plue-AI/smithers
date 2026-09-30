package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	promtestutil "github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// quotaTestRouter mounts the middleware on a chi router so chi.URLParam can
// resolve {owner} and {repo}. Without this, the middleware key falls back to
// "scope|repo:/" which would lump every test together.
func quotaTestRouter(mw func(http.Handler) http.Handler, method, pattern string) http.Handler {
	r := chi.NewRouter()
	r.With(mw).Method(method, pattern, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	return r
}

// drainQuota fires N requests through the handler at the same fake-clock
// instant and asserts they all succeed. Returns the recorder for the final
// request so the caller can inspect headers.
func drainQuota(t *testing.T, h http.Handler, method, url string, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		req := httptest.NewRequest(method, url, nil)
		req.RemoteAddr = "10.0.0.1:1"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		require.Equalf(t, http.StatusNoContent, rec.Code, "request %d expected pass", i+1)
	}
}

func TestRateLimitTokenBucket_RefillsAfterDuration(t *testing.T) {
	t.Parallel()

	clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	store := NewTokenBucketStoreWithClock(clock)

	// Capacity 2, refills over 1 second.
	allowed, _ := store.Take(context.Background(), "k", 2, time.Second)
	require.True(t, allowed)
	allowed, _ = store.Take(context.Background(), "k", 2, time.Second)
	require.True(t, allowed)
	allowed, retry := store.Take(context.Background(), "k", 2, time.Second)
	require.False(t, allowed)
	require.Greater(t, retry, time.Duration(0))

	// Advance past the refill window — bucket should be full again.
	clock.Advance(time.Second)
	allowed, _ = store.Take(context.Background(), "k", 2, time.Second)
	require.True(t, allowed)
}

func TestPerRepoRateLimits_TableDriven(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		mw       func(*TokenBucketStore) func(http.Handler) http.Handler
		capacity int
		window   time.Duration
		method   string
		pattern  string
		url      string
	}{
		{
			name:     "stack submits 30/hr",
			mw:       PerRepoStackSubmits,
			capacity: 30,
			window:   time.Hour,
			method:   http.MethodPost,
			pattern:  "/api/repos/{owner}/{repo}/landing-requests",
			url:      "/api/repos/alice/myrepo/landing-requests",
		},
		{
			name:     "workflow runs 60/hr",
			mw:       PerRepoWorkflowRuns,
			capacity: 60,
			window:   time.Hour,
			method:   http.MethodPost,
			pattern:  "/api/repos/{owner}/{repo}/workflow-runs",
			url:      "/api/repos/alice/myrepo/workflow-runs",
		},
		{
			name:     "api requests 1000/hr",
			mw:       PerRepoAPIRequests,
			capacity: 1000,
			window:   time.Hour,
			method:   http.MethodGet,
			pattern:  "/api/repos/{owner}/{repo}/info",
			url:      "/api/repos/alice/myrepo/info",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
			store := NewTokenBucketStoreWithClock(clock)
			handler := quotaTestRouter(tc.mw(store), tc.method, tc.pattern)

			// Drain the bucket exactly to its cap.
			drainQuota(t, handler, tc.method, tc.url, tc.capacity)

			// Next request should 429 with the canonical body.
			req := httptest.NewRequest(tc.method, tc.url, nil)
			req.RemoteAddr = "10.0.0.1:1"
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			require.Equal(t, http.StatusTooManyRequests, rec.Code)

			retryAfter := rec.Header().Get("Retry-After")
			require.NotEmpty(t, retryAfter)
			retrySeconds, err := strconv.Atoi(retryAfter)
			require.NoError(t, err)
			require.Greater(t, retrySeconds, 0)

			var body map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, "rate limit exceeded", body["message"])
			assert.Equal(t, float64(retrySeconds), body["retry_after"])
			assert.NotContains(t, body, "retry_after_seconds")
			assert.Equal(t, "rate_limit_exceeded", body["code"])
			assert.Equal(t, "user", body["fault"])

			// Advance the clock past the full window — bucket fully refills.
			clock.Advance(tc.window + time.Second)
			req2 := httptest.NewRequest(tc.method, tc.url, nil)
			rec2 := httptest.NewRecorder()
			handler.ServeHTTP(rec2, req2)
			require.Equal(t, http.StatusNoContent, rec2.Code, "bucket should refill after window")
		})
	}
}

func TestPerRepoRateLimit_BucketsAreScopedPerRepo(t *testing.T) {
	t.Parallel()

	clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	store := NewTokenBucketStoreWithClock(clock)
	handler := quotaTestRouter(PerRepoStackSubmits(store), http.MethodPost, "/api/repos/{owner}/{repo}/landing-requests")

	// Drain alice/repo1 to exhaustion.
	for i := 0; i < 30; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/repo1/landing-requests", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusNoContent, rec.Code)
	}
	// alice/repo1 next request blocked.
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/repo1/landing-requests", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)

	// alice/repo2 (different repo) still has full budget.
	req2 := httptest.NewRequest(http.MethodPost, "/api/repos/alice/repo2/landing-requests", nil)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusNoContent, rec2.Code)
}

func TestPerWorkspaceDesktopControl_UnauthorizedCallerDoesNotDrainOwnerBucket(t *testing.T) {
	t.Parallel()

	clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	store := NewTokenBucketStoreWithClock(clock)
	const path = "/api/repos/alice/demo/workspaces/ws-1/desktop/observe"
	router := chi.NewRouter()
	router.With(PerWorkspaceDesktopControl(store)).Post(
		"/api/repos/{owner}/{repo}/workspaces/{id}/desktop/observe",
		func(w http.ResponseWriter, r *http.Request) {
			if UserFromContext(r.Context()).ID != 1 {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		},
	)
	request := func(userID int64) int {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: userID}}))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}

	for i := 0; i < 1800; i++ {
		require.Equalf(t, http.StatusForbidden, request(2), "foreign request %d", i+1)
	}
	for i := 0; i < 1800; i++ {
		require.Equalf(t, http.StatusNoContent, request(1), "owner request %d", i+1)
	}
	require.Equal(t, http.StatusTooManyRequests, request(1))
}

func TestRequireWorkspaceDesktopAccess_RejectsBeforeCharging(t *testing.T) {
	t.Parallel()

	store := NewTokenBucketStoreWithClock(NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)))
	check := func(_ context.Context, workspaceID string, repositoryID, userID int64) error {
		require.Equal(t, "ws-1", workspaceID)
		require.Equal(t, int64(9), repositoryID)
		if userID != 1 {
			return pkgerrors.Forbidden("access denied")
		}
		return nil
	}
	router := chi.NewRouter()
	router.With(RequireWorkspaceDesktopAccess(check), PerWorkspaceDesktopControl(store)).Post(
		"/api/repos/{owner}/{repo}/workspaces/{id}/desktop/input",
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) },
	)
	request := func(userID int64) int {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/desktop/input", nil)
		ctx := ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: userID}})
		ctx = ContextWithRepoContext(ctx, &RepoContext{Repository: &db.Repository{ID: 9}}, PermissionWrite)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec.Code
	}

	for i := 0; i < 3; i++ {
		require.Equal(t, http.StatusForbidden, request(2))
	}
	require.Empty(t, store.buckets, "denied calls must not create a rate bucket")
	require.Equal(t, http.StatusNoContent, request(1))
	require.Len(t, store.buckets, 1)
}

// --- Per-user count caps. ----------------------------------------

type stubRepoCounter struct {
	count int
	err   error
}

func (s *stubRepoCounter) CountConnectedReposForUser(_ context.Context, _ int64) (int, error) {
	return s.count, s.err
}

type stubWorkflowCounter struct {
	count int
	err   error
}

func (s *stubWorkflowCounter) CountActiveWorkflowRunsForUser(_ context.Context, _ int64) (int, error) {
	return s.count, s.err
}

type stubSandboxCounter struct {
	count int
	err   error
}

func (s *stubSandboxCounter) CountActiveSandboxesForUser(_ context.Context, _ int64) (int, error) {
	return s.count, s.err
}

func TestPerUserConnectedRepos_RejectsAtCap(t *testing.T) {
	t.Parallel()

	counter := &stubRepoCounter{count: 10}
	mw := PerUserConnectedRepos(counter, 10)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/repos/connect", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User: &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)

	// Below cap → allowed.
	counter.count = 9
	req2 := httptest.NewRequest(http.MethodPost, "/api/repos/connect", nil)
	req2 = req2.WithContext(ContextWithAuthInfo(req2.Context(), &AuthInfo{
		User: &db.User{ID: 7, Username: "alice", LowerUsername: "alice"},
	}))
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	require.Equal(t, http.StatusNoContent, rec2.Code)
}

func TestPerUserConcurrentWorkflowRuns_DefaultsToFive(t *testing.T) {
	t.Parallel()

	counter := &stubWorkflowCounter{count: 5}
	mw := PerUserConcurrentWorkflowRuns(counter, 0) // 0 → use default 5
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/workflows/dispatch", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User: &db.User{ID: 1, Username: "u", LowerUsername: "u"},
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
}

func TestPerUserConcurrentSandboxes_FailClosedOnCounterError(t *testing.T) {
	t.Parallel()

	counter := &stubSandboxCounter{count: 99, err: errors.New("db down")}
	mw := PerUserConcurrentSandboxes(counter, 3)
	called := false
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{
		User: &db.User{ID: 2, Username: "u", LowerUsername: "u"},
	}))
	rec := httptest.NewRecorder()
	before := promtestutil.ToFloat64(QuotaCounterErrors.WithLabelValues("concurrent_sandboxes"))
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusInternalServerError, rec.Code, "counter error must refuse new sandbox admission")
	assert.False(t, called, "the protected handler must not run after a failed count")
	require.Equal(t, before+1, promtestutil.ToFloat64(QuotaCounterErrors.WithLabelValues("concurrent_sandboxes")),
		"a counter error must be counted so admission failures are visible")
}

func TestPerUserCap_AnonymousRequestsPassThrough(t *testing.T) {
	t.Parallel()

	mw := PerUserConcurrentSandboxes(&stubSandboxCounter{count: 100}, 3)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	// No user in context.
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestSandboxHardCapPreservesPlanRefusal(t *testing.T) {
	planErr := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "plan cap")
	planErr.PlanKey, planErr.LimitKind, planErr.UpgradePlanKey = "free", "concurrent_sandboxes", "pro"
	for _, tc := range []struct {
		name  string
		count int
		above bool
		err   error
		want  int
		calls int
	}{
		{"plan first", 10, false, planErr, 402, 1},
		{"plan database error fails closed", 10, false, errors.New("database down"), 500, 1},
		{"hard cap remains", 10, false, nil, 429, 1},
		{"plan limit above the cap admits", 10, true, nil, 204, 1},
		{"reuse defers to service", 1, false, planErr, 204, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			plan := func(_ context.Context, id int64) (bool, error) {
				calls++
				assert.Equal(t, int64(7), id)
				return tc.above, tc.err
			}
			handler := PerUserConcurrentSandboxes(&stubSandboxCounter{count: tc.count}, 10, plan)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
			req := httptest.NewRequest(http.MethodPost, "/api/sandboxes", nil)
			req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 7}}))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			assert.Equal(t, tc.want, rec.Code)
			assert.Equal(t, tc.calls, calls)
			if tc.want == 402 {
				assert.Contains(t, rec.Body.String(), `"upgrade_plan_key":"pro"`)
				assert.Empty(t, rec.Header().Get("Retry-After"))
			}
		})
	}
}
