package blob

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMemoryStore_Exists_ReturnsFalseForMissing(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	exists, err := store.Exists(context.Background(), "missing")
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestMemoryStore_Exists_ReturnsTrueAfterUpload(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	_, err := store.SignedUploadURL(context.Background(), "objects/1", "application/octet-stream", 0, time.Minute)
	require.NoError(t, err)
	exists, err := store.Exists(context.Background(), "objects/1")
	require.NoError(t, err)
	assert.True(t, exists)
}

func TestMemoryStore_SignedUploadURL_ReturnsNonEmptyURL(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	url, err := store.SignedUploadURL(context.Background(), "objects/2", "text/plain", 0, time.Minute)
	require.NoError(t, err)
	assert.NotEmpty(t, url)
	assert.Contains(t, url, "http://localhost:0/memory/upload/")
}

func TestMemoryStore_SignedDownloadURL_ReturnsNonEmptyURL(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	_, _ = store.SignedUploadURL(context.Background(), "objects/3", "application/json", 0, time.Minute)
	url, err := store.SignedDownloadURL(context.Background(), "objects/3", time.Minute)
	require.NoError(t, err)
	assert.NotEmpty(t, url)
	assert.Contains(t, url, "http://localhost:0/memory/download/")
}

func TestMemoryStore_Delete_RemovesObject(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	_, _ = store.SignedUploadURL(context.Background(), "objects/4", "application/octet-stream", 0, time.Minute)
	require.NoError(t, store.Delete(context.Background(), "objects/4"))
	exists, err := store.Exists(context.Background(), "objects/4")
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestMemoryStore_Delete_NonExistentReturnsNil(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	require.NoError(t, store.Delete(context.Background(), "objects/missing"))
}

func TestMemoryStore_SignedDownloadURL_NonExistent_ReturnsError(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	_, err := store.SignedDownloadURL(context.Background(), "objects/missing", time.Minute)
	require.Error(t, err)
}

func TestMemoryStore_Stat_ReturnsMissingForUnknownObject(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	_, err := store.Stat(context.Background(), "objects/missing")
	require.ErrorIs(t, err, ErrObjectNotFound)
}

func TestMemoryStore_Stat_ReturnsUnknownSizeForReservedObject(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	_, err := store.SignedUploadURL(context.Background(), "objects/reserved", "application/octet-stream", 0, time.Minute)
	require.NoError(t, err)

	attrs, err := store.Stat(context.Background(), "objects/reserved")
	require.NoError(t, err)
	assert.Equal(t, UnknownObjectSize, attrs.Size)
}

func TestMemoryStore_ConcurrentAccess(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := "objects/concurrent-" + strconv.Itoa(i)
			_, _ = store.SignedUploadURL(context.Background(), key, "application/octet-stream", 0, time.Minute)
			_, _ = store.Exists(context.Background(), key)
			_ = store.Delete(context.Background(), key)
		}()
	}
	wg.Wait()
}

func TestMemoryStore_NewReaderConcurrentMetadata(t *testing.T) {
	t.Parallel()
	store := NewMemoryStore()
	ctx := context.Background()
	key := "objects/concurrent-reader"
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < 100000; i++ {
			_, err := store.SignedUploadURL(ctx, key, "application/octet-stream", 0, time.Minute)
			if err != nil {
				t.Errorf("register: %v", err)
				return
			}
			if err := store.Delete(ctx, key); err != nil {
				t.Errorf("delete: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < 100000; i++ {
			reader, err := store.NewReader(ctx, key)
			if reader != nil {
				_ = reader.Close()
				t.Error("metadata-only object returned content")
				return
			}
			if err != ErrObjectNotFound && (err == nil || err.Error() != "MemoryStore holds no content for \"objects/concurrent-reader\"") {
				t.Errorf("unexpected reader error: %v", err)
				return
			}
		}
	}()
	close(start)
	wg.Wait()
}
