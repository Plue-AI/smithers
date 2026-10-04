package services

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGitHubBudget_Z_RefillClampAndNegativeRemaining(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	tracker := NewBudgetTrackerWithLimits(2, time.Minute)
	tracker.now = func() time.Time { return now }

	allowed, retryAfter := tracker.Allow(99)
	require.True(t, allowed)
	assert.Zero(t, retryAfter)
	allowed, _ = tracker.Allow(99)
	require.True(t, allowed)

	now = now.Add(2 * time.Minute)
	allowed, _ = tracker.Allow(99)
	require.True(t, allowed)
	assert.Equal(t, 1, tracker.Remaining(99))

	tracker.mu.Lock()
	tracker.buckets[100] = &budgetEntry{tokens: -0.5, lastRefill: now}
	tracker.mu.Unlock()
	assert.Equal(t, 0, tracker.Remaining(100))
}

func TestGitHubBudget_Z_StatusAndRefusalShareReset(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	tracker := NewBudgetTrackerWithLimits(2, time.Minute)
	tracker.now = func() time.Time { return now }

	fresh := tracker.Status(44)
	assert.Equal(t, GitHubRateLimit{
		Limit:     2,
		Remaining: 2,
		ResetAt:   now.Add(time.Minute),
	}, fresh)

	allowed, retryAfter, status := tracker.AllowWithStatus(44)
	require.True(t, allowed)
	assert.Zero(t, retryAfter)
	assert.Equal(t, GitHubRateLimit{
		Limit:     2,
		Remaining: 1,
		ResetAt:   now.Add(30 * time.Second),
	}, status)

	allowed, retryAfter, status = tracker.AllowWithStatus(44)
	require.True(t, allowed)
	assert.Zero(t, retryAfter)
	assert.Equal(t, 0, status.Remaining)
	assert.Equal(t, now.Add(time.Minute), status.ResetAt)

	allowed, retryAfter, refused := tracker.AllowWithStatus(44)
	require.False(t, allowed)
	assert.Equal(t, 30*time.Second, retryAfter, "retry when one token refills, not when the bucket is full")
	assert.Equal(t, status, refused)
}

// A drained 5000/hour bucket refills a token every 0.72 s; Retry-After must
// say about a second, not the hour until the bucket is full.
func TestBudgetTracker_DeniedRetryAfterIsTimeToOneToken(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	tracker := NewBudgetTracker()
	tracker.now = func() time.Time { return now }
	for i := 0; i < GitHubInstallationHourlyBudget; i++ {
		allowed, _ := tracker.Allow(7)
		require.True(t, allowed)
	}

	allowed, retryAfter, status := tracker.AllowWithStatus(7)
	require.False(t, allowed)
	assert.Equal(t, time.Second, retryAfter)
	assert.Equal(t, now.Add(time.Hour), status.ResetAt, "ResetAt stays the full-refill time")
}

func TestGitHubBudget_ResponseHeadersAndStreamAdmission(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	tracker := NewGitHubResponseBudgetTracker()
	tracker.now = func() time.Time { return now }
	tracker.registerToken("scoped-one", 91)
	tracker.registerToken("scoped-two", 91)
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "19")
		w.Header().Set("X-RateLimit-Reset", "1100")
		w.Header().Set("X-RateLimit-Resource", "core")
		if r.URL.Path == "/repos/acme/app/pulls" {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(403)
		} else if r.URL.Path == "/graphql" {
			w.Header().Set("X-RateLimit-Resource", "graphql")
			w.Header().Set("X-RateLimit-Remaining", "0")
		} else if r.Header.Get("If-None-Match") != "" {
			w.WriteHeader(304)
		}
	}))
	defer server.Close()
	client := tracker.WrapClient(server.Client())
	send := func(method, path, token, etag string, status int) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("If-None-Match", etag)
		resp, err := client.Do(req)
		require.NoError(t, err)
		require.Equal(t, status, resp.StatusCode)
		require.NoError(t, resp.Body.Close())
	}
	send("GET", "/repos/acme/app/issues", "scoped-one", "", 200)
	require.Equal(t, 19, tracker.Status(91).Remaining)
	require.Equal(t, 240*time.Second, tracker.StreamCadence(91, "issues", 120*time.Second))
	require.Equal(t, 240*time.Second, tracker.StreamCadence(91, "issue-events", 120*time.Second))
	require.Equal(t, 7200*time.Second, tracker.StreamCadence(91, "permissions", 3600*time.Second))
	require.Equal(t, 45*time.Second, tracker.StreamCadence(91, "pulls", 45*time.Second))
	require.Equal(t, 30*time.Second, tracker.StreamCadence(91, "refs", 30*time.Second))
	send("GET", "/repos/acme/app/issues", "scoped-two", `"unchanged"`, 304)
	require.Equal(t, 19, tracker.Status(91).Remaining, "304 has no charged debit across scoped tokens")
	send("GET", "/repos/acme/app/pulls", "scoped-one", "", 403)
	send("GET", "/repos/acme/app/pulls?page=2", "scoped-two", "", 429)
	require.Len(t, calls, 3, "Retry-After pauses all pages of this stream")
	send("GET", "/repos/acme/app/issues/events", "scoped-one", "", 200)
	send("POST", "/graphql", "scoped-one", "", 200)
	require.Equal(t, 17, tracker.Status(91).Remaining, "another resource must not consume core capacity")
	send("POST", "/graphql", "scoped-two", "", 429)
	require.Len(t, calls, 5, "exhaustion applies only to its resource")
	send("GET", "/repos/acme/app/issues", "scoped-one", "", 200)
	now = time.Unix(1030, 0).UTC()
	send("GET", "/repos/acme/app/pulls", "scoped-two", "", 403)
	require.Len(t, calls, 7, "stream resumes at the exact retry boundary")
	now = time.Unix(1100, 0).UTC()
	require.Equal(t, 120*time.Second, tracker.StreamCadence(91, "issues", 120*time.Second))
	require.Equal(t, GitHubRateLimit{}, tracker.Status(91), "reset discards the old receipt without local refill")
	send("POST", "/graphql", "scoped-one", "", 200)
	require.Len(t, calls, 8)
}

