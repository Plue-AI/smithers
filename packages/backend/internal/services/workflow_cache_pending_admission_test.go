package services

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// workflowCachePendingStore models the production create-only signer/promoter
// contract while retaining only object attributes. It is deliberately safe for
// the race detector so admission and finalization barriers can use real
// goroutines.
type workflowCachePendingStore struct {
	mu sync.Mutex

	objects      map[string]blob.ObjectAttrs
	signedKeys   []string
	signedSizes  []int64
	deleteKeys   []string
	afterPromote func(sourceKey, destinationKey string) error
}

func newWorkflowCachePendingStore() *workflowCachePendingStore {
	return &workflowCachePendingStore{objects: make(map[string]blob.ObjectAttrs)}
}

func (s *workflowCachePendingStore) SignedCreateOnlyUploadURL(_ context.Context, key, contentType string, exactSizeBytes int64, _ time.Duration) (blob.SignedUpload, error) {
	s.mu.Lock()
	s.signedKeys = append(s.signedKeys, key)
	s.signedSizes = append(s.signedSizes, exactSizeBytes)
	s.mu.Unlock()
	return blob.SignedUpload{
		URL: "https://upload.example/" + key,
		Header: map[string]string{
			"Content-Type":                contentType,
			"x-goog-if-generation-match":  "0",
			"x-goog-content-length-range": fmt.Sprintf("%d,%d", exactSizeBytes, exactSizeBytes),
		},
	}, nil
}

func (s *workflowCachePendingStore) SignedUploadURL(context.Context, string, string, int64, time.Duration) (string, error) {
	return "", fmt.Errorf("plain upload signing must not be used")
}

func (s *workflowCachePendingStore) SignedDownloadURL(context.Context, string, time.Duration) (string, error) {
	return "https://download.example/cache", nil
}

func (s *workflowCachePendingStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteKeys = append(s.deleteKeys, key)
	delete(s.objects, key)
	return nil
}

func (s *workflowCachePendingStore) Exists(_ context.Context, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok, nil
}

func (s *workflowCachePendingStore) Stat(_ context.Context, key string) (blob.ObjectAttrs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	attrs, ok := s.objects[key]
	if !ok {
		return blob.ObjectAttrs{}, blob.ErrObjectNotFound
	}
	return attrs, nil
}

func (s *workflowCachePendingStore) NewReader(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

func (s *workflowCachePendingStore) PromoteCreateOnly(_ context.Context, sourceKey, destinationKey string) error {
	s.mu.Lock()
	attrs, ok := s.objects[sourceKey]
	if !ok {
		s.mu.Unlock()
		return blob.ErrObjectNotFound
	}
	if _, exists := s.objects[destinationKey]; exists {
		s.mu.Unlock()
		return blob.ErrObjectAlreadyExists
	}
	s.objects[destinationKey] = attrs
	delete(s.objects, sourceKey)
	hook := s.afterPromote
	s.mu.Unlock()
	if hook != nil {
		return hook(sourceKey, destinationKey)
	}
	return nil
}

func (s *workflowCachePendingStore) put(key string, size int64) {
	s.mu.Lock()
	s.objects[key] = blob.ObjectAttrs{Size: size}
	s.mu.Unlock()
}

func (s *workflowCachePendingStore) has(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok
}

func (s *workflowCachePendingStore) signingSnapshot() ([]string, []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.signedKeys...), append([]int64(nil), s.signedSizes...)
}

var _ blob.Store = (*workflowCachePendingStore)(nil)
var _ blob.CreateOnlyUploadSigner = (*workflowCachePendingStore)(nil)
var _ blob.CreateOnlyPromoter = (*workflowCachePendingStore)(nil)

type serializedWorkflowCacheBilling struct {
	mu   sync.Mutex
	deny bool
}

func (*serializedWorkflowCacheBilling) AuthorizePrivateRepo(context.Context, string, int64) error {
	return nil
}
func (*serializedWorkflowCacheBilling) AuthorizeWorkflowDispatch(context.Context, int64) error {
	return nil
}
func (*serializedWorkflowCacheBilling) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	return commit(ctx, nil)
}
func (*serializedWorkflowCacheBilling) AuthorizeStorageIncrease(context.Context, int64, int64) error {
	return nil
}
func (*serializedWorkflowCacheBilling) AuthorizePairing(context.Context, int64) error { return nil }
func (b *serializedWorkflowCacheBilling) AuthorizeStorageIncreaseCommittedDynamic(
	ctx context.Context,
	_ int64,
	resolveAdditionalBytes func(context.Context) (int64, error),
	commit func(context.Context) error,
) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	additionalBytes, err := resolveAdditionalBytes(ctx)
	if err != nil {
		return err
	}
	if additionalBytes < 0 {
		return fmt.Errorf("negative storage delta")
	}
	if b.deny {
		return pkgerrors.Forbidden("storage cap exceeded for the current billing plan")
	}
	return commit(ctx)
}

