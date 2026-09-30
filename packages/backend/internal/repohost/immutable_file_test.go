package repohost

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestGetFileAtCommitCoalescesAndSeparatesSnapshots(t *testing.T) {
	var reads atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reads.Add(1) == 1 {
			close(started)
			<-release
		}
		_ = json.NewEncoder(w).Encode(FileContent{Content: r.URL.Path})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	errs := make(chan error, 50)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f, e := client.GetFileAtCommit(context.Background(), "owner", "repo", "c1", "policy.json")
			if e == nil && f.Content != "/repos/owner:repo/file/c1/policy.json" {
				e = fmt.Errorf("wrong content %q", f.Content)
			}
			errs <- e
		}()
	}
	<-started
	close(release)
	wg.Wait()
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	require.EqualValues(t, 1, reads.Load())
	for _, key := range [][4]string{{"owner", "repo", "c1", "policy.json"}, {"owner", "repo", "c2", "policy.json"}, {"other", "repo", "c1", "policy.json"}, {"owner", "other", "c1", "policy.json"}, {"owner", "repo", "c1", "other.json"}} {
		f, e := client.GetFileAtCommit(context.Background(), key[0], key[1], key[2], key[3])
		require.NoError(t, e)
		require.Contains(t, f.Content, key[2]+"/"+key[3])
	}
	require.EqualValues(t, 5, reads.Load())
}

func TestGetFileAtCommitCachesMissingButRetriesFailure(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := reads.Add(1)
		if n == 1 {
			http.Error(w, "temporary", 500)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "file_not_found", "message": "file missing"})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
	require.Error(t, e)
	for i := 0; i < 2; i++ {
		_, e = client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
		status, ok := IsStatusError(e)
		require.True(t, ok)
		require.Equal(t, 404, status.StatusCode)
	}
	require.EqualValues(t, 2, reads.Load())
}

func TestGetFileAtCommitCanceledWaiterDoesNotPoisonSharedRead(t *testing.T) {
	var reads atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		once.Do(func() { close(started) })
		<-release
		_ = json.NewEncoder(w).Encode(FileContent{Content: "policy"})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, e := client.GetFileAtCommit(ctx, "o", "r", "c", "p"); first <- e }()
	<-started
	survivor := make(chan error, 1)
	go func() {
		f, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
		if e == nil && f.Content != "policy" {
			e = fmt.Errorf("wrong content")
		}
		survivor <- e
	}()
	cancel()
	require.ErrorIs(t, <-first, context.Canceled)
	close(release)
	require.NoError(t, <-survivor)
	f, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
	require.NoError(t, e)
	require.Equal(t, "policy", f.Content)
	require.EqualValues(t, 1, reads.Load())
}

func TestGetFileAtCommitBoundedCacheAndClientIsolation(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		_ = json.NewEncoder(w).Encode(FileContent{Content: r.URL.Path})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "first-token")
	for i := 0; i < 1025; i++ {
		_, e := client.GetFileAtCommit(context.Background(), "o", "r", fmt.Sprintf("c-%d", i), "p")
		require.NoError(t, e)
	}
	_, e := client.GetFileAtCommit(context.Background(), "o", "r", "c-1024", "p")
	require.NoError(t, e)
	require.EqualValues(t, 1025, reads.Load())
	for i := 0; i < 1024; i++ {
		_, e = client.GetFileAtCommit(context.Background(), "o", "r", fmt.Sprintf("c-%d", i), "p")
		require.NoError(t, e)
	}
	require.Greater(t, reads.Load(), int32(1025), "at least one completed snapshot must be evicted")
	beforeOther := reads.Load()
	other := NewClient(&StaticStorageSetResolver{URL: server.URL}, "second-token")
	_, e = other.GetFileAtCommit(context.Background(), "o", "r", "c-1024", "p")
	require.NoError(t, e)
	require.EqualValues(t, beforeOther+1, reads.Load(), "credentials and transports must not share cache entries")
}

func TestGetFileAtCommitBoundsConcurrentCompletions(t *testing.T) {
	const total = 1025
	var reads atomic.Int32
	allStarted, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reads.Add(1) == total {
			close(allStarted)
		}
		<-release
		_ = json.NewEncoder(w).Encode(FileContent{Content: r.URL.Path})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	errs := make(chan error, total)
	var wg sync.WaitGroup
	for i := 0; i < total; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_, e := client.GetFileAtCommit(context.Background(), "o", "r", fmt.Sprintf("c-%d", n), "p")
			errs <- e
		}(i)
	}
	<-allStarted
	close(release)
	wg.Wait()
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	require.EqualValues(t, total, reads.Load())
	// Reading every snapshot again must fetch at least one evicted entry even
	// when the cache was populated entirely by concurrent completions.
	for i := 0; i < total; i++ {
		_, e := client.GetFileAtCommit(context.Background(), "o", "r", fmt.Sprintf("c-%d", i), "p")
		require.NoError(t, e)
	}
	require.Greater(t, reads.Load(), int32(total))
}

func TestGetFileAtCommitAlreadyCanceledDoesNotRead(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		_ = json.NewEncoder(w).Encode(FileContent{})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e := client.GetFileAtCommit(ctx, "o", "r", "c", "p")
	require.ErrorIs(t, e, context.Canceled)
	require.Zero(t, reads.Load())
}

func TestGetFileAtCommitReadTimeoutRetries(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reads.Add(1) == 1 {
			<-r.Context().Done()
			return
		}
		_ = json.NewEncoder(w).Encode(FileContent{Content: "recovered"})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	client.readTimeout = 20 * time.Millisecond
	_, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
	require.Error(t, e)
	f, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
	require.NoError(t, e)
	require.Equal(t, "recovered", f.Content)
	require.EqualValues(t, 2, reads.Load())
}

func TestGetFileAtCommitGeneric404RetriesUntilRecovery(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if reads.Add(1) <= 2 {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(FileContent{Content: "recovered"})
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	for i := 0; i < 2; i++ {
		_, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
		status, ok := IsStatusError(e)
		require.True(t, ok)
		require.Equal(t, 404, status.StatusCode)
	}
	f, e := client.GetFileAtCommit(context.Background(), "o", "r", "c", "p")
	require.NoError(t, e)
	require.Equal(t, "recovered", f.Content)
	require.EqualValues(t, 3, reads.Load())
}
