package services

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockWorkflowCacheQuerier struct {
	clearPurgedStorageDeletionFn          func(ctx context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error)
	getRepoByIDFn                         func(ctx context.Context, id int64) (db.Repository, error)
	getWorkflowCacheByIDFn                func(ctx context.Context, id int64) (db.WorkflowCache, error)
	getWorkflowCacheByScopeVersionFn      func(ctx context.Context, arg db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error)
	findWorkflowCacheForRestoreFn         func(ctx context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error)
	upsertPendingWorkflowCacheFn          func(ctx context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error)
	finalizeWorkflowCacheFn               func(ctx context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error)
	touchWorkflowCacheHitFn               func(ctx context.Context, id int64) error
	listWorkflowCachesFn                  func(ctx context.Context, arg db.ListWorkflowCachesParams) ([]db.WorkflowCache, error)
	listWorkflowCachesForClearFn          func(ctx context.Context, arg db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error)
	deleteWorkflowCacheByIDFn             func(ctx context.Context, id int64) (db.WorkflowCache, error)
	claimWorkflowCacheDeletionFn          func(ctx context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error)
	retryWorkflowCacheDeletionFn          func(ctx context.Context, arg db.RetryWorkflowCacheDeletionParams) (db.WorkflowCache, error)
	releaseWorkflowCacheDeletionClaimFn   func(ctx context.Context, arg db.ReleaseWorkflowCacheDeletionClaimParams) error
	deleteClaimedWorkflowCacheFn          func(ctx context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error)
	getWorkflowCacheRepoUsageFn           func(ctx context.Context, repositoryID int64) (int64, error)
	getWorkflowCacheStatsFn               func(ctx context.Context, repositoryID int64) (db.GetWorkflowCacheStatsRow, error)
	listWorkflowCacheRepositoryIDsFn      func(ctx context.Context) ([]int64, error)
	listWorkflowCacheEvictionCandidatesFn func(ctx context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error)
}

func (m *mockWorkflowCacheQuerier) ClearPurgedStorageDeletionByExactKey(ctx context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
	if m.clearPurgedStorageDeletionFn != nil {
		return m.clearPurgedStorageDeletionFn(ctx, arg)
	}
	return 0, nil
}

type mockWorkflowCacheMetrics struct {
	observeRunnerCacheHitFn func(result string)
}

func (m *mockWorkflowCacheMetrics) ObserveRunnerCacheHit(result string) {
	if m.observeRunnerCacheHitFn != nil {
		m.observeRunnerCacheHitFn(result)
	}
}

func (m *mockWorkflowCacheQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, nil
}

func (m *mockWorkflowCacheQuerier) GetWorkflowCacheByID(ctx context.Context, id int64) (db.WorkflowCache, error) {
	if m.getWorkflowCacheByIDFn != nil {
		return m.getWorkflowCacheByIDFn(ctx, id)
	}
	return db.WorkflowCache{}, nil
}

func (m *mockWorkflowCacheQuerier) GetWorkflowCacheByScopeVersion(ctx context.Context, arg db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
	if m.getWorkflowCacheByScopeVersionFn != nil {
		return m.getWorkflowCacheByScopeVersionFn(ctx, arg)
	}
	return db.WorkflowCache{}, pgx.ErrNoRows
}

func (m *mockWorkflowCacheQuerier) FindWorkflowCacheForRestore(ctx context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
	if m.findWorkflowCacheForRestoreFn != nil {
		return m.findWorkflowCacheForRestoreFn(ctx, arg)
	}
	return db.WorkflowCache{}, nil
}

func (m *mockWorkflowCacheQuerier) UpsertPendingWorkflowCache(ctx context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
	if m.upsertPendingWorkflowCacheFn != nil {
		return m.upsertPendingWorkflowCacheFn(ctx, arg)
	}
	return db.WorkflowCache{}, nil
}

func (m *mockWorkflowCacheQuerier) FinalizeWorkflowCache(ctx context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
	if m.finalizeWorkflowCacheFn != nil {
		return m.finalizeWorkflowCacheFn(ctx, arg)
	}
	if m.getWorkflowCacheByIDFn != nil {
		row, err := m.getWorkflowCacheByIDFn(ctx, arg.ID)
		if err != nil {
			return db.WorkflowCache{}, err
		}
		row.Status = "finalized"
		row.ObjectSizeBytes = arg.ObjectSizeBytes
		row.ExpiresAt = arg.ExpiresAt
		return row, nil
	}
	return db.WorkflowCache{
		ID:              arg.ID,
		RepositoryID:    arg.RepositoryID,
		WorkflowRunID:   arg.WorkflowRunID,
		ObjectKey:       arg.ObjectKey,
		ObjectSizeBytes: arg.ObjectSizeBytes,
		Status:          "finalized",
	}, nil
}

