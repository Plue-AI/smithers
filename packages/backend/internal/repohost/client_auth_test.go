package repohost

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClient_InitRepo_InjectsAuthorizationHeader(t *testing.T) {
	t.Parallel()

	var capturedAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.InitRepo(context.Background(), "alice", "demo", "main", false)
	require.NoError(t, err)
	assert.Equal(t, "Bearer test-token", capturedAuth)
}

func TestClient_ProxyReceivePack_InjectsAuthorizationHeader(t *testing.T) {
	t.Parallel()

	var capturedAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.ProxyReceivePack(
		context.Background(),
		"alice",
		"demo",
		bytes.NewBufferString("in"),
		io.Discard,
	)
	require.NoError(t, err)
	assert.Equal(t, "Bearer test-token", capturedAuth)
}

// repo-host refuses a push to a held repository with 503, a plain-text
// message, its code in X-Smithers-Error-Code and a Retry-After.
func TestClient_ProxyReceivePack_HeldRepository(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.Header().Set("X-Smithers-Error-Code", RepositoryHeldCode)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("repository maintenance is finishing; retry in 5s\n"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, discoveryErr := client.InfoRefsReceivePack(context.Background(), "alice", "demo")
	pushErr := client.ProxyReceivePack(context.Background(), "alice", "demo", bytes.NewBufferString("in"), io.Discard)
	for _, err := range []error{discoveryErr, pushErr} {
		status, ok := IsStatusError(err)
		require.True(t, ok, "%v", err)
		assert.True(t, status.Held())
		assert.Equal(t, 5, status.RetryAfter)
		assert.Equal(t, "repository maintenance is finishing; retry in 5s", status.Message)
	}
}
