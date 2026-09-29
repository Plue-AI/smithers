package blob

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Production cache cleanup uses generation purge. The stand-in keeps the
// create-only capabilities the fence requires while recording which exact
// objects were physically purged.
type cachePurgeRecordingStore struct {
	*MemoryStore
	purged []string
}

func (s *cachePurgeRecordingStore) SignedCreateOnlyUploadURL(ctx context.Context, key, contentType string, size int64, expiry time.Duration) (SignedUpload, error) {
	u, err := s.MemoryStore.SignedUploadURL(ctx, key, contentType, size, expiry)
	return SignedUpload{URL: u}, err
}

func (s *cachePurgeRecordingStore) PurgeAllGenerations(ctx context.Context, key string) error {
	s.purged = append(s.purged, key)
	return s.MemoryStore.Delete(ctx, key)
}

func TestBuildCachePurgeBypassesClosedLegacyFenceOnlyForExactCacheKeys(t *testing.T) {
	ctx := context.Background()
	underlying := &cachePurgeRecordingStore{MemoryStore: NewMemoryStore()}
	store, err := NewLegacyFinalKeyPurgeFencedStore(underlying, func(context.Context) (bool, error) {
		return false, nil
	})
	require.NoError(t, err)
	valid := "build-cache/7/" + strings.Repeat("a", 64)
	put := func(key string) {
		t.Helper()
		require.NoError(t, underlying.Put(ctx, key, "application/octet-stream", bytes.NewBufferString("bytes")))
	}
	put(valid)
	require.NoError(t, PurgeAllGenerations(ctx, store, valid))
	require.Equal(t, []string{valid}, underlying.purged)
	exists, err := underlying.Exists(ctx, valid)
	require.NoError(t, err)
	require.False(t, exists)
	put(valid)
	require.NoError(t, store.Delete(ctx, valid), "nonversioned deletion uses the same exact-key exception")
	exists, err = underlying.Exists(ctx, valid)
	require.NoError(t, err)
	require.False(t, exists)

	for _, key := range []string{
		"repos/7/" + strings.Repeat("a", 64),
		"build-cache/0/" + strings.Repeat("a", 64),
		"build-cache/-7/" + strings.Repeat("a", 64),
		"build-cache/7/" + strings.Repeat("A", 64),
		"build-cache/7/" + strings.Repeat("a", 63),
		"build-cache/7/" + strings.Repeat("a", 64) + "/extra",
		"/build-cache/7/" + strings.Repeat("a", 64),
		"build-cache/7/../" + strings.Repeat("a", 64),
	} {
		t.Run(key, func(t *testing.T) {
			put(key)
			err := PurgeAllGenerations(ctx, store, key)
			require.ErrorIs(t, err, ErrLegacyFinalKeyPurgeFenced)
			require.ErrorIs(t, store.Delete(ctx, key), ErrLegacyFinalKeyPurgeFenced)
			exists, err := underlying.Exists(ctx, key)
			require.NoError(t, err)
			require.True(t, exists)
		})
	}
	require.Equal(t, []string{valid}, underlying.purged)
	// The sentinel is still distinguishable through wrapped errors.
	require.True(t, errors.Is(PurgeAllGenerations(ctx, store, "repos/other"), ErrLegacyFinalKeyPurgeFenced))
}
