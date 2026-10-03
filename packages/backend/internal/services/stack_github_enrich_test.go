package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A resolver failure must not turn a readable local stack into a 500: the
// GitHub fields are best-effort decoration.
func TestStackGitHubEnrich_ResolverErrorDegradesToDefaults(t *testing.T) {
	pr := int64(9)
	resolver := stackInstallationResolverStub(func(context.Context, int64, string, string) (int64, error) {
		return 0, errors.New("install lookup failed")
	})
	response := StackResponse{Changes: []StackChangeResponse{{ChangeID: "c1", PRNumber: &pr}}}
	err := newTestStackService(t, &mockStackQuerier{}, WithStackGitHubInstallationResolver(resolver)).
		enrichStackResponseWithGitHub(context.Background(), 1, "Owner", "Repo", &response)
	require.NoError(t, err)
	assert.Equal(t, "open", response.Changes[0].PRState)
	assert.Equal(t, "https://github.com/Owner/Repo/pull/9", response.Changes[0].PRURL)
}

// Per-change GitHub lookups run concurrently under one overall deadline, so a
// slow GitHub cannot hold a stack read for minutes.
func TestStackGitHubEnrich_ParallelWithDeadline(t *testing.T) {
	prev := stackGitHubEnrichTimeout
	stackGitHubEnrichTimeout = 300 * time.Millisecond
	t.Cleanup(func() { stackGitHubEnrichTimeout = prev })

	const installationID = int64(987654322)
	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", generateStackTestRSAPrivateKeyPEM(t))
	storeCachedInstallationToken(GitHubTokenScope{RepositoryIDs: []int64{testRepositoryID}, Permissions: stackGitHubPermissions}.cacheKey(installationID), installationID, "cached-token", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(installationID) })

	var inFlight, maxInFlight atomic.Int32
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		mu.Lock()
		if n > maxInFlight.Load() {
			maxInFlight.Store(n)
		}
		mu.Unlock()
		if strings.Contains(r.URL.Path, "/pulls/1") {
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
		_, _ = w.Write([]byte(`{"state":"closed","html_url":"https://github.test/pr"}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	resolver := stackInstallationResolverStub(func(context.Context, int64, string, string) (int64, error) {
		return installationID, nil
	})
	changes := make([]StackChangeResponse, 0, 6)
	for i := int64(1); i <= 6; i++ {
		n := i
		changes = append(changes, StackChangeResponse{ChangeID: "c", PRNumber: &n})
	}
	response := StackResponse{Changes: changes}
	start := time.Now()
	err := newTestStackService(t, &mockStackQuerier{}, WithStackGitHubInstallationResolver(resolver)).
		enrichStackResponseWithGitHub(context.Background(), 1, "o", "r", &response)
	require.NoError(t, err)
	assert.Less(t, time.Since(start), 2*time.Second)
	assert.Greater(t, maxInFlight.Load(), int32(1), "per-change lookups must run concurrently")
	assert.Equal(t, "open", response.Changes[0].PRState, "timed-out change keeps defaults")
	assert.Equal(t, "closed", response.Changes[1].PRState)
}

func TestStackGitHubEnrich_SharesMintAndReadBudget(t *testing.T) {
	const installationID int64 = 991516
	invalidateCachedInstallationToken(installationID)
	t.Cleanup(func() { invalidateCachedInstallationToken(installationID) })
	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", generateStackTestRSAPrivateKeyPEM(t))
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		assert.Equal(t, "/app/installations/991516/access_tokens", r.URL.Path)
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "1100")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"token":"ghs_stack_budget","expires_at":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	tracker := NewGitHubResponseBudgetTracker()
	tracker.now = func() time.Time { return time.Unix(1000, 0).UTC() }
	resolver := stackInstallationResolverStub(func(context.Context, int64, string, string) (int64, error) { return installationID, nil })
	pr := int64(9)
	response := StackResponse{Changes: []StackChangeResponse{{ChangeID: "c1", PRNumber: &pr}}}
	service := newTestStackService(t, &mockStackQuerier{}, WithStackGitHubInstallationResolver(resolver), WithStackGitHubBudget(tracker))
	require.NoError(t, service.enrichStackResponseWithGitHub(context.Background(), 1, "acme", "app", &response))
	require.Equal(t, int32(1), calls.Load(), "mint receipt exhausts capacity before any PR or review read")
	require.Equal(t, "open", response.Changes[0].PRState, "a refused read preserves existing defaults")
}