func TestWorkflowCacheBeginSave_StagesDeclaredSizeAndRotatesSameRunCapability(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	run := db.WorkflowRun{TriggerEvent: "push", ID: 9, RepositoryID: 42, TriggerRef: "refs/heads/main"}
	var stateMu sync.Mutex
	var row *db.WorkflowCache
	nextID := int64(1)
	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if row == nil {
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			return *row, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if row == nil {
				return 0, nil
			}
			return row.ObjectSizeBytes, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			created := db.WorkflowCache{
				ID:              nextID,
				RepositoryID:    arg.RepositoryID,
				WorkflowRunID:   arg.WorkflowRunID,
				BookmarkName:    arg.BookmarkName,
				CacheKey:        arg.CacheKey,
				CacheVersion:    arg.CacheVersion,
				ObjectKey:       arg.ObjectKey,
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     arg.Compression,
				Status:          "pending",
				ExpiresAt:       arg.ExpiresAt,
			}
			nextID++
			row = &created
			return created, nil
		},
		claimWorkflowCacheDeletionFn: func(_ context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if row == nil || row.ID != arg.ID || row.ObjectKey != arg.ObjectKey || row.Status != arg.ExpectedStatus {
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			row.Status = "deleting"
			row.DeletionToken = arg.DeletionToken
			return *row, nil
		},
		deleteClaimedWorkflowCacheFn: func(_ context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if row == nil || row.ID != arg.ID || row.ObjectKey != arg.ObjectKey || row.DeletionToken != arg.DeletionToken {
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			deleted := *row
			row = nil
			return deleted, nil
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{SignedURLExpiry: 2 * time.Minute})

	first, err := service.BeginSave(context.Background(), run, "npm", "v1", 17)
	require.NoError(t, err)
	firstPending := blob.PendingUploadKey("workflow-caches", first.Cache.ObjectKey)
	assert.Equal(t, map[string]string{
		"Content-Type":                "application/gzip",
		"x-goog-if-generation-match":  "0",
		"x-goog-content-length-range": "17,17",
	}, first.UploadHeaders)
	assert.WithinDuration(t, time.Now().UTC().Add(7*time.Minute), first.Cache.ExpiresAt, 5*time.Second)
	store.put(firstPending, 17)

	second, err := service.BeginSave(context.Background(), run, "npm", "v1", 19)
	require.NoError(t, err)
	secondPending := blob.PendingUploadKey("workflow-caches", second.Cache.ObjectKey)
	assert.NotEqual(t, first.Cache.ObjectKey, second.Cache.ObjectKey)
	assert.NotEqual(t, firstPending, secondPending)
	assert.False(t, store.has(firstPending), "replacement must purge the old staged object")

	// Model the old signed URL being used after replacement. Its immutable key
	// is abandoned and lifecycle-bounded; it cannot affect the new reservation.
	store.put(firstPending, 17)
	assert.True(t, store.has(firstPending))
	assert.False(t, store.has(secondPending))
	assert.False(t, store.has(second.Cache.ObjectKey))
	keys, sizes := store.signingSnapshot()
	assert.Equal(t, []string{firstPending, secondPending}, keys)
	assert.Equal(t, []int64{17, 19}, sizes)
}

func TestWorkflowCacheBeginSave_ConcurrentPendingReservationsRespectRepoQuota(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	billing := &serializedWorkflowCacheBilling{}
	var stateMu sync.Mutex
	rows := make(map[string]db.WorkflowCache)
	nextID := int64(1)
	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(_ context.Context, arg db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			row, ok := rows[arg.CacheKey]
			if !ok {
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			return row, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			var usage int64
			for _, row := range rows {
				usage += row.ObjectSizeBytes
			}
			return usage, nil
		},
		upsertPendingWorkflowCacheFn: func(_ context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			created := db.WorkflowCache{
				ID:              nextID,
				RepositoryID:    arg.RepositoryID,
				WorkflowRunID:   arg.WorkflowRunID,
				BookmarkName:    arg.BookmarkName,
				CacheKey:        arg.CacheKey,
				CacheVersion:    arg.CacheVersion,
				ObjectKey:       arg.ObjectKey,
				ObjectSizeBytes: arg.ObjectSizeBytes,
				Compression:     arg.Compression,
				Status:          "pending",
				ExpiresAt:       arg.ExpiresAt,
			}
			nextID++
			rows[arg.CacheKey] = created
			return created, nil
		},
	}
	service := NewWorkflowCacheService(
		queries,
		store,
		WorkflowCacheConfig{RepoQuotaBytes: 100},
		WithWorkflowCacheBillingPolicy(billing),
	)

	start := make(chan struct{})
	errs := make(chan error, 2)
	for i, key := range []string{"linux", "darwin"} {
		go func(runID int64, cacheKey string) {
			<-start
			_, err := service.BeginSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: runID, RepositoryID: 42, TriggerRef: "main"}, cacheKey, "v1", 60)
			errs <- err
		}(int64(i+1), key)
	}
	close(start)

	var success, denied int
	for range 2 {
		err := <-errs
		if err == nil {
			success++
			continue
		}
		if apiStatus(t, err) == 403 {
			denied++
		}
	}
	assert.Equal(t, 1, success)
	assert.Equal(t, 1, denied)
	stateMu.Lock()
	assert.Len(t, rows, 1)
	stateMu.Unlock()
}

