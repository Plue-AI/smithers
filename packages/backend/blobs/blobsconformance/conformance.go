// Package blobsconformance provides adapter-neutral blob behavior checks.
package blobsconformance

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/blobs"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// RunStore checks shared storage semantics. The factory must return a fresh
// store for each subtest and register its cleanup with that subtest.
func RunStore(t *testing.T, factory func(*testing.T) blobs.Store) {
	t.Helper()
	t.Run("put stat open delete", func(t *testing.T) {
		store := factory(t)
		require.NoError(t, blobs.Put(context.Background(), store, "repos/7/artifacts/a", "text/plain", strings.NewReader("durable")))
		attrs, err := store.Stat(context.Background(), "repos/7/artifacts/a")
		require.NoError(t, err)
		assert.Equal(t, int64(7), attrs.Size)
		if attrs.SHA256 != "" {
			assert.Equal(t, "54dab9eb6d3204a0b42800148196ed4785d258f980432579b62ef0d9db0207b8", attrs.SHA256)
		}
		assert.Equal(t, "durable", readObject(t, store, "repos/7/artifacts/a"))
		require.NoError(t, store.Delete(context.Background(), "repos/7/artifacts/a"))
		require.NoError(t, store.Delete(context.Background(), "repos/7/artifacts/a"))
		_, err = store.Stat(context.Background(), "repos/7/artifacts/a")
		assert.ErrorIs(t, err, blobs.ErrObjectNotFound)
	})

	t.Run("create only promotion", func(t *testing.T) {
		store := factory(t)
		promoter := store.(blobs.CreateOnlyPromoter)
		require.NoError(t, blobs.Put(context.Background(), store, "pending/workflow-artifacts/repos/8/a", "", strings.NewReader("first")))
		require.NoError(t, promoter.PromoteCreateOnly(context.Background(), "pending/workflow-artifacts/repos/8/a", "repos/8/artifacts/a"))
		require.NoError(t, blobs.Put(context.Background(), store, "pending/workflow-artifacts/repos/8/b", "", strings.NewReader("other")))
		assert.ErrorIs(t, promoter.PromoteCreateOnly(context.Background(), "pending/workflow-artifacts/repos/8/b", "repos/8/artifacts/a"), blobs.ErrObjectAlreadyExists)
		assert.Equal(t, "first", readObject(t, store, "repos/8/artifacts/a"))
		assert.Equal(t, "other", readObject(t, store, "pending/workflow-artifacts/repos/8/b"))
	})
}

func readObject(t *testing.T, store blobs.Store, key string) string {
	t.Helper()
	r, err := store.NewReader(context.Background(), key)
	require.NoError(t, err)
	defer func() { require.NoError(t, r.Close()) }()
	payload, err := io.ReadAll(r)
	require.NoError(t, err)
	return string(payload)
}
