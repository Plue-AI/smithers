package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type workflowCacheCovBillingPolicy struct {
	storageErr error
}

func (p workflowCacheCovBillingPolicy) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (p workflowCacheCovBillingPolicy) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}
func (p workflowCacheCovBillingPolicy) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (p workflowCacheCovBillingPolicy) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return p.storageErr
}
func (p workflowCacheCovBillingPolicy) AuthorizePairing(context.Context, int64) error {
	return nil
}

func TestWorkflowCache_Cov_RestoreDeletesMissingArchive(t *testing.T) {
	deleted := false
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: 9, RepositoryID: 7, BookmarkName: "main", CacheKey: "npm", CacheVersion: "v1", ObjectKey: "cache/missing.tgz", Status: "finalized"}, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			deleted = true
			return db.WorkflowCache{}, nil
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, nil },
		deleteFn: func(context.Context, string) error { return nil },
	}, WorkflowCacheConfig{})

	result, err := service.Restore(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 1, RepositoryID: 7, TriggerRef: "refs/tags/v1"}, "npm", "")
	require.NoError(t, err)
	assert.False(t, result.CacheHit)
	assert.True(t, deleted)
}

func TestWorkflowCache_Cov_BeginSaveExistingExpiredAndForeignPending(t *testing.T) {
	now := time.Now().UTC()
	deletedIDs := []int64{}
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: 1, RepositoryID: 7, WorkflowRunID: pgtype.Int8{Int64: 999, Valid: true}, ObjectKey: "cache/expired.tgz", ObjectSizeBytes: 10, Compression: workflowCacheCompression, Status: "pending", ExpiresAt: now.Add(-time.Hour)}, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: 2, RepositoryID: 7, WorkflowRunID: pgtype.Int8{Int64: 5, Valid: true}, ObjectKey: arg.ObjectKey, ObjectSizeBytes: arg.ObjectSizeBytes, Compression: arg.Compression, Status: "pending", ExpiresAt: now.Add(time.Hour)}, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			deletedIDs = append(deletedIDs, id)
			return db.WorkflowCache{ID: id}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return nil },
		signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
			return "https://upload", nil
		},
	}, WorkflowCacheConfig{})

	reservation, err := service.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 5, RepositoryID: 7, TriggerRef: "bookmarks/main"}, " key ", "", 10)
	require.NoError(t, err)
	assert.Equal(t, int64(2), reservation.Cache.ID)
	assert.Equal(t, "https://upload", reservation.UploadURL)
	assert.Equal(t, []int64{1}, deletedIDs)
}

func TestWorkflowCache_Cov_FinalizeDoesNotRechargeAndOnlyPurgesStaging(t *testing.T) {
	var deletedKey string
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: 10, RepositoryID: 42, WorkflowRunID: pgtype.Int8{Int64: 7, Valid: true}, ObjectKey: "cache/new.tgz", ObjectSizeBytes: 100, Status: "pending"}, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: 10, ObjectKey: "cache/new.tgz"}, nil
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: 100}, nil
		},
		deleteFn: func(_ context.Context, key string) error {
			deletedKey = key
			return nil
		},
	}, WorkflowCacheConfig{}, WithWorkflowCacheBillingPolicy(workflowCacheCovBillingPolicy{storageErr: errors.New("quota denied")}))

	_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 7, RepositoryID: 42}, 10, 100)
	require.NoError(t, err)
	assert.Equal(t, blob.PendingUploadKey("workflow-caches", "cache/new.tgz"), deletedKey)
}

func TestWorkflowCache_Cov_AbortListClearStatsAndCleanupErrors(t *testing.T) {
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{}, &mockBlobStore{}, WorkflowCacheConfig{})
	err := service.AbortSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 1, RepositoryID: 1}, 0)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	require.NoError(t, service.AbortSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 1, RepositoryID: 1}, 1))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCachesFn: func(_ context.Context, arg db.ListWorkflowCachesParams) ([]db.WorkflowCache, error) {
			assert.Equal(t, "main", arg.BookmarkName)
			assert.Equal(t, "npm", arg.CacheKey)
			assert.Equal(t, int32(100), arg.PageSize)
			return []db.WorkflowCache{{ID: 3}}, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	rows, err := service.List(context.Background(), 8, WorkflowCacheListFilter{Bookmark: " main ", CacheKey: " npm ", Page: -1, PerPage: 500})
	require.NoError(t, err)
	assert.Equal(t, int64(3), rows[0].ID)

	_, err = service.List(context.Background(), 0, WorkflowCacheListFilter{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	lastHit := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	maxExp := lastHit.Add(time.Hour)
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheStatsFn: func(context.Context, int64) (db.GetWorkflowCacheStatsRow, error) {
			return db.GetWorkflowCacheStatsRow{
				CacheCount:     2,
				TotalSizeBytes: 99,
				LastHitAt:      pgtype.Timestamptz{Time: lastHit, Valid: true},
				MaxExpiresAt:   &maxExp,
			}, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{RepoQuotaBytes: 123, ArchiveMaxBytes: 45, TTL: 2 * time.Hour})
	stats, err := service.Stats(context.Background(), 8)
	require.NoError(t, err)
	assert.Equal(t, int64(2), stats.CacheCount)
	require.NotNil(t, stats.LastHitAt)
	assert.Equal(t, lastHit, *stats.LastHitAt)
	require.NotNil(t, stats.MaxExpiresAt)
	assert.Equal(t, maxExp, *stats.MaxExpiresAt)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(context.Context) ([]int64, error) {
			return nil, errors.New("list failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	err = service.Cleanup(context.Background())
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkflowCache_Cov_DeleteRowToleratesMissingMetadataAndBlob(t *testing.T) {
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return blob.ErrObjectNotFound },
	}, WorkflowCacheConfig{}).(*workflowCacheService)

	deleted, err := service.deleteCacheRow(context.Background(), db.WorkflowCache{ID: 99, ObjectKey: "missing", Status: "finalized"})
	require.NoError(t, err)
	assert.False(t, deleted)
	deleted, err = service.deleteCacheRow(context.Background(), db.WorkflowCache{ID: 99, ObjectKey: "   ", Status: "finalized"})
	require.NoError(t, err)
	assert.False(t, deleted)
}

func (workflowCacheCovBillingPolicy) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (workflowCacheCovBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