func (m *mockWorkflowCacheQuerier) TouchWorkflowCacheHit(ctx context.Context, id int64) error {
	if m.touchWorkflowCacheHitFn != nil {
		return m.touchWorkflowCacheHitFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowCacheQuerier) ListWorkflowCaches(ctx context.Context, arg db.ListWorkflowCachesParams) ([]db.WorkflowCache, error) {
	if m.listWorkflowCachesFn != nil {
		return m.listWorkflowCachesFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowCacheQuerier) ListWorkflowCachesForClear(ctx context.Context, arg db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error) {
	if m.listWorkflowCachesForClearFn != nil {
		return m.listWorkflowCachesForClearFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowCacheQuerier) DeleteWorkflowCacheByID(ctx context.Context, id int64) (db.WorkflowCache, error) {
	if m.deleteWorkflowCacheByIDFn != nil {
		return m.deleteWorkflowCacheByIDFn(ctx, id)
	}
	return db.WorkflowCache{}, nil
}

func (m *mockWorkflowCacheQuerier) ClaimWorkflowCacheDeletion(ctx context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
	if m.claimWorkflowCacheDeletionFn != nil {
		return m.claimWorkflowCacheDeletionFn(ctx, arg)
	}
	// Preserve older fixtures that injected the generic delete callback before
	// the production service gained a claimed two-phase deletion.
	if m.deleteWorkflowCacheByIDFn != nil {
		row, err := m.deleteWorkflowCacheByIDFn(ctx, arg.ID)
		if err != nil {
			return db.WorkflowCache{}, err
		}
		if row.ID == 0 {
			row.ID = arg.ID
		}
		if row.RepositoryID == 0 {
			row.RepositoryID = arg.RepositoryID
		}
		if !row.WorkflowRunID.Valid {
			row.WorkflowRunID = arg.WorkflowRunID
		}
		if row.ObjectKey == "" {
			row.ObjectKey = arg.ObjectKey
		}
		row.Status = "deleting"
		return row, nil
	}
	return db.WorkflowCache{
		ID:            arg.ID,
		RepositoryID:  arg.RepositoryID,
		WorkflowRunID: arg.WorkflowRunID,
		ObjectKey:     arg.ObjectKey,
		Status:        "deleting",
	}, nil
}

func (m *mockWorkflowCacheQuerier) RetryWorkflowCacheDeletion(ctx context.Context, arg db.RetryWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
	if m.retryWorkflowCacheDeletionFn != nil {
		return m.retryWorkflowCacheDeletionFn(ctx, arg)
	}
	return db.WorkflowCache{}, pgx.ErrNoRows
}

func (m *mockWorkflowCacheQuerier) ReleaseWorkflowCacheDeletionClaim(ctx context.Context, arg db.ReleaseWorkflowCacheDeletionClaimParams) error {
	if m.releaseWorkflowCacheDeletionClaimFn != nil {
		return m.releaseWorkflowCacheDeletionClaimFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowCacheQuerier) DeleteClaimedWorkflowCache(ctx context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
	if m.deleteClaimedWorkflowCacheFn != nil {
		return m.deleteClaimedWorkflowCacheFn(ctx, arg)
	}
	return db.WorkflowCache{
		ID:            arg.ID,
		RepositoryID:  arg.RepositoryID,
		WorkflowRunID: arg.WorkflowRunID,
		ObjectKey:     arg.ObjectKey,
		Status:        "deleting",
	}, nil
}

func (m *mockWorkflowCacheQuerier) GetWorkflowCacheRepoUsage(ctx context.Context, repositoryID int64) (int64, error) {
	if m.getWorkflowCacheRepoUsageFn != nil {
		return m.getWorkflowCacheRepoUsageFn(ctx, repositoryID)
	}
	return 0, nil
}

func (m *mockWorkflowCacheQuerier) GetWorkflowCacheStats(ctx context.Context, repositoryID int64) (db.GetWorkflowCacheStatsRow, error) {
	if m.getWorkflowCacheStatsFn != nil {
		return m.getWorkflowCacheStatsFn(ctx, repositoryID)
	}
	return db.GetWorkflowCacheStatsRow{}, nil
}

func (m *mockWorkflowCacheQuerier) ListWorkflowCacheRepositoryIDs(ctx context.Context) ([]int64, error) {
	if m.listWorkflowCacheRepositoryIDsFn != nil {
		return m.listWorkflowCacheRepositoryIDsFn(ctx)
	}
	return nil, nil
}

func (m *mockWorkflowCacheQuerier) ListWorkflowCacheEvictionCandidates(ctx context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
	if m.listWorkflowCacheEvictionCandidatesFn != nil {
		return m.listWorkflowCacheEvictionCandidatesFn(ctx, arg)
	}
	return nil, nil
}

func TestWorkflowCacheService_Restore_FallsBackToDefaultBookmark(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(_ context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			assert.Equal(t, int64(77), arg.RepositoryID)
			assert.Equal(t, "feature/demo", arg.BookmarkName)
			assert.Equal(t, "main", arg.DefaultBookmark)
			assert.Equal(t, "npm", arg.CacheKey)
			assert.Equal(t, "version-123", arg.CacheVersion)
			return db.WorkflowCache{
				ID:           9,
				RepositoryID: 77,
				BookmarkName: "main",
				CacheKey:     "npm",
				CacheVersion: "version-123",
				ObjectKey:    "workflow-cache/repos/77/abc.tgz",
				Compression:  workflowCacheCompression,
				Status:       "finalized",
			}, nil
		},
		touchWorkflowCacheHitFn: func(_ context.Context, id int64) error {
			assert.Equal(t, int64(9), id)
			return nil
		},
	}
	store := &mockBlobStore{
		existsFn: func(_ context.Context, key string) (bool, error) {
			assert.Equal(t, "workflow-cache/repos/77/abc.tgz", key)
			return true, nil
		},
		signedDownloadURLFn: func(_ context.Context, key string, expiry time.Duration) (string, error) {
			assert.Equal(t, "workflow-cache/repos/77/abc.tgz", key)
			assert.Equal(t, 15*time.Minute, expiry)
			return "https://cache.example/download", nil
		},
	}

	metrics := &mockWorkflowCacheMetrics{
		observeRunnerCacheHitFn: func(result string) {
			assert.Equal(t, "hit", result)
		},
	}

	service := NewWorkflowCacheService(
		queries,
		store,
		WorkflowCacheConfig{SignedURLExpiry: 15 * time.Minute},
		WithWorkflowCacheMetrics(metrics),
	)
	result, err := service.Restore(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           101,
		RepositoryID: 77,
		TriggerRef:   "refs/heads/feature/demo",
	}, "npm", "version-123")
	require.NoError(t, err)

	require.True(t, result.CacheHit)
	require.NotNil(t, result.Cache)
	assert.Equal(t, int64(9), result.Cache.ID)
	assert.Equal(t, "main", result.ResolvedBookmark)
	assert.Equal(t, "https://cache.example/download", result.DownloadURL)
}

func TestWorkflowCacheService_Restore_SurvivesHitStatUpdateFailure(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(_ context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           9,
				RepositoryID: 77,
				BookmarkName: "main",
				CacheKey:     "npm",
				CacheVersion: "version-123",
				ObjectKey:    "workflow-cache/repos/77/abc.tgz",
				Compression:  workflowCacheCompression,
				Status:       "finalized",
			}, nil
		},
		touchWorkflowCacheHitFn: func(_ context.Context, id int64) error {
			assert.Equal(t, int64(9), id)
			return errors.New("hit stat update failed")
		},
	}
	store := &mockBlobStore{
		existsFn: func(_ context.Context, key string) (bool, error) {
			return true, nil
		},
		signedDownloadURLFn: func(_ context.Context, key string, expiry time.Duration) (string, error) {
			return "https://cache.example/download", nil
		},
	}

	metrics := &mockWorkflowCacheMetrics{
		observeRunnerCacheHitFn: func(result string) {
			assert.Equal(t, "hit", result)
		},
	}

	service := NewWorkflowCacheService(
		queries,
		store,
		WorkflowCacheConfig{SignedURLExpiry: 15 * time.Minute},
		WithWorkflowCacheMetrics(metrics),
	)
	result, err := service.Restore(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           101,
		RepositoryID: 77,
		TriggerRef:   "refs/heads/main",
	}, "npm", "version-123")

	// A failure to update hit_count/last_hit_at must not fail the restore
	// itself: the caller already has a verified, downloadable cache (issue 142).
	require.NoError(t, err)
	require.True(t, result.CacheHit)
	assert.NotEmpty(t, result.DownloadURL)
}

