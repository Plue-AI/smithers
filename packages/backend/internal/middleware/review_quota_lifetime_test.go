package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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

func TestReviewDesktopQuotaUsesWorkspaceUUIDIdentity(t *testing.T) {
	clock := NewFakeClock(time.Unix(1_800_000_000, 0))
	store := NewTokenBucketStoreWithClock(clock)
	handler := quotaTestRouter(PerWorkspaceDesktopControl(store), http.MethodPost, "/workspaces/{id}/desktop/input")
	const id = "aabbccdd-1122-3344-5566-778899aabbcc"
	drainQuota(t, handler, http.MethodPost, "/workspaces/"+id+"/desktop/input", 1800)
	// PostgreSQL UUID input accepts case, omitted hyphens, braces and hyphens
	// after groups of four digits; all identify the same workspace row.
	for _, spelling := range []string{
		id,
		strings.ToUpper(id),
		strings.ReplaceAll(id, "-", ""),
		"{" + id + "}",
		"aabb-ccdd-1122-3344-5566-7788-99aa-bbcc",
	} {
		t.Run(spelling, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/workspaces/"+spelling+"/desktop/input", nil)
			req.RemoteAddr = "10.0.0.1:1"
			handler.ServeHTTP(rec, req)
			assert.Equal(t, http.StatusTooManyRequests, rec.Code, "an alternate UUID spelling must not restore capacity")
		})
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/workspaces/aabbccdd-1122-3344-5566-778899aabbcd/desktop/input", nil))
	assert.Equal(t, http.StatusNoContent, rec.Code, "a different workspace keeps its independent budget")
}
