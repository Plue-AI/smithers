package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func repoAPIRequestAs(user *db.User, remoteAddr string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/shared/info", nil)
	req.RemoteAddr = remoteAddr
	if user != nil {
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
	}
	return req
}

// One caller exhausting the per-repo API bucket must not lock the repository
// for every other caller.
func TestPerRepoAPIRequests_BucketIsPerPrincipal(t *testing.T) {
	t.Parallel()

	clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	store := NewTokenBucketStoreWithClock(clock)
	handler := quotaTestRouter(PerRepoAPIRequests(store), http.MethodGet, "/api/repos/{owner}/{repo}/info")

	alice := &db.User{ID: 1}
	bob := &db.User{ID: 2}
	for i := 0; i < 1000; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, repoAPIRequestAs(alice, "10.0.0.1:1"))
		require.Equalf(t, http.StatusNoContent, rec.Code, "request %d", i+1)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, repoAPIRequestAs(alice, "10.0.0.1:1"))
	require.Equal(t, http.StatusTooManyRequests, rec.Code, "the caller that drained its bucket is limited")

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, repoAPIRequestAs(bob, "10.0.0.1:1"))
	require.Equal(t, http.StatusNoContent, rec.Code, "another user of the same repo keeps its budget")

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, repoAPIRequestAs(nil, "10.0.0.2:1"))
	require.Equal(t, http.StatusNoContent, rec.Code, "an anonymous caller is keyed by its address")
}

func TestSearchRateLimitKey_IPv6SharesSlash64(t *testing.T) {
	t.Parallel()

	key := func(remote string) string {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = remote
		return searchRateLimitKey(req)
	}
	a := key("[2001:db8:1:2:aaaa::1]:443")
	b := key("[2001:db8:1:2:ffff:ffff:ffff:fffe]:443")
	require.Equal(t, a, b, "addresses in one /64 must share a bucket")
	require.Equal(t, "ip:2001:db8:1:2::/64", a)
	require.NotEqual(t, a, key("[2001:db8:1:3::1]:443"), "a different /64 gets its own bucket")

	require.Equal(t, "ip:203.0.113.7", key("203.0.113.7:1234"), "IPv4 stays per address")
	require.Equal(t, "ip:203.0.113.7", key("[::ffff:203.0.113.7]:1234"), "IPv4-mapped IPv6 is keyed as IPv4")
	require.Equal(t, "ip:unknown", key(""))
}

// Internal sync traffic has the same bounded budget, shared across token
// rotations, but cannot spend its owner's interactive allowance.
func TestPerRepoAPIRequests_SyncCredentialBudget(t *testing.T) {
	clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	handler := quotaTestRouter(PerRepoAPIRequests(NewTokenBucketStoreWithClock(clock)), http.MethodGet, "/api/repos/{owner}/{repo}/info")
	user := &db.User{ID: 1}
	request := func(system bool, token int64) int {
		req := repoAPIRequestAs(user, "127.0.0.1:1")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: user, IsTokenAuth: true, TokenID: token, TokenSystemIssued: system, RawScopes: "write:repository," + SyncCredentialScope()}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	for i := 0; i < 1000; i++ {
		require.Equal(t, http.StatusNoContent, request(true, 10))
	}
	require.Equal(t, http.StatusTooManyRequests, request(true, 11), "rotation must not reset the sync budget")
	require.Equal(t, http.StatusNoContent, request(false, 12), "a person retains their allowance; a forged sync scope does not change their kind")
	req := repoAPIRequestAs(user, "127.0.0.1:1")
	require.Equal(t, "user:1", searchRateLimitKey(req))
	require.Equal(t, http.StatusNoContent, request(false, 12))
}

func TestGlobalAPIRateLimit_SyncCredentialBudget(t *testing.T) {
	handler := NewGlobalAPIRateLimit(&mockRateLimitStore{}, 2, 1, time.Hour)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	request := func(system bool) int {
		req := repoAPIRequestAs(&db.User{ID: 1}, "127.0.0.1:1")
		req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: system, RawScopes: SyncCredentialScope()}))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	require.Equal(t, http.StatusNoContent, request(true))
	require.Equal(t, http.StatusNoContent, request(true))
	require.Equal(t, http.StatusTooManyRequests, request(true))
	require.Equal(t, http.StatusNoContent, request(false), "sync does not drain the global user allowance either")
}