func TestWorkflowCacheService_Restore_RecordsMissMetricWhenCacheAbsent(t *testing.T) {
	t.Parallel()

	metrics := &mockWorkflowCacheMetrics{
		observeRunnerCacheHitFn: func(result string) {
			assert.Equal(t, "miss", result)
		},
	}

	service := NewWorkflowCacheService(
		&mockWorkflowCacheQuerier{
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, DefaultBookmark: "main"}, nil
			},
			findWorkflowCacheForRestoreFn: func(_ context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
				return db.WorkflowCache{}, pgx.ErrNoRows
			},
		},
		&mockBlobStore{},
		WorkflowCacheConfig{},
		WithWorkflowCacheMetrics(metrics),
	)

	result, err := service.Restore(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           101,
		RepositoryID: 77,
		TriggerRef:   "refs/heads/main",
	}, "npm", "version-123")
	require.NoError(t, err)
	assert.False(t, result.CacheHit)
}

func TestWorkflowCacheService_BeginSave_UsesPendingReservationTimeout(t *testing.T) {
	t.Parallel()

	var expectedObjectKey string
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, DefaultBookmark: "main"}, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			assert.Equal(t, int64(55), arg.RepositoryID)
			assert.Equal(t, int64(123), arg.WorkflowRunID.Int64)
			assert.Equal(t, "main", arg.BookmarkName)
			assert.Equal(t, "npm", arg.CacheKey)
			assert.Equal(t, "v1", arg.CacheVersion)
			expectedObjectKey = arg.ObjectKey
			assert.Contains(t, arg.ObjectKey, "workflow-cache/repos/55/")
			assert.True(t, strings.HasSuffix(arg.ObjectKey, ".tgz"))
			assert.Equal(t, int64(10), arg.ObjectSizeBytes)
			assert.Equal(t, workflowCacheCompression, arg.Compression)
			assert.WithinDuration(t, time.Now().UTC().Add(15*time.Minute), arg.ExpiresAt, 5*time.Second)
			return db.WorkflowCache{
				ID:           44,
				RepositoryID: 55,
				WorkflowRunID: pgtype.Int8{
					Int64: 123,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       arg.ObjectKey,
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     arg.Compression,
				Status:          "pending",
				ExpiresAt:       arg.ExpiresAt,
			}, nil
		},
	}, &mockBlobStore{
		signedUploadURLFn: func(_ context.Context, key string, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
			assert.Equal(t, expectedObjectKey, key)
			assert.Equal(t, "application/gzip", contentType)
			assert.Equal(t, int64(10), maxSizeBytes)
			assert.Equal(t, 10*time.Minute, expiry)
			return "https://cache.example/upload", nil
		},
	}, WorkflowCacheConfig{SignedURLExpiry: 10 * time.Minute})

	reservation, err := service.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           123,
		RepositoryID: 55,
		TriggerRef:   "refs/heads/main",
	}, "npm", "v1", 10)
	require.NoError(t, err)

	assert.False(t, reservation.AlreadyExists)
	assert.Equal(t, "https://cache.example/upload", reservation.UploadURL)
	assert.Equal(t, int64(44), reservation.Cache.ID)
}

