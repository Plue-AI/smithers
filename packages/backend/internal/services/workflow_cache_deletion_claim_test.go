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

func workflowCacheDeletionTestRow(status string) db.WorkflowCache {
	return db.WorkflowCache{
		ID: 10, RepositoryID: 42, WorkflowRunID: pgtype.Int8{Int64: 7, Valid: true},
		BookmarkName: "main", CacheKey: "deps", CacheVersion: "v1",
		ObjectKey: "workflow-cache/repos/42/run-7/deps.tgz", ObjectSizeBytes: 64,
		Status: status, ExpiresAt: time.Now().UTC().Add(time.Hour),
	}
}

func TestWorkflowCacheAbort_StaleReservationCannotDeleteWinnerBlob(t *testing.T) {
	t.Parallel()

	captured := workflowCacheDeletionTestRow("pending")
	blobDeleted := false
	queries := &mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return captured, nil
		},
		claimWorkflowCacheDeletionFn: func(_ context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			assert.Equal(t, captured.ID, arg.ID)
			assert.Equal(t, captured.RepositoryID, arg.RepositoryID)
			assert.Equal(t, captured.WorkflowRunID, arg.WorkflowRunID)
			assert.Equal(t, captured.ObjectKey, arg.ObjectKey)
			assert.Equal(t, "pending", arg.ExpectedStatus)
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowCacheService(queries, &mockBlobStore{
		deleteFn: func(context.Context, string) error {
			blobDeleted = true
			return nil
		},
	}, WorkflowCacheConfig{})

	err := svc.AbortSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 7, RepositoryID: 42}, captured.ID)
	require.NoError(t, err)
	assert.False(t, blobDeleted, "a failed identity claim must not touch the observed object key")
}

func TestWorkflowCacheDeletion_BlobFailureRetainsAndReleasesClaim(t *testing.T) {
	t.Parallel()

	captured := workflowCacheDeletionTestRow("pending")
	var claimToken pgtype.Text
	released := false
	finalDeleteCalled := false
	queries := &mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return captured, nil
		},
		claimWorkflowCacheDeletionFn: func(_ context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			claimToken = arg.DeletionToken
			claimed := captured
			claimed.Status = "deleting"
			claimed.DeletionToken = arg.DeletionToken
			return claimed, nil
		},
		releaseWorkflowCacheDeletionClaimFn: func(_ context.Context, arg db.ReleaseWorkflowCacheDeletionClaimParams) error {
			released = true
			assert.Equal(t, claimToken, arg.DeletionToken)
			assert.Equal(t, captured.ObjectKey, arg.ObjectKey)
			return nil
		},
		deleteClaimedWorkflowCacheFn: func(context.Context, db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
			finalDeleteCalled = true
			return db.WorkflowCache{}, nil
		},
	}
	svc := NewWorkflowCacheService(queries, &mockBlobStore{
		deleteFn: func(context.Context, string) error { return errors.New("gcs unavailable") },
	}, WorkflowCacheConfig{})

	err := svc.AbortSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 7, RepositoryID: 42}, captured.ID)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, claimToken.Valid)
	assert.NotEmpty(t, claimToken.String)
	assert.True(t, released, "failed physical deletion must release or lease the retained metadata claim")
	assert.False(t, finalDeleteCalled, "metadata must remain while physical bytes still exist")
}

func TestWorkflowCacheCleanup_RetriesDeletingClaimThenRemovesMetadata(t *testing.T) {
	t.Parallel()

	deleting := workflowCacheDeletionTestRow("deleting")
	deleting.ExpiresAt = time.Now().UTC().Add(-time.Hour)
	candidateCalls := 0
	physicalCalls := 0
	metadataDeleted := false
	var retryToken pgtype.Text
	queries := &mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(context.Context) ([]int64, error) {
			return []int64{deleting.RepositoryID}, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			return deleting.ObjectSizeBytes, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			candidateCalls++
			if candidateCalls == 1 {
				return []db.WorkflowCache{deleting}, nil
			}
			return nil, nil
		},
		retryWorkflowCacheDeletionFn: func(_ context.Context, arg db.RetryWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			retryToken = arg.DeletionToken
			claimed := deleting
			claimed.DeletionToken = arg.DeletionToken
			return claimed, nil
		},
		deleteClaimedWorkflowCacheFn: func(_ context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
			metadataDeleted = true
			assert.Equal(t, retryToken, arg.DeletionToken)
			return deleting, nil
		},
	}
	svc := NewWorkflowCacheService(queries, &mockBlobStore{
		deleteFn: func(_ context.Context, key string) error {
			physicalCalls++
			if physicalCalls == 1 {
				assert.Equal(t, blob.PendingUploadKey("workflow-caches", deleting.ObjectKey), key)
			} else {
				assert.Equal(t, deleting.ObjectKey, key)
			}
			return blob.ErrObjectNotFound
		},
	}, WorkflowCacheConfig{})

	require.NoError(t, svc.Cleanup(context.Background()))
	assert.Equal(t, 2, physicalCalls)
	assert.True(t, metadataDeleted)
}

func TestWorkflowCacheBeginSave_DeletingLeaseReturnsRetryableConflict(t *testing.T) {
	t.Parallel()

	deleting := workflowCacheDeletionTestRow("deleting")
	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: deleting.RepositoryID, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return deleting, nil
		},
		retryWorkflowCacheDeletionFn: func(context.Context, db.RetryWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}
	svc := NewWorkflowCacheService(queries, &mockBlobStore{}, WorkflowCacheConfig{})

	_, err := svc.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 7, RepositoryID: 42}, "deps", "v1", 10)
	require.Error(t, err)
	assert.Equal(t, 409, apiStatus(t, err))
}