func TestGitHubBudget_MintAndReadsShareAdmissionWithoutHourlyCap(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	tracker := NewGitHubResponseBudgetTracker()
	tracker.now = func() time.Time { return now }
	tracker.registerToken("read-token", 91)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/user/repos" {
			return
		}
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1100")
	}))
	defer server.Close()
	client := tracker.WrapClient(server.Client())
	send := func(path, token string) int {
		req, err := http.NewRequest("POST", server.URL+path, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		require.NoError(t, err)
		require.NoError(t, resp.Body.Close())
		return resp.StatusCode
	}
	require.Equal(t, 200, send("/app/installations/91/access_tokens", "app-jwt"))
	require.Equal(t, 429, send("/repos/acme/app/issues", "read-token"))
	require.Equal(t, 429, send("/app/installations/91/access_tokens", "rotated-jwt"))
	require.Equal(t, 1, calls)
	now = time.Unix(1050, 0).UTC()
	require.Equal(t, 429, send("/repos/acme/app/issues", "read-token"), "no local linear refill")
	require.Equal(t, 200, send("/app/installations/92/access_tokens", "app-jwt"), "installations remain isolated")
	now = time.Unix(1100, 0).UTC()
	require.Equal(t, 200, send("/app/installations/91/access_tokens", "app-jwt"))
	require.Equal(t, 3, calls)
	// Missing header receipts are unknown, rather than a fabricated hourly cap.
	for i := 0; i < 5001; i++ {
		require.Equal(t, 200, send("/user/repos", "independent-user-token"))
	}
	require.Equal(t, 5004, calls)
}

func TestGitHubBudget_HeaderParser(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	for _, tc := range []struct {
		header  http.Header
		seconds int64
	}{
		{http.Header{"Retry-After": {"30"}, "X-Ratelimit-Reset": {"1100"}}, 30},
		{http.Header{"Retry-After": {"Thu, 01 Jan 1970 00:17:10 GMT"}}, 30},
		{http.Header{"Retry-After": {"0"}, "X-Ratelimit-Reset": {"1100"}}, 100},
		{http.Header{"Retry-After": {"-1"}}, 1},
		{http.Header{"Retry-After": {"broken"}}, 1},
		{http.Header{"X-Ratelimit-Reset": {"1000"}}, 1},
	} {
		require.Equal(t, now.Add(time.Duration(tc.seconds)*time.Second), GitHubRetryAt(tc.header, now))
	}
	for _, header := range []http.Header{
		{}, {"X-Ratelimit-Limit": {"100"}},
		{"X-Ratelimit-Limit": {"0"}, "X-Ratelimit-Remaining": {"0"}, "X-Ratelimit-Reset": {"1100"}},
		{"X-Ratelimit-Limit": {"100"}, "X-Ratelimit-Remaining": {"101"}, "X-Ratelimit-Reset": {"1100"}},
		{"X-Ratelimit-Limit": {"100"}, "X-Ratelimit-Remaining": {"-1"}, "X-Ratelimit-Reset": {"1100"}},
		{"X-Ratelimit-Limit": {"100"}, "X-Ratelimit-Remaining": {"50"}, "X-Ratelimit-Reset": {"-1"}},
	} {
		_, _, valid := GitHubRateLimitHeaders(header)
		require.False(t, valid)
	}
	_, receipt, valid := GitHubRateLimitHeaders(http.Header{"X-Ratelimit-Limit": {"100"}, "X-Ratelimit-Remaining": {"20"}, "X-Ratelimit-Reset": {"1100"}})
	require.True(t, valid)
	require.Equal(t, GitHubRateLimit{Limit: 100, Remaining: 20, ResetAt: time.Unix(1100, 0).UTC()}, receipt)
}