func TestWorkflowCacheBeginSave_AdmissionDenialPreservesReplacement(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	old := db.WorkflowCache{
		ID:              5,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 7, Valid: true},
		BookmarkName:    "main",
		CacheKey:        "npm",
		CacheVersion:    "v1",
		ObjectKey:       "workflow-cache/repos/42/old.tgz",
		ObjectSizeBytes: 40,
		Compression:     workflowCacheCompression,
		Status:          "finalized",
		ExpiresAt:       time.Now().UTC().Add(-time.Minute),
	}
	oldPendingKey := blob.PendingUploadKey("workflow-caches", old.ObjectKey)
	store.put(old.ObjectKey, old.ObjectSizeBytes)
	store.put(oldPendingKey, old.ObjectSizeBytes)

	claimCalls := 0
	upsertCalls := 0
	queries := &mockWorkflowCacheQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, DefaultBookmark: "main"}, nil
		},
		getWorkflowCacheByScopeVersionFn: func(context.Context, db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error) {
			return old, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			return old.ObjectSizeBytes, nil
		},
		claimWorkflowCacheDeletionFn: func(context.Context, db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			claimCalls++
			return db.WorkflowCache{}, fmt.Errorf("replacement must not be claimed before authorization")
		},
		upsertPendingWorkflowCacheFn: func(context.Context, db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error) {
			upsertCalls++
			return db.WorkflowCache{}, fmt.Errorf("replacement must not be upserted after denial")
		},
	}
	service := NewWorkflowCacheService(
		queries,
		store,
		WorkflowCacheConfig{RepoQuotaBytes: 100},
		WithWorkflowCacheBillingPolicy(&serializedWorkflowCacheBilling{deny: true}),
	)

	_, err := service.BeginSave(
		context.Background(),
		db.WorkflowRun{TriggerEvent: "push", ID: 9, RepositoryID: 42, TriggerRef: "main"},
		"npm",
		"v1",
		50,
	)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.Zero(t, claimCalls)
	assert.Zero(t, upsertCalls)
	assert.True(t, store.has(old.ObjectKey), "authorization denial must preserve the old final archive")
	assert.True(t, store.has(oldPendingKey), "authorization denial must preserve any old staging object")
}

func TestWorkflowCacheFinalize_PromotesStagingAndPurgesIt(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	cache := db.WorkflowCache{
		ID:              7,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 9, Valid: true},
		BookmarkName:    "main",
		CacheKey:        "npm",
		CacheVersion:    "v1",
		ObjectKey:       "workflow-cache/repos/42/nonce.tgz",
		ObjectSizeBytes: 17,
		Compression:     workflowCacheCompression,
		Status:          "pending",
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
	}
	pendingKey := blob.PendingUploadKey("workflow-caches", cache.ObjectKey)
	store.put(pendingKey, cache.ObjectSizeBytes)
	var stateMu sync.Mutex
	row := cache
	queries := &mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			return row, nil
		},
		finalizeWorkflowCacheFn: func(_ context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			require.Equal(t, cache.ObjectKey, arg.ObjectKey)
			require.Equal(t, cache.ObjectSizeBytes, arg.ObjectSizeBytes)
			row.Status = "finalized"
			row.ExpiresAt = arg.ExpiresAt
			return row, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			return nil, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			return cache.ObjectSizeBytes, nil
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{})

	finalized, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 9, RepositoryID: 42}, cache.ID, cache.ObjectSizeBytes)
	require.NoError(t, err)
	assert.Equal(t, "finalized", finalized.Status)
	assert.True(t, store.has(cache.ObjectKey))
	assert.False(t, store.has(pendingKey))
}

