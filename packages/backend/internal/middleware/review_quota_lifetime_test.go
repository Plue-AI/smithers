package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReviewQuotaStoreReclaimsIdleRouteKeysWithoutResettingDebt(t *testing.T) {
	clock := NewFakeClock(time.Unix(1_800_000_000, 0))
	store := NewTokenBucketStoreWithClock(clock)
	router := chi.NewRouter()
	// As on the LFS routes, quota accounting precedes handler-owned repository
	// lookup. Requests for missing repositories must not be retained forever.
	router.With(PerRepoAPIRequests(store)).Post("/repos/{owner}/{repo}/lfs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	for i := 0; i < 100; i++ {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/repos/alice/missing-"+strconv.Itoa(i)+"/lfs", nil))
		require.Equal(t, http.StatusNotFound, rec.Code)
	}
	for i := 0; i < 24; i++ {
		allowed, _ := store.Take(context.Background(), "daily", 24, 24*time.Hour)
		require.True(t, allowed)
	}
	require.Len(t, store.buckets, 101)

	clock.Advance(time.Hour)
	allowed, _ := store.Take(context.Background(), "daily", 24, 24*time.Hour)
	require.True(t, allowed, "one hour refills one of 24 daily tokens")
	assert.Len(t, store.buckets, 1, "fully refilled idle route keys should be reclaimed on traffic")
	allowed, retry := store.Take(context.Background(), "daily", 24, 24*time.Hour)
	assert.False(t, allowed, "the partially refilled daily budget must survive cleanup")
	assert.Equal(t, time.Hour, retry)

	// Removing a full bucket changes no quota: revisiting its key starts with
	// exactly the budget it would have had without reclamation.
	for i := 0; i < 1000; i++ {
		allowed, _ = store.Take(context.Background(), "repo_api_requests|repo:alice/missing-0|ip:192.0.2.1", 1000, time.Hour)
		require.True(t, allowed)
	}
	allowed, _ = store.Take(context.Background(), "repo_api_requests|repo:alice/missing-0|ip:192.0.2.1", 1000, time.Hour)
	assert.False(t, allowed)
}
