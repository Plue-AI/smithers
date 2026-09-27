package services

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func newTestBuildCache(t *testing.T) (*BuildCacheService, *fakeBuildCacheStore, *blob.MemoryStore) {
	t.Helper()
	store := newFakeBuildCacheStore()
	blobs := blob.NewMemoryStore()
	return NewBuildCacheService(store, blobs, 0), store, blobs
}

func TestBuildCacheService_PutEntryFirstWriterWins(t *testing.T) {
	t.Parallel()
	svc, _, _ := newTestBuildCache(t)
	ctx := context.Background()
	first, err := buildcache.ParsePublication("k", `{"exitOk":true,"target":"lib"}`)
	require.NoError(t, err)
	outcome, err := svc.PutEntry(ctx, 7, "k", first)
	require.NoError(t, err)
	assert.Equal(t, PublicationInserted, outcome)

	// Member order does not matter for identity.
	reordered, err := buildcache.ParsePublication("k", `{"target":"lib","exitOk":true}`)
	require.NoError(t, err)
	outcome, err = svc.PutEntry(ctx, 7, "k", reordered)
	require.NoError(t, err)
	assert.Equal(t, PublicationIdentical, outcome)

	different, err := buildcache.ParsePublication("k", `{"exitOk":false}`)
	require.NoError(t, err)
	outcome, err = svc.PutEntry(ctx, 7, "k", different)
	require.NoError(t, err)
	assert.Equal(t, PublicationConflict, outcome)

	body, found, err := svc.GetEntry(ctx, 7, "k")
	require.NoError(t, err)
	assert.True(t, found)
	assert.Equal(t, `{"exitOk":true,"target":"lib"}`, body, "the first publication's own bytes are what a hit returns")

	// Another repository never sees it.
	_, found, err = svc.GetEntry(ctx, 8, "k")
	require.NoError(t, err)
	assert.False(t, found)
}

func TestBuildCacheService_DeleteFence(t *testing.T) {
	t.Parallel()
	svc, _, _ := newTestBuildCache(t)
	ctx := context.Background()
	pub, err := buildcache.ParsePublication("k", `{"keyDigest":"k","result":1,"recordedRunId":"run","recordedEventSeq":3}`)
	require.NoError(t, err)
	_, err = svc.PutEntry(ctx, 1, "k", pub)
	require.NoError(t, err)
	deleted, err := svc.DeleteEntry(ctx, 1, "k", &buildcache.Fence{RunID: "run", EventSeq: 4})
	require.NoError(t, err)
	assert.False(t, deleted, "a fence that does not match deletes nothing")
	deleted, err = svc.DeleteEntry(ctx, 1, "k", &buildcache.Fence{RunID: "run", EventSeq: 3})
	require.NoError(t, err)
	assert.True(t, deleted)
	deleted, err = svc.DeleteEntry(ctx, 1, "k", nil)
	require.NoError(t, err)
	assert.False(t, deleted)
}

func TestBuildCacheService_ArtifactsRoundTripAndRepair(t *testing.T) {
	t.Parallel()
	svc, store, blobs := newTestBuildCache(t)
	ctx := context.Background()
	payload := []byte("hello artifact")
	digest := buildcache.SHA256Hex(payload)

	outcome, err := svc.PutArtifact(ctx, 3, digest, payload)
	require.NoError(t, err)
	assert.Equal(t, ArtifactInserted, outcome)
	outcome, err = svc.PutArtifact(ctx, 3, digest, payload)
	require.NoError(t, err)
	assert.Equal(t, ArtifactPresent, outcome)

	present, err := svc.HasArtifact(ctx, 3, digest)
	require.NoError(t, err)
	assert.True(t, present)
	present, err = svc.HasArtifact(ctx, 4, digest)
	require.NoError(t, err)
	assert.False(t, present, "artifacts are keyed per repository")

	reader, size, found, err := svc.OpenArtifact(ctx, 3, digest)
	require.NoError(t, err)
	require.True(t, found)
	defer reader.Close()
	data, err := io.ReadAll(reader)
	require.NoError(t, err)
	assert.Equal(t, payload, data)
	assert.Equal(t, int64(len(payload)), size)

	// A row whose object vanished is repaired by the next publication.
	require.NoError(t, blobs.Delete(ctx, ArtifactBlobKey(3, digest)))
	outcome, err = svc.PutArtifact(ctx, 3, digest, payload)
	require.NoError(t, err)
	assert.Equal(t, ArtifactRepaired, outcome)
	assert.Len(t, store.artifacts, 1)

	present2, err := svc.PresentDigests(ctx, 3, []string{digest, strings.Repeat("0", 64)})
	require.NoError(t, err)
	_, ok := present2[digest]
	assert.True(t, ok)
	assert.Len(t, present2, 1)

	_, err = svc.PutArtifact(ctx, 3, strings.Repeat("0", 64), payload)
	assert.Error(t, err, "bytes must digest to the address")
}

func TestBuildCacheService_ReadTokens(t *testing.T) {
	t.Parallel()
	svc, _, _ := newTestBuildCache(t)
	ctx := context.Background()
	repo := &db.Repository{ID: 9, Name: "app"}
	created, err := svc.CreateReadToken(ctx, &db.User{ID: 1}, repo, "acme/app", "ci", "https://api.example.test/api/repos/acme/app/build-cache", "pr-1/")
	require.NoError(t, err)
	assert.Equal(t, "pr-1/", created.NamespacePrefix)
	assert.True(t, buildcache.IsReadToken(created.Token))
	assert.Equal(t, created.Token[len(created.Token)-8:], created.LastEight)
	assert.Equal(t, "acme/app", created.Repository)

	resolved, err := svc.ResolveReadToken(ctx, created.Token)
	require.NoError(t, err)
	assert.Equal(t, int64(9), resolved.RepositoryID)
	assert.Equal(t, "pr-1/", resolved.NamespacePrefix)
	_, err = svc.CreateReadToken(ctx, &db.User{ID: 1}, repo, "acme/app", "invalid", "https://api.example.test", "pr-1")
	assert.Error(t, err, "an unbounded prefix cannot be stored")

	_, err = svc.ResolveReadToken(ctx, "smithers_"+strings.Repeat("0", 40))
	assert.Error(t, err, "an ordinary token never resolves as a read token")

	listed, err := svc.ListReadTokens(ctx, repo, "acme/app")
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.Equal(t, "pr-1/", listed[0].NamespacePrefix)
	require.NoError(t, svc.RevokeReadToken(ctx, repo, created.ID))
	_, err = svc.ResolveReadToken(ctx, created.Token)
	assert.Error(t, err, "a revoked token stops resolving")
	assert.Error(t, svc.RevokeReadToken(ctx, &db.Repository{ID: 10}, created.ID), "another repository cannot revoke it")
}