func TestWorkflowCacheService_BeginSave_SkipsForeignPendingReservation(t *testing.T) {
	t.Parallel()

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(_ context.Context, arg db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           44,
				RepositoryID: 55,
				WorkflowRunID: pgtype.Int8{
					Int64: 999,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/55/foreign.tgz",
				ObjectSizeBytes: 10,
				Compression:     workflowCacheCompression,
				Status:          "pending",
				ExpiresAt:       time.Now().UTC().Add(time.Hour),
			}, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})

	reservation, err := service.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           123,
		RepositoryID: 55,
		TriggerRef:   "refs/heads/main",
	}, "npm", "v1", 10)
	require.NoError(t, err)
	assert.True(t, reservation.AlreadyExists)
	assert.Empty(t, reservation.UploadURL)
	assert.Equal(t, int64(44), reservation.Cache.ID)
}

func TestWorkflowCacheObjectKey_RejectsFieldBoundaryCollisions(t *testing.T) {
	t.Parallel()

	// Under the old "%d\n%s\n%s\n%s" concatenation scheme, these two tuples
	// hash identically: "1\nm\na\nb\nc" == "1\nm\na\nb\nc". The API layer now
	// rejects embedded control characters (see TestValidateWorkflowCacheIdentity_Matrix),
	// but the length-prefixed hash is defense in depth, so exercise the raw
	// derivation function directly (issue 143).
	keyA := workflowCacheObjectKey("workflow-cache", 1, 0, "m", "a", "b\nc")
	keyB := workflowCacheObjectKey("workflow-cache", 1, 0, "m", "a\nb", "c")
	assert.NotEqual(t, keyA, keyB, "field-boundary collision must not produce the same object key")
}

func TestWorkflowCacheObjectKey_DiffersByReservingRun(t *testing.T) {
	t.Parallel()

	// Two concurrent BeginSave calls for the same scope must reserve distinct
	// objects so a stale signed upload URL from one run cannot overwrite the
	// other's reservation (issue 224).
	keyRunA := workflowCacheObjectKey("workflow-cache", 55, 1, "main", "npm", "v1")
	keyRunB := workflowCacheObjectKey("workflow-cache", 55, 2, "main", "npm", "v1")
	assert.NotEqual(t, keyRunA, keyRunB)
}

func TestValidateWorkflowCacheIdentity_RejectsControlCharacters(t *testing.T) {
	t.Parallel()

	_, _, err := validateWorkflowCacheIdentity("a\nb", "v1")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, _, err = validateWorkflowCacheIdentity("npm", "b\nc")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}