func TestWorkflowCacheFinalize_DeleteWinsAfterPromotionCleansUnclaimedBlob(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	cache := db.WorkflowCache{
		ID:              8,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 9, Valid: true},
		BookmarkName:    "main",
		CacheKey:        "npm",
		CacheVersion:    "v1",
		ObjectKey:       "workflow-cache/repos/42/barrier.tgz",
		ObjectSizeBytes: 23,
		Compression:     workflowCacheCompression,
		Status:          "pending",
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
	}
	pendingKey := blob.PendingUploadKey("workflow-caches", cache.ObjectKey)
	store.put(pendingKey, cache.ObjectSizeBytes)
	promoted := make(chan struct{})
	releasePromotion := make(chan struct{})
	store.afterPromote = func(string, string) error {
		close(promoted)
		<-releasePromotion
		return nil
	}

	var stateMu sync.Mutex
	rowPresent := true
	queries := &mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if !rowPresent {
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			return cache, nil
		},
		finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			stateMu.Lock()
			defer stateMu.Unlock()
			if !rowPresent {
				return db.WorkflowCache{}, pgx.ErrNoRows
			}
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{})

	errCh := make(chan error, 1)
	go func() {
		_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 9, RepositoryID: 42}, cache.ID, cache.ObjectSizeBytes)
		errCh <- err
	}()
	<-promoted
	stateMu.Lock()
	rowPresent = false
	stateMu.Unlock()
	close(releasePromotion)

	err := <-errCh
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
	assert.False(t, store.has(cache.ObjectKey), "a promoted object with no exact finalized row must be removed")
	assert.False(t, store.has(pendingKey))
}

func TestWorkflowCacheFinalize_ReconciliationLookupErrorPreservesPromotedBlob(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	cache := db.WorkflowCache{
		ID:              9,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 7, Valid: true},
		BookmarkName:    "main",
		CacheKey:        "deps",
		CacheVersion:    "v1",
		ObjectKey:       "workflow-cache/repos/42/ambiguous.tgz",
		ObjectSizeBytes: 29,
		Compression:     workflowCacheCompression,
		Status:          "pending",
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
	}
	pendingKey := blob.PendingUploadKey("workflow-caches", cache.ObjectKey)
	store.put(pendingKey, cache.ObjectSizeBytes)
	getCalls := 0
	queries := &mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			getCalls++
			if getCalls >= 3 {
				return db.WorkflowCache{}, fmt.Errorf("database temporarily unavailable")
			}
			return cache, nil
		},
		finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, pgx.ErrNoRows
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{})

	_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 7, RepositoryID: 42}, cache.ID, cache.ObjectSizeBytes)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, store.has(cache.ObjectKey), "ambiguous reconciliation must preserve a potentially owned final object")
	assert.False(t, store.has(pendingKey), "promotion may already have consumed and purged staging")
}

func TestWorkflowCacheFinalize_TransientWriteErrorWithPendingReconciliationPreservesPromotedBlob(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	cache := db.WorkflowCache{
		ID:              10,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 7, Valid: true},
		BookmarkName:    "main",
		CacheKey:        "deps",
		CacheVersion:    "v1",
		ObjectKey:       "workflow-cache/repos/42/transient.tgz",
		ObjectSizeBytes: 31,
		Compression:     workflowCacheCompression,
		Status:          "pending",
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
	}
	pendingKey := blob.PendingUploadKey("workflow-caches", cache.ObjectKey)
	store.put(pendingKey, cache.ObjectSizeBytes)
	queries := &mockWorkflowCacheQuerier{
		getWorkflowCacheByIDFn: func(context.Context, int64) (db.WorkflowCache, error) {
			return cache, nil
		},
		finalizeWorkflowCacheFn: func(context.Context, db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error) {
			return db.WorkflowCache{}, fmt.Errorf("database transport unavailable")
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{})

	_, err := service.FinalizeSave(context.Background(), db.WorkflowRun{TriggerEvent: "push", ID: 7, RepositoryID: 42}, cache.ID, cache.ObjectSizeBytes)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, store.has(cache.ObjectKey), "an ambiguous write error plus the old pending row must not destroy a promoted archive")
	assert.False(t, store.has(pendingKey), "promotion may already have consumed staging")
}

