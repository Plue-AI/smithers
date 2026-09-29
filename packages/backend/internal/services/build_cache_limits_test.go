package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
)

func TestBuildCacheLimitsQuotaRollbackAndExpiry(t *testing.T) {
	svc, store, blobs := newTestBuildCache(t)
	svc.MaxRepositoryBytes = 1024
	ctx := context.Background()
	body := []byte("artifact")
	digest := buildcache.SHA256Hex(body)
	_, err := svc.PutArtifact(ctx, 7, digest, body)
	require.NoError(t, err)
	publication, err := buildcache.ParsePublication("action", `{"result":{"ok":true},"keyDigest":"action"}`)
	require.NoError(t, err)
	_, err = svc.PutEntry(ctx, 7, "action", publication)
	require.ErrorContains(t, err, "repository build cache quota exceeded")
	require.Empty(t, store.entries, "refused entry must roll back")

	row := store.artifacts[fakeKey(7, digest)]
	row.CreatedAt = time.Now().Add(-31 * 24 * time.Hour)
	store.artifacts[fakeKey(7, digest)] = row
	present, err := svc.HasArtifact(ctx, 7, digest)
	require.NoError(t, err)
	require.False(t, present)
	_, err = svc.PutEntry(ctx, 7, "action", publication)
	require.NoError(t, err)
	require.Empty(t, store.artifacts)
	exists, err := blobs.Exists(ctx, ArtifactBlobKey(7, digest))
	require.NoError(t, err)
	require.False(t, exists)
	outcome, err := svc.PutEntry(ctx, 7, "action", publication)
	require.NoError(t, err)
	require.Equal(t, PublicationIdentical, outcome)
	deleted, err := svc.DeleteEntry(ctx, 7, "action", nil)
	require.NoError(t, err)
	require.True(t, deleted)
	_, err = svc.PutArtifact(ctx, 7, digest, body)
	require.NoError(t, err, "a delete releases the allowance")
}

func TestBuildCacheLimitsBackgroundCleanupIsBounded(t *testing.T) {
	svc, store, _ := newTestBuildCache(t)
	ctx := context.Background()
	for i := 0; i < 70; i++ {
		key := fmt.Sprint(i)
		publication, err := buildcache.ParsePublication(key, `{"ok":true}`)
		require.NoError(t, err)
		_, err = svc.PutEntry(ctx, 7, key, publication)
		require.NoError(t, err)
	}
	for key, entry := range store.entries {
		entry.createdAt = time.Now().Add(-31 * 24 * time.Hour)
		store.entries[key] = entry
	}
	require.NoError(t, svc.Cleanup(ctx))
	require.Len(t, store.entries, 6)
	require.NoError(t, svc.Cleanup(ctx))
	require.Empty(t, store.entries)
}