func TestWorkflowCacheService_FinalizeSave_ForwardsReservationIdentity(t *testing.T) {
	t.Parallel()

	var captured db.FinalizeWorkflowCacheParams
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           id,
				RepositoryID: 42,
				WorkflowRunID: pgtype.Int8{
					Int64: 7,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: 100,
				Compression:     workflowCacheCompression,
				Status:          "pending",
				ExpiresAt:       time.Now().UTC().Add(time.Hour),
			}, nil
		},
		finalizeWorkflowCacheFn: func(_ context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			captured = arg
			return db.WorkflowCache{
				ID:              arg.ID,
				RepositoryID:    42,
				WorkflowRunID:   arg.WorkflowRunID,
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     workflowCacheCompression,
				Status:          "finalized",
			}, nil
		},
	}, &mockBlobStore{
		statFn: func(_ context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 100}, nil
		},
	}, WorkflowCacheConfig{})

	_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           7,
		RepositoryID: 42,
	}, 10, 100)
	require.NoError(t, err)

	assert.Equal(t, int64(10), captured.ID)
	assert.Equal(t, int64(42), captured.RepositoryID)
	assert.Equal(t, int64(7), captured.WorkflowRunID.Int64)
	assert.True(t, captured.WorkflowRunID.Valid)
	assert.Equal(t, "workflow-cache/repos/42/new.tgz", captured.ObjectKey)
}

func TestWorkflowCacheService_FinalizeSave_RejectsStaleReservationTakeover(t *testing.T) {
	t.Parallel()

	// Simulate a stale finalize losing the CAS in FinalizeWorkflowCache: the
	// row still exists (owned by another run by the time the UPDATE runs), so
	// the query returns pgx.ErrNoRows. The loser must surface a Conflict and
	// must NOT delete the row out from under the run that now owns it
	// (issue 224).
	deleteCalled := false
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           id,
				RepositoryID: 42,
				WorkflowRunID: pgtype.Int8{
					Int64: 7,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: 100,
				Compression:     workflowCacheCompression,
				Status:          "pending",
				ExpiresAt:       time.Now().UTC().Add(time.Hour),
			}, nil
		},
		finalizeWorkflowCacheFn: func(_ context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			deleteCalled = true
			return db.WorkflowCache{ID: id}, nil
		},
	}, &mockBlobStore{
		statFn: func(_ context.Context, key string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 100}, nil
		},
	}, WorkflowCacheConfig{})

	_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           7,
		RepositoryID: 42,
	}, 10, 100)
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
	assert.False(t, deleteCalled, "the CAS loser must not delete a row it no longer owns")
}

func TestWorkflowCacheService_BeginSave_DifferentRunsReserveDifferentObjectKeys(t *testing.T) {
	t.Parallel()

	var objectKeys []string
	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, DefaultBookmark: "main"}, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			objectKeys = append(objectKeys, arg.ObjectKey)
			return db.WorkflowCache{
				ID:              int64(len(objectKeys)),
				RepositoryID:    arg.RepositoryID,
				WorkflowRunID:   arg.WorkflowRunID,
				ObjectKey:       arg.ObjectKey,
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     arg.Compression,
				Status:          "pending",
				ExpiresAt:       arg.ExpiresAt,
			}, nil
		},
	}
	store := &mockBlobStore{
		signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
			return "https://upload", nil
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{})

	_, err := service.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 1, RepositoryID: 55, TriggerRef: "refs/heads/main"}, "npm", "v1", 10)
	require.NoError(t, err)
	_, err = service.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 2, RepositoryID: 55, TriggerRef: "refs/heads/main"}, "npm", "v1", 10)
	require.NoError(t, err)

	require.Len(t, objectKeys, 2)
	assert.NotEqual(t, objectKeys[0], objectKeys[1])
}

func TestWorkflowCacheService_FinalizeSave_UsesReportedSizeWhenStoreSizeUnknown(t *testing.T) {
	t.Parallel()

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           id,
				RepositoryID: 42,
				WorkflowRunID: pgtype.Int8{
					Int64: 7,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: 321,
				Compression:     workflowCacheCompression,
				Status:          "pending",
				ExpiresAt:       time.Now().UTC().Add(time.Hour),
			}, nil
		},
		finalizeWorkflowCacheFn: func(_ context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			assert.Equal(t, int64(321), arg.ObjectSizeBytes)
			return db.WorkflowCache{
				ID:              arg.ID,
				RepositoryID:    42,
				WorkflowRunID:   arg.WorkflowRunID,
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     workflowCacheCompression,
				Status:          "finalized",
			}, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(_ context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			return nil, nil
		},
	}, &mockBlobStore{
		statFn: func(_ context.Context, key string) (blob.ObjectAttrs, error) {
			assert.Equal(t, "workflow-cache/repos/42/new.tgz", key)
			return blob.ObjectAttrs{Size: blob.UnknownObjectSize}, nil
		},
	}, WorkflowCacheConfig{})

	cache, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           7,
		RepositoryID: 42,
	}, 10, 321)
	require.NoError(t, err)
	assert.Equal(t, int64(321), cache.ObjectSizeBytes)
}

