package repohost

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"

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

// The client records a held refusal on its caller's context from any call,
// with repo-host's Retry-After or the registry's.
func TestClient_RecordsHeldRefusalOnTheCallersContext(t *testing.T) {
	t.Parallel()
	for _, retryAfter := range []string{"7", ""} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.Header().Set("X-Smithers-Error-Code", RepositoryHeldCode)
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
		client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
		ctx := apierrors.WithRefusalRecorder(context.Background())
		require.Error(t, client.ImportRefs(ctx, "alice", "demo"))
		refusal := apierrors.RecordedRefusal(ctx)
		require.NotNil(t, refusal)
		assert.Equal(t, apierrors.CodeRepositoryHeld, refusal.Code)
		if retryAfter == "7" {
			assert.Equal(t, 7, refusal.RetryAfter)
		} else {
			assert.Equal(t, 5, refusal.RetryAfter)
		}
		server.Close()
	}
}

// A push that asks for it learns when repo-host has taken the repository's
// lock (102 Processing), over the network and in process alike.
func TestClient_ProxyReceivePack_ReportsWhenThePushStarts(t *testing.T) {
	t.Parallel()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(StartedHeader) == "1" {
			w.WriteHeader(http.StatusProcessing)
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	for name, client := range map[string]*Client{
		"network":    NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token"),
		"in process": NewLocalClient(handler, "test-token"),
	} {
		started := 0
		var out bytes.Buffer
		ctx := WithPushStarted(context.Background(), func() { started++ })
		err := client.ProxyReceivePack(ctx, "alice", "demo", bytes.NewBufferString("in"), &out)
		require.NoError(t, err, name)
		assert.Equal(t, 1, started, name)
		assert.Equal(t, "ok", out.String(), name)
	}
}
