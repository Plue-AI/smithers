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

// Installation tokens live about an hour; a stack read must reuse the cached
// token instead of minting one per request.
func TestStackGitHubInstallationToken_MintsOncePerInstallation(t *testing.T) {
	const installationID = int64(987654321)
	invalidateCachedInstallationToken(installationID)
	t.Cleanup(func() { invalidateCachedInstallationToken(installationID) })

	var mints atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mints.Add(1)
		exp := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
		_, _ = w.Write([]byte(`{"token":"install-token","expires_at":"` + exp + `"}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", generateStackTestRSAPrivateKeyPEM(t))

	for range 3 {
		token, err := newTestStackGitHubInstallationToken(t, context.Background(), installationID)
		require.NoError(t, err)
		assert.Equal(t, "install-token", token)
	}
	assert.Equal(t, int32(1), mints.Load())
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
	storeCachedInstallationToken(installationID, "cached-token", time.Now().Add(time.Hour))
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