func TestWorkflowCacheService_FinalizeSave_RejectsBlobSizeMismatch(t *testing.T) {
	t.Parallel()

	deleted := false
	var deletedKeys []string
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           id,
				RepositoryID: 42,
				WorkflowRunID: pgtype.Int8{
					Int64: 7,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: 12,
				Compression:     workflowCacheCompression,
				Status:          "pending",
				ExpiresAt:       time.Now().UTC().Add(time.Hour),
			}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			deleted = true
			return db.WorkflowCache{ID: id, ObjectKey: "workflow-cache/repos/42/new.tgz"}, nil
		},
	}, &mockBlobStore{
		statFn: func(_ context.Context, key string) (blob.ObjectAttrs, error) {
			assert.Equal(t, "workflow-cache/repos/42/new.tgz", key)
			return blob.ObjectAttrs{Size: 321}, nil
		},
		deleteFn: func(_ context.Context, key string) error {
			deletedKeys = append(deletedKeys, key)
			return nil
		},
	}, WorkflowCacheConfig{})

	_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           7,
		RepositoryID: 42,
	}, 10, 12)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	assert.True(t, deleted)
	assert.Equal(t, []string{
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/42/new.tgz"),
		"workflow-cache/repos/42/new.tgz",
	}, deletedKeys)
}

func TestWorkflowCacheService_FinalizeSave_EvictsExpiredAndOverQuotaCaches(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	deletedIDs := make([]int64, 0, 2)
	deletedKeys := make([]string, 0, 2)

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{
				ID:           id,
				RepositoryID: 42,
				WorkflowRunID: pgtype.Int8{
					Int64: 7,
					Valid: true,
				},
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: 60,
				Compression:     workflowCacheCompression,
				Status:          "pending",
				ExpiresAt:       time.Now().UTC().Add(time.Hour),
			}, nil
		},
		finalizeWorkflowCacheFn: func(_ context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			assert.Equal(t, int64(10), arg.ID)
			assert.Equal(t, int64(60), arg.ObjectSizeBytes)
			return db.WorkflowCache{
				ID:              arg.ID,
				RepositoryID:    42,
				WorkflowRunID:   arg.WorkflowRunID,
				BookmarkName:    "main",
				CacheKey:        "npm",
				CacheVersion:    "v1",
				ObjectKey:       "workflow-cache/repos/42/new.tgz",
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     workflowCacheCompression,
				Status:          "finalized",
			}, nil
		},
		getWorkflowCacheRepoUsageFn: func(_ context.Context, repositoryID int64) (int64, error) {
			assert.Equal(t, int64(42), repositoryID)
			return 130, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(_ context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			return []db.WorkflowCache{
				{
					ID:           5,
					RepositoryID: 42,
					ObjectKey:    "workflow-cache/repos/42/pending.tgz",
					Status:       "pending",
					ExpiresAt:    now.Add(-time.Minute),
				},
				{
					ID:              6,
					RepositoryID:    42,
					ObjectKey:       "workflow-cache/repos/42/old.tgz",
					Status:          "finalized",
					ObjectSizeBytes: 70,
					ExpiresAt:       now.Add(time.Hour),
				},
				{
					ID:              10,
					RepositoryID:    42,
					ObjectKey:       "workflow-cache/repos/42/new.tgz",
					Status:          "finalized",
					ObjectSizeBytes: 60,
					ExpiresAt:       now.Add(time.Hour),
				},
			}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			deletedIDs = append(deletedIDs, id)
			switch id {
			case 5:
				return db.WorkflowCache{ID: 5, ObjectKey: "workflow-cache/repos/42/pending.tgz"}, nil
			case 6:
				return db.WorkflowCache{ID: 6, ObjectKey: "workflow-cache/repos/42/old.tgz", ObjectSizeBytes: 70}, nil
			default:
				return db.WorkflowCache{ID: id}, nil
			}
		},
	}, &mockBlobStore{
		statFn: func(_ context.Context, key string) (blob.ObjectAttrs, error) {
			assert.Equal(t, "workflow-cache/repos/42/new.tgz", key)
			return blob.ObjectAttrs{Size: 60}, nil
		},
		deleteFn: func(_ context.Context, key string) error {
			deletedKeys = append(deletedKeys, key)
			return nil
		},
	}, WorkflowCacheConfig{RepoQuotaBytes: 100})

	cache, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push",
		ID:           7,
		RepositoryID: 42,
	}, 10, 60)
	require.NoError(t, err)

	assert.Equal(t, int64(10), cache.ID)
	assert.Equal(t, []int64{5, 6}, deletedIDs)
	assert.Equal(t, []string{
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/42/new.tgz"),
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/42/pending.tgz"),
		"workflow-cache/repos/42/pending.tgz",
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/42/old.tgz"),
		"workflow-cache/repos/42/old.tgz",
	}, deletedKeys)
}