func TestWorkflowCacheDeletionClaim_RemovesPendingAndFinalObjects(t *testing.T) {
	t.Parallel()

	store := newWorkflowCachePendingStore()
	cache := db.WorkflowCache{
		ID:              11,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 9, Valid: true},
		ObjectKey:       "workflow-cache/repos/42/delete.tgz",
		ObjectSizeBytes: 31,
		Compression:     workflowCacheCompression,
		Status:          "finalized",
	}
	pendingKey := blob.PendingUploadKey("workflow-caches", cache.ObjectKey)
	store.put(pendingKey, cache.ObjectSizeBytes)
	store.put(cache.ObjectKey, cache.ObjectSizeBytes)
	queries := &mockWorkflowCacheQuerier{
		claimWorkflowCacheDeletionFn: func(_ context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			claimed := cache
			claimed.Status = "deleting"
			claimed.DeletionToken = arg.DeletionToken
			return claimed, nil
		},
		deleteClaimedWorkflowCacheFn: func(context.Context, db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
			return cache, nil
		},
	}
	service := NewWorkflowCacheService(queries, store, WorkflowCacheConfig{}).(*workflowCacheService)

	deleted, err := service.deleteCacheRow(context.Background(), cache)
	require.NoError(t, err)
	assert.True(t, deleted)
	assert.False(t, store.has(pendingKey))
	assert.False(t, store.has(cache.ObjectKey))
}

func TestWorkflowCacheCleanup_ExpiredPendingReleasesUsageBeforeEviction(t *testing.T) {
	t.Parallel()

	pending := db.WorkflowCache{
		ID:              21,
		RepositoryID:    42,
		WorkflowRunID:   pgtype.Int8{Int64: 9, Valid: true},
		ObjectKey:       "workflow-cache/repos/42/expired-pending.tgz",
		ObjectSizeBytes: 20,
		Status:          "pending",
		ExpiresAt:       time.Now().UTC().Add(-time.Minute),
	}
	finalized := db.WorkflowCache{
		ID:              22,
		RepositoryID:    42,
		ObjectKey:       "workflow-cache/repos/42/live-finalized.tgz",
		ObjectSizeBytes: 90,
		Status:          "finalized",
		ExpiresAt:       time.Now().UTC().Add(time.Hour),
	}
	candidateCalls := 0
	claimedIDs := []int64{}
	queries := &mockWorkflowCacheQuerier{
		listWorkflowCacheRepositoryIDsFn: func(context.Context) ([]int64, error) {
			return []int64{42}, nil
		},
		getWorkflowCacheRepoUsageFn: func(context.Context, int64) (int64, error) {
			return pending.ObjectSizeBytes + finalized.ObjectSizeBytes, nil
		},
		listWorkflowCacheEvictionCandidatesFn: func(context.Context, db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error) {
			candidateCalls++
			if candidateCalls == 1 {
				return []db.WorkflowCache{pending, finalized}, nil
			}
			return nil, nil
		},
		claimWorkflowCacheDeletionFn: func(_ context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error) {
			claimedIDs = append(claimedIDs, arg.ID)
			if arg.ID != pending.ID {
				return db.WorkflowCache{}, fmt.Errorf("live finalized cache must not be evicted after pending usage is released")
			}
			claimed := pending
			claimed.Status = "deleting"
			claimed.DeletionToken = arg.DeletionToken
			return claimed, nil
		},
		deleteClaimedWorkflowCacheFn: func(context.Context, db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error) {
			return pending, nil
		},
	}
	service := NewWorkflowCacheService(
		queries,
		newWorkflowCachePendingStore(),
		WorkflowCacheConfig{RepoQuotaBytes: 100},
	)

	require.NoError(t, service.Cleanup(context.Background()))
	assert.Equal(t, []int64{pending.ID}, claimedIDs)
}

func TestWorkflowCacheBeginSave_RejectsInvalidDeclaredSizes(t *testing.T) {
	t.Parallel()

	service := NewWorkflowCacheService(&mockWorkflowCacheQuerier{}, newWorkflowCachePendingStore(), WorkflowCacheConfig{ArchiveMaxBytes: 10})
	run := db.WorkflowRun{TriggerEvent: "push", ID: 1, RepositoryID: 42}

	_, err := service.BeginSave(context.Background(), run, "npm", "v1", -1)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
	_, err = service.BeginSave(context.Background(), run, "npm", "v1", 11)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}

func (*serializedWorkflowCacheBilling) AuthorizeSandboxStart(context.Context, int64) error {
	return nil
}
func (*serializedWorkflowCacheBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}
