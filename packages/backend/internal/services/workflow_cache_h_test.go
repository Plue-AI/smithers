package services

import (
	"context"
	"errors"
	"strings"
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

type workflowCacheHBillingPolicy struct {
	storageErr error
}

func (p workflowCacheHBillingPolicy) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (p workflowCacheHBillingPolicy) AuthorizeWorkflowDispatchCommitted(ctx context.Context, _ int64, commit func(context.Context, pgx.Tx) error) error {
	return commit(ctx, nil)
}
func (p workflowCacheHBillingPolicy) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (p workflowCacheHBillingPolicy) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return p.storageErr
}

func workflowCacheHRun() db.WorkflowRun {
	return db.WorkflowRun{TriggerEvent: "push", ID: 5, RepositoryID: 7, TriggerRef: "refs/heads/main"}
}

func workflowCacheHCache(status string) db.WorkflowCache {
	return db.WorkflowCache{
		ID:              9,
		RepositoryID:    7,
		WorkflowRunID:   pgtype.Int8{Int64: 5, Valid: true},
		BookmarkName:    "main",
		CacheKey:        "npm",
		CacheVersion:    workflowCacheStaticVersion,
		ObjectKey:       "workflow-cache/repos/7/cache.tgz",
		ObjectSizeBytes: 10,
		Status:          status,
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
	}
}

func TestWorkflowCache_H_RestoreBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowCacheHRun()

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err := service.Restore(ctx, run, "", "")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = service.Restore(ctx, run, "npm", strings.Repeat("v", workflowCacheMaxVersionLength+1))
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.Restore(ctx, run, "npm", "")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("select failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.Restore(ctx, run, "npm", "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	metricsSeen := ""
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{}, WithWorkflowCacheMetrics(&mockWorkflowCacheMetrics{
		observeRunnerCacheHitFn: func(result string) { metricsSeen = result },
	}))
	result, err := service.Restore(ctx, run, "npm", "")
	require.NoError(t, err)
	assert.False(t, result.CacheHit)
	assert.Equal(t, "miss", metricsSeen)

	cache := workflowCacheHCache("finalized")
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return cache, nil
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, errors.New("exists failed") },
	}, WorkflowCacheConfig{})
	_, err = service.Restore(ctx, run, "npm", "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	// A failure to update hit_count/last_hit_at is best-effort and must not
	// fail the restore: the archive itself is already verified and its
	// download URL signed (issue 142).
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return cache, nil
		},
		touchWorkflowCacheHitFn: func(context.Context, int64) error { return errors.New("touch failed") },
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return true, nil },
		signedDownloadURLFn: func(context.Context, string, time.Duration) (string, error) {
			return "https://download", nil
		},
	}, WorkflowCacheConfig{})
	touchFailResult, err := service.Restore(ctx, run, "npm", "")
	require.NoError(t, err)
	assert.True(t, touchFailResult.CacheHit)
	assert.Equal(t, "https://download", touchFailResult.DownloadURL)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		findWorkflowCacheForRestoreFn: func(context.Context, db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error) {
			return cache, nil
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return true, nil },
		signedDownloadURLFn: func(context.Context, string, time.Duration) (string, error) {
			return "", errors.New("sign failed")
		},
	}, WorkflowCacheConfig{})
	_, err = service.Restore(ctx, run, "npm", "")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkflowCache_H_BeginSaveBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowCacheHRun()
	var cleared []runtimeports.ClearPurgedStorageDeletionByExactKeyParams
	var failedSignerObjectKey string

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		upsertPendingWorkflowCacheFn: func(context.Context, db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("upsert failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err := service.BeginSave(ctx, run, "npm", "", 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			cache := workflowCacheHCache("finalized")
			cache.ExpiresAt = time.Now().Add(-time.Hour)
			return cache, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			cache := workflowCacheHCache("pending")
			cache.ObjectKey = arg.ObjectKey
			cache.ObjectSizeBytes = arg.ObjectSizeBytes
			cache.Status = "pending"
			return cache, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return nil },
		signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
			return "https://upload", nil
		},
	}, WorkflowCacheConfig{})
	reservation, err := service.BeginSave(ctx, run, "npm", "", 10)
	require.NoError(t, err)
	assert.Equal(t, "https://upload", reservation.UploadURL)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return workflowCacheHCache("finalized"), nil
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return true, nil },
	}, WorkflowCacheConfig{})
	reservation, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.NoError(t, err)
	assert.True(t, reservation.AlreadyExists)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			cache := workflowCacheHCache("finalized")
			cache.ExpiresAt = time.Now().Add(time.Hour)
			return cache, nil
		},
	}, &mockBlobStore{
		existsFn: func(context.Context, string) (bool, error) { return false, errors.New("exists failed") },
	}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			cache := workflowCacheHCache("pending")
			cache.WorkflowRunID = pgtype.Int8{Int64: 999, Valid: true}
			cache.ExpiresAt = time.Now().Add(time.Hour)
			return cache, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	reservation, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.NoError(t, err)
	assert.True(t, reservation.AlreadyExists)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		clearPurgedStorageDeletionFn: func(_ context.Context, arg runtimeports.ClearPurgedStorageDeletionByExactKeyParams) (int64, error) {
			cleared = append(cleared, arg)
			return 1, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			failedSignerObjectKey = arg.ObjectKey
			cache := workflowCacheHCache("pending")
			cache.ObjectKey = arg.ObjectKey
			cache.ObjectSizeBytes = arg.ObjectSizeBytes
			return cache, nil
		},
	}, &mockBlobStore{
		signedUploadURLFn: func(context.Context, string, string, int64, time.Duration) (string, error) {
			return "", errors.New("sign failed")
		},
	}, WorkflowCacheConfig{})
	_, err = service.BeginSave(ctx, run, "npm", "", 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	require.Len(t, cleared, 2)
	for _, call := range cleared {
		assert.Equal(t, int64(7), call.RepositoryID)
		assert.Equal(t, workflowCacheStorageAllocationKey(7, failedSignerObjectKey), call.AllocationKey)
	}
	assert.ElementsMatch(t, []string{
		failedSignerObjectKey,
		blob.PendingUploadKey("workflow-caches", failedSignerObjectKey),
	}, []string{cleared[0].ObjectKey, cleared[1].ObjectKey})
}