func TestWorkflowCacheService_Clear_DeletesArchivesAndReturnsTotals(t *testing.T) {
	t.Parallel()

	deletedKeys := make([]string, 0, 2)
	deletedIDs := make([]int64, 0, 2)

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCachesForClearFn: func(_ context.Context, arg db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			assert.Equal(t, "main", arg.BookmarkName)
			assert.Equal(t, "npm", arg.CacheKey)
			return []db.WorkflowCache{
				{ID: 1, RepositoryID: 42, ObjectKey: "workflow-cache/repos/42/a.tgz", ObjectSizeBytes: 11, Status: "finalized"},
				{ID: 2, RepositoryID: 42, ObjectKey: "workflow-cache/repos/42/b.tgz", ObjectSizeBytes: 22, Status: "finalized"},
			}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			deletedIDs = append(deletedIDs, id)
			key := "workflow-cache/repos/42/b.tgz"
			if id == 1 {
				key = "workflow-cache/repos/42/a.tgz"
			}
			return db.WorkflowCache{ID: id, ObjectKey: key}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			deletedKeys = append(deletedKeys, key)
			return nil
		},
	}, WorkflowCacheConfig{})

	result, err := service.Clear(context.Background(), 42, WorkflowCacheListFilter{
		Bookmark: "main",
		CacheKey: "npm",
	})
	require.NoError(t, err)

	assert.Equal(t, int64(2), result.DeletedCount)
	assert.Equal(t, int64(33), result.DeletedBytes)
	assert.Equal(t, []int64{1, 2}, deletedIDs)
	assert.Equal(t, []string{
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/42/a.tgz"),
		"workflow-cache/repos/42/a.tgz",
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/42/b.tgz"),
		"workflow-cache/repos/42/b.tgz",
	}, deletedKeys)
}

// ---------------------------------------------------------------------------
// Cleanup tests
// ---------------------------------------------------------------------------

func TestWorkflowCacheService_Cleanup_EmptyCache_NoRepositories(t *testing.T) {
	t.Parallel()

	// Cleanup should succeed and make no deletions when there are no repos.
	querierCalls := 0
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(_ context.Context) ([]int64, error) {
			querierCalls++
			return nil, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})

	err := service.Cleanup(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, querierCalls, "ListWorkflowCacheRepositoryIDs should be called exactly once")
}

func TestWorkflowCacheService_Cleanup_RemovesExpiredEntries(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	deletedIDs := make([]int64, 0, 2)
	deletedKeys := make([]string, 0, 2)
	callCount := 0

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(_ context.Context) ([]int64, error) {
			return []int64{10}, nil
		},
		getWorkflowCacheRepoUsageFn: func(_ context.Context, repositoryID int64) (int64, error) {
			assert.Equal(t, int64(10), repositoryID)
			return 0, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(_ context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			callCount++
			if callCount > 1 {
				return nil, nil
			}
			return []db.WorkflowCache{
				{
					ID:              1,
					RepositoryID:    10,
					ObjectKey:       "workflow-cache/repos/10/expired-pending.tgz",
					Status:          "pending",
					ObjectSizeBytes: 100,
					ExpiresAt:       now.Add(-time.Hour),
				},
				{
					ID:              2,
					RepositoryID:    10,
					ObjectKey:       "workflow-cache/repos/10/expired-final.tgz",
					Status:          "finalized",
					ObjectSizeBytes: 200,
					ExpiresAt:       now.Add(-time.Minute),
				},
			}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			deletedIDs = append(deletedIDs, id)
			key := "workflow-cache/repos/10/expired-final.tgz"
			if id == 1 {
				key = "workflow-cache/repos/10/expired-pending.tgz"
			}
			return db.WorkflowCache{ID: id, ObjectKey: key}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			deletedKeys = append(deletedKeys, key)
			return nil
		},
	}, WorkflowCacheConfig{RepoQuotaBytes: 10 * 1024 * 1024})

	err := service.Cleanup(context.Background())
	require.NoError(t, err)

	assert.Equal(t, []int64{1, 2}, deletedIDs)
	assert.Equal(t, []string{
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/10/expired-pending.tgz"),
		"workflow-cache/repos/10/expired-pending.tgz",
		blob.PendingUploadKey("workflow-caches", "workflow-cache/repos/10/expired-final.tgz"),
		"workflow-cache/repos/10/expired-final.tgz",
	}, deletedKeys)
}

func TestWorkflowCacheService_Cleanup_DeletesMetadataBeforeBlob(t *testing.T) {
	t.Parallel()

	// Verify that an exact DB deletion claim is durable before touching the
	// blob; final metadata removal happens only after physical deletion.
	now := time.Now().UTC()
	var ops []string
	var mu sync.Mutex

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(_ context.Context) ([]int64, error) {
			return []int64{20}, nil
		},
		getWorkflowCacheRepoUsageFn: func(_ context.Context, _ int64) (int64, error) {
			return 0, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(_ context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			if len(ops) > 0 {
				return nil, nil
			}
			return []db.WorkflowCache{
				{
					ID:        3,
					ObjectKey: "workflow-cache/repos/20/old.tgz",
					Status:    "finalized",
					ExpiresAt: now.Add(-time.Hour),
				},
			}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			mu.Lock()
			ops = append(ops, "db")
			mu.Unlock()
			return db.WorkflowCache{ID: id, ObjectKey: "workflow-cache/repos/20/old.tgz"}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			mu.Lock()
			ops = append(ops, "blob")
			mu.Unlock()
			return nil
		},
	}, WorkflowCacheConfig{RepoQuotaBytes: 10 * 1024 * 1024})

	err := service.Cleanup(context.Background())
	require.NoError(t, err)

	require.Equal(t, []string{"db", "blob", "blob"}, ops, "DB deletion claim must precede staging and final object deletion")
}

func TestWorkflowCacheService_Cleanup_ConcurrentDeletionOfSameEntry_IdempotentOnNotFound(t *testing.T) {
	t.Parallel()

	// Simulate a race: two concurrent cleaners each try to delete the same
	// cache row.  The second delete should tolerate pgx.ErrNoRows gracefully.
	now := time.Now().UTC()
	deleteDBCount := 0
	deleteBlobCount := 0
	var mu sync.Mutex

	callCount := 0
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(_ context.Context) ([]int64, error) {
			return []int64{30}, nil
		},
		getWorkflowCacheRepoUsageFn: func(_ context.Context, _ int64) (int64, error) {
			return 0, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(_ context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			mu.Lock()
			callCount++
			c := callCount
			mu.Unlock()
			if c > 1 {
				return nil, nil
			}
			return []db.WorkflowCache{
				{
					ID:        5,
					ObjectKey: "workflow-cache/repos/30/contested.tgz",
					Status:    "finalized",
					ExpiresAt: now.Add(-time.Hour),
				},
			}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			mu.Lock()
			deleteDBCount++
			n := deleteDBCount
			mu.Unlock()
			if n > 1 {
				// Second caller: row already gone.
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			return db.WorkflowCache{ID: id}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			mu.Lock()
			deleteBlobCount++
			n := deleteBlobCount
			mu.Unlock()
			if n > 1 {
				return blob.ErrObjectNotFound
			}
			return nil
		},
	}, WorkflowCacheConfig{RepoQuotaBytes: 10 * 1024 * 1024})

	// Run two concurrent Cleanup calls.
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			errs[idx] = service.Cleanup(context.Background())
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		assert.NoError(t, err, "Cleanup goroutine %d should not error on concurrent deletion", i)
	}
}

func TestWorkflowCacheService_Cleanup_ContinuesPastFailingRepository(t *testing.T) {
	t.Parallel()

	// Repository 40 holds an expired archive whose blob delete keeps failing
	// (for example a retention hold). The sweep must still expire repository
	// 41's archive and then report repository 40's failure.
	now := time.Now().UTC()
	var mu sync.Mutex
	listed := map[int64]bool{}
	var finalDeletes []int64

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(_ context.Context) ([]int64, error) {
			return []int64{40, 41}, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(_ context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			mu.Lock()
			defer mu.Unlock()
			if listed[arg.RepositoryID] {
				return nil, nil
			}
			listed[arg.RepositoryID] = true
			return []db.WorkflowCache{{
				ID:           arg.RepositoryID * 100,
				RepositoryID: arg.RepositoryID,
				ObjectKey:    "workflow-cache/repos/" + strconv.FormatInt(arg.RepositoryID, 10) + "/old.tgz",
				Status:       "finalized",
				ExpiresAt:    now.Add(-time.Hour),
			}}, nil
		},
		deleteClaimedWorkflowCacheFn: func(_ context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
			mu.Lock()
			finalDeletes = append(finalDeletes, arg.RepositoryID)
			mu.Unlock()
			return db.WorkflowCache{ID: arg.ID, RepositoryID: arg.RepositoryID}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			if strings.Contains(key, "repos/40/") {
				return errors.New("object is under a retention hold")
			}
			return nil
		},
	}, WorkflowCacheConfig{RepoQuotaBytes: 10 * 1024 * 1024})

	err := service.Cleanup(context.Background())
	require.Error(t, err, "the failing repository must still be reported")
	assert.Contains(t, err.Error(), "repository 40")
	assert.Equal(t, []int64{41}, finalDeletes, "a failing repository must not starve later repositories")
}