func TestWorkflowCache_H_FinalizeSaveBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowCacheHRun()
	pending := workflowCacheHCache("pending")

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err := service.FinalizeSave(ctx, run, 0, 1)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = service.FinalizeSave(ctx, run, 1, -1)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	for name, cacheErr := range map[string]error{"not-found": pgx.ErrNoRows, "internal": errors.New("select failed")} {
		t.Run(name, func(t *testing.T) {
			service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
				getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
					return db.WorkflowCache{}, cacheErr
				},
			}, &mockBlobStore{}, WorkflowCacheConfig{})
			_, err := service.FinalizeSave(ctx, run, 9, 1)
			require.Error(t, err)
			if errors.Is(cacheErr, pgx.ErrNoRows) {
				assert.Equal(t, 404, apiStatus(t, err))
			} else {
				assert.Equal(t, 500, apiStatus(t, err))
			}
		})
	}

	for name, cache := range map[string]db.WorkflowCache{
		"wrong-repo": func() db.WorkflowCache { c := pending; c.RepositoryID = 999; return c }(),
		"wrong-run": func() db.WorkflowCache {
			c := pending
			c.WorkflowRunID = pgtype.Int8{Int64: 999, Valid: true}
			return c
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
				getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
					return cache, nil
				},
			}, &mockBlobStore{}, WorkflowCacheConfig{})
			_, err := service.FinalizeSave(ctx, run, 9, 10)
			require.Error(t, err)
		})
	}

	finalizedService := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return workflowCacheHCache("finalized"), nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	gotFinalized, err := finalizedService.FinalizeSave(ctx, run, 9, 10)
	require.NoError(t, err)
	assert.Equal(t, "finalized", gotFinalized.Status)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return pending, nil
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{}, blob.ErrObjectNotFound
		},
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return pending, nil
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{}, errors.New("stat failed")
		},
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return pending, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: id}, nil
		},
	}, &mockBlobStore{
		statFn:   func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: -2}, nil },
		deleteFn: func(context.Context, string) error { return nil },
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return pending, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: id}, nil
		},
	}, &mockBlobStore{
		statFn:   func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 11}, nil },
		deleteFn: func(context.Context, string) error { return nil },
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	oversizePending := pending
	oversizePending.ObjectSizeBytes = 99
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return oversizePending, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete metadata failed")
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 99}, nil },
	}, WorkflowCacheConfig{ArchiveMaxBytes: 20})
	_, err = service.FinalizeSave(ctx, run, 9, 99)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return pending, nil
		},
		finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) {
			return blob.ObjectAttrs{Size: blob.UnknownObjectSize}, nil
		},
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return pending, nil
		},
		finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("finalize failed")
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 10}, nil },
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return pending, nil },
		finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			finalized := pending
			finalized.Status = "finalized"
			return finalized, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			return 0, errors.New("usage failed")
		},
	}, &mockBlobStore{
		statFn: func(context.Context, string) (blob.ObjectAttrs, error) { return blob.ObjectAttrs{Size: 10}, nil },
	}, WorkflowCacheConfig{})
	_, err = service.FinalizeSave(ctx, run, 9, 10)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkflowCache_H_AbortCleanupListClearStatsAndHelpers(t *testing.T) {
	ctx := context.Background()
	run := workflowCacheHRun()
	pending := workflowCacheHCache("pending")

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("select failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	err := service.AbortSave(ctx, run, 9)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	for _, cache := range []db.WorkflowCache{
		func() db.WorkflowCache { c := pending; c.RepositoryID = 99; return c }(),
		func() db.WorkflowCache { c := pending; c.WorkflowRunID = pgtype.Int8{Int64: 99, Valid: true}; return c }(),
		workflowCacheHCache("finalized"),
	} {
		service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
			getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return cache, nil },
		}, &mockBlobStore{}, WorkflowCacheConfig{})
		err := service.AbortSave(ctx, run, 9)
		if cache.Status == "finalized" {
			require.NoError(t, err)
		} else {
			require.Error(t, err)
		}
	}

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(context.Context) ([]int64, error) {
			return []int64{0, 7}, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 0, nil },
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			return nil, nil
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	require.NoError(t, service.Cleanup(ctx))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCachesFn: func(context.Context, db.ListWorkflowCachesParams) ([]db.WorkflowCache, error) {
			return nil, errors.New("list failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.List(ctx, 7, WorkflowCacheListFilter{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.Clear(ctx, 0, WorkflowCacheListFilter{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCachesForClearFn: func(context.Context, db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error) {
			return nil, errors.New("clear failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.Clear(ctx, 7, WorkflowCacheListFilter{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		listWorkflowCachesForClearFn: func(context.Context, db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error) {
			return []db.WorkflowCache{workflowCacheHCache("finalized")}, nil
		},
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) { return db.WorkflowCache{}, nil },
	}, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return nil },
	}, WorkflowCacheConfig{})
	clearResult, err := service.Clear(ctx, 7, WorkflowCacheListFilter{Bookmark: " main ", CacheKey: " npm "})
	require.NoError(t, err)
	assert.Equal(t, int64(1), clearResult.DeletedCount)
	assert.Equal(t, int64(10), clearResult.DeletedBytes)

	_, err = service.Stats(ctx, 0)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheStatsFn: func(context.Context, int64) (db.GetWorkflowCacheStatsRow, error) {
			return db.GetWorkflowCacheStatsRow{}, errors.New("stats failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	_, err = service.Stats(ctx, 7)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	tm := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	got, ok := workflowCacheNullableTime(&tm)
	require.True(t, ok)
	assert.Equal(t, tm, got)
	_, ok = workflowCacheNullableTime("not-a-time")
	assert.False(t, ok)
	assert.Equal(t, "main", normalizeWorkflowCacheBookmark("refs/heads/main", "default"))
	assert.Equal(t, "main", normalizeWorkflowCacheBookmark("refs/bookmarks/main", "default"))
	assert.Equal(t, "default", normalizeWorkflowCacheBookmark("refs/tags/v1", "default"))
	assert.Equal(t, "default", normalizeWorkflowCacheBookmark("refs/changes/1", "default"))
}

func TestWorkflowCache_H_EnforcePolicyAndDeleteRowBranches(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	pendingExpired := workflowCacheHCache("pending")
	pendingExpired.ID = 1
	pendingExpired.ObjectKey = "workflow-cache/repos/7/pending.tgz"
	pendingExpired.ExpiresAt = now.Add(-time.Hour)
	finalizedExpired := workflowCacheHCache("finalized")
	finalizedExpired.ID = 2
	finalizedExpired.ObjectKey = "workflow-cache/repos/7/finalized.tgz"
	finalizedExpired.ObjectSizeBytes = 80
	finalizedExpired.ExpiresAt = now.Add(-time.Hour)
	protected := workflowCacheHCache("finalized")
	protected.ID = 3

	deleted := []int64{}
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 150, nil },
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			if len(deleted) == 0 {
				return []db.WorkflowCache{protected, pendingExpired, finalizedExpired}, nil
			}
			return nil, nil
		},
		deleteWorkflowCacheByIDFn: func(_ context.Context, id int64) (db.WorkflowCache, error) {
			switch id {
			case pendingExpired.ID:
				return pendingExpired, nil
			case finalizedExpired.ID:
				return finalizedExpired, nil
			default:
				return db.WorkflowCache{ID: id}, nil
			}
		},
	}, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			switch key {
			case pendingExpired.ObjectKey:
				deleted = append(deleted, pendingExpired.ID)
			case finalizedExpired.ObjectKey:
				deleted = append(deleted, finalizedExpired.ID)
			}
			return nil
		},
	}, WorkflowCacheConfig{RepoQuotaBytes: 100}).(*workflowCacheService)
	require.NoError(t, service.enforceRepositoryCachePolicy(ctx, 7, protected.ID))
	assert.ElementsMatch(t, []int64{1, 2}, deleted)

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) { return 0, nil },
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			return nil, errors.New("candidate failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{}).(*workflowCacheService)
	err := service.enforceRepositoryCachePolicy(ctx, 7, 0)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, errors.New("delete metadata failed")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{}).(*workflowCacheService)
	_, err = service.deleteCacheRow(ctx, db.WorkflowCache{ID: 9, ObjectKey: "key", Status: "finalized"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	service = NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		deleteWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return db.WorkflowCache{ID: 9, ObjectKey: "key"}, nil
		},
	}, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return errors.New("blob delete failed") },
	}, WorkflowCacheConfig{}).(*workflowCacheService)
	_, err = service.deleteCacheRow(ctx, db.WorkflowCache{ID: 9, ObjectKey: "key", Status: "finalized"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func (workflowCacheHBillingPolicy) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (workflowCacheHBillingPolicy) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}

// A saved archive is restored by main and, as the fallback bookmark, by every
// other bookmark. A run of unreviewed code or of someone else's input (an
// agent message, a landing request, issue text) restores but never saves,
// whatever ref it names; a push, a schedule or a dispatch saves.
func TestWorkflowCache_OnlyMaintainerRunsSave(t *testing.T) {
	reserved := 0
	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 7, DefaultBookmark: "main"}, nil
		},
		upsertPendingWorkflowCacheFn: func(context.Context, db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			reserved++
			return db.WorkflowCache{}, errors.New("reserved")
		},
	}, &mockBlobStore{}, WorkflowCacheConfig{})
	for _, event := range []string{"agent_message", "landing_request", "issues", "issue_comment", "invoke", "manual", "webhook", "monitoring_alert", "workflow_run", ""} {
		for _, ref := range []string{"", "main", "refs/heads/main", "refs/tags/v1", "feature"} {
			_, err := service.BeginSave(context.Background(), db.WorkflowRun{ID: 5, RepositoryID: 7, TriggerEvent: event, TriggerRef: ref}, "npm", "", 10)
			require.Error(t, err, "%s on %q", event, ref)
			assert.Equal(t, 403, apiStatus(t, err), "%s on %q", event, ref)
		}
	}
	require.Zero(t, reserved, "a refused run reserved a cache entry")
	for _, event := range []string{"push", "schedule", "workflow_dispatch", "manual_dispatch"} {
		_, _ = service.BeginSave(context.Background(), db.WorkflowRun{ID: 5, RepositoryID: 7, TriggerEvent: event, TriggerRef: "main"}, "npm", "", 10)
	}
	require.Equal(t, 4, reserved)
}
