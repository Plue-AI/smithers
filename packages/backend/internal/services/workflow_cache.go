package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	stdErrors "errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	defaultWorkflowCachePrefix          = "workflow-cache"
	defaultWorkflowCacheTTL             = 7 * 24 * time.Hour
	defaultWorkflowCacheRepoQuotaBytes  = 2 * 1024 * 1024 * 1024
	defaultWorkflowCacheArchiveMaxBytes = 1024 * 1024 * 1024
	workflowCacheEvictionBatchSize      = 256
	workflowCacheCompression            = "tar+gzip"
	workflowCacheStaticVersion          = "static"
	workflowCacheMaxKeyLength           = 512
	workflowCacheMaxVersionLength       = 64
	workflowCachePendingGrace           = 5 * time.Minute
	workflowCachePhysicalDeleteTimeout  = time.Minute
)

type WorkflowCacheConfig struct {
	Prefix          string
	SignedURLExpiry time.Duration
	TTL             time.Duration
	RepoQuotaBytes  int64
	ArchiveMaxBytes int64
}

func normalizeWorkflowCacheConfig(cfg WorkflowCacheConfig) WorkflowCacheConfig {
	prefix := strings.Trim(strings.TrimSpace(cfg.Prefix), "/")
	if prefix == "" {
		prefix = defaultWorkflowCachePrefix
	}
	if cfg.SignedURLExpiry <= 0 {
		cfg.SignedURLExpiry = blob.DefaultSignedURLExpiry
	}
	if cfg.TTL <= 0 {
		cfg.TTL = defaultWorkflowCacheTTL
	}
	if cfg.RepoQuotaBytes <= 0 {
		cfg.RepoQuotaBytes = defaultWorkflowCacheRepoQuotaBytes
	}
	if cfg.ArchiveMaxBytes <= 0 {
		cfg.ArchiveMaxBytes = defaultWorkflowCacheArchiveMaxBytes
	}
	cfg.Prefix = prefix
	return cfg
}

type WorkflowCacheQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetWorkflowCacheByID(ctx context.Context, id int64) (db.WorkflowCache, error)
	GetWorkflowCacheByScopeVersion(ctx context.Context, arg db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCache, error)
	FindWorkflowCacheForRestore(ctx context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCache, error)
	UpsertPendingWorkflowCache(ctx context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCache, error)
	FinalizeWorkflowCache(ctx context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCache, error)
	TouchWorkflowCacheHit(ctx context.Context, id int64) error
	ListWorkflowCaches(ctx context.Context, arg db.ListWorkflowCachesParams) ([]db.WorkflowCache, error)
	ListWorkflowCachesForClear(ctx context.Context, arg db.ListWorkflowCachesForClearParams) ([]db.WorkflowCache, error)
	ClaimWorkflowCacheDeletion(ctx context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCache, error)
	RetryWorkflowCacheDeletion(ctx context.Context, arg db.RetryWorkflowCacheDeletionParams) (db.WorkflowCache, error)
	ReleaseWorkflowCacheDeletionClaim(ctx context.Context, arg db.ReleaseWorkflowCacheDeletionClaimParams) error
	DeleteClaimedWorkflowCache(ctx context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCache, error)
	GetWorkflowCacheRepoUsage(ctx context.Context, repositoryID int64) (int64, error)
	GetWorkflowCacheStats(ctx context.Context, repositoryID int64) (db.GetWorkflowCacheStatsRow, error)
	ListWorkflowCacheRepositoryIDs(ctx context.Context) ([]int64, error)
	ListWorkflowCacheEvictionCandidates(ctx context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCache, error)
}

type WorkflowCacheStore interface{ blob.Store }

type WorkflowCacheMetricsRecorder interface {
	ObserveRunnerCacheHit(result string)
}

type WorkflowCacheService interface {
	Restore(ctx context.Context, run db.WorkflowRun, key, cacheVersion string) (WorkflowCacheRestoreResult, error)
	BeginSave(ctx context.Context, run db.WorkflowRun, key, cacheVersion string, objectSizeBytes int64) (WorkflowCacheSaveReservation, error)
	FinalizeSave(ctx context.Context, run db.WorkflowRun, cacheID, objectSizeBytes int64) (db.WorkflowCache, error)
	AbortSave(ctx context.Context, run db.WorkflowRun, cacheID int64) error
	Cleanup(ctx context.Context) error
	List(ctx context.Context, repositoryID int64, filter WorkflowCacheListFilter) ([]db.WorkflowCache, error)
	Clear(ctx context.Context, repositoryID int64, filter WorkflowCacheListFilter) (WorkflowCacheClearResult, error)
	Stats(ctx context.Context, repositoryID int64) (WorkflowCacheStats, error)
}

type WorkflowCacheRestoreResult struct {
	Cache            *db.WorkflowCache
	CacheHit         bool
	DownloadURL      string
	ResolvedBookmark string
}

type WorkflowCacheSaveReservation struct {
	Cache           db.WorkflowCache
	UploadURL       string
	UploadHeaders   map[string]string
	AlreadyExists   bool
	ArchiveMaxBytes int64
}

type WorkflowCacheListFilter struct {
	Page     int
	PerPage  int
	Bookmark string
	CacheKey string
}

type WorkflowCacheClearResult struct {
	DeletedCount int64 `json:"deleted_count"`
	DeletedBytes int64 `json:"deleted_bytes"`
}

type WorkflowCacheStats struct {
	CacheCount      int64      `json:"cache_count"`
	TotalSizeBytes  int64      `json:"total_size_bytes"`
	RepoQuotaBytes  int64      `json:"repo_quota_bytes"`
	ArchiveMaxBytes int64      `json:"archive_max_bytes"`
	TTLSeconds      int64      `json:"ttl_seconds"`
	LastHitAt       *time.Time `json:"last_hit_at,omitempty"`
	MaxExpiresAt    *time.Time `json:"max_expires_at,omitempty"`
}

type workflowCacheService struct {
	queries WorkflowCacheQuerier
	store   WorkflowCacheStore
	config  WorkflowCacheConfig
	billing BillingPolicy
	metrics WorkflowCacheMetricsRecorder
}

type WorkflowCacheServiceOption func(*workflowCacheService)

func WithWorkflowCacheBillingPolicy(policy BillingPolicy) WorkflowCacheServiceOption {
	return func(s *workflowCacheService) {
		s.billing = policy
	}
}

func WithWorkflowCacheMetrics(metrics WorkflowCacheMetricsRecorder) WorkflowCacheServiceOption {
	return func(s *workflowCacheService) {
		s.metrics = metrics
	}
}

func NewWorkflowCacheService(queries WorkflowCacheQuerier, store WorkflowCacheStore, cfg WorkflowCacheConfig, opts ...WorkflowCacheServiceOption) WorkflowCacheService {
	svc := &workflowCacheService{
		queries: queries,
		store:   store,
		config:  normalizeWorkflowCacheConfig(cfg),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

func (s *workflowCacheService) Restore(ctx context.Context, run db.WorkflowRun, key, cacheVersion string) (WorkflowCacheRestoreResult, error) {
	key, cacheVersion, err := validateWorkflowCacheIdentity(key, cacheVersion)
	if err != nil {
		return WorkflowCacheRestoreResult{}, err
	}
	repository, bookmarkName, err := s.resolveWorkflowCacheScope(ctx, run.RepositoryID, run.TriggerRef)
	if err != nil {
		return WorkflowCacheRestoreResult{}, err
	}

	cache, err := s.queries.FindWorkflowCacheForRestore(ctx, db.FindWorkflowCacheForRestoreParams{
		RepositoryID:    repository.ID,
		BookmarkName:    bookmarkName,
		DefaultBookmark: repository.DefaultBookmark,
		CacheKey:        key,
		CacheVersion:    cacheVersion,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			s.observeRunnerCacheHit("miss")
			return WorkflowCacheRestoreResult{CacheHit: false}, nil
		}
		return WorkflowCacheRestoreResult{}, pkgerrors.Internal("failed to resolve workflow cache").WithCause(err)
	}

	exists, err := s.store.Exists(ctx, cache.ObjectKey)
	if err != nil {
		return WorkflowCacheRestoreResult{}, pkgerrors.Internal("failed to verify cache archive").WithCause(err)
	}
	if !exists {
		if _, cleanupErr := s.deleteCacheRow(ctx, cache); cleanupErr != nil {
			return WorkflowCacheRestoreResult{}, cleanupErr
		}
		s.observeRunnerCacheHit("miss")
		return WorkflowCacheRestoreResult{CacheHit: false}, nil
	}

	downloadURL, err := s.store.SignedDownloadURL(ctx, cache.ObjectKey, s.config.SignedURLExpiry)
	if err != nil {
		return WorkflowCacheRestoreResult{}, pkgerrors.Internal("failed to create cache download url").WithCause(err)
	}
	if err := s.queries.TouchWorkflowCacheHit(ctx, cache.ID); err != nil {
		// Hit-stat bookkeeping is best-effort: the cache archive itself is
		// already verified and its download URL signed, so a failure to bump
		// hit_count/last_hit_at must not fail the restore (issue 142).
		slog.Warn("workflow cache hit-stat update failed",
			"cache_id", cache.ID,
			"repository_id", cache.RepositoryID,
			"error", err,
		)
	}
	s.observeRunnerCacheHit("hit")

	return WorkflowCacheRestoreResult{
		Cache:            &cache,
		CacheHit:         true,
		DownloadURL:      downloadURL,
		ResolvedBookmark: cache.BookmarkName,
	}, nil
}

func (s *workflowCacheService) BeginSave(ctx context.Context, run db.WorkflowRun, key, cacheVersion string, objectSizeBytes int64) (WorkflowCacheSaveReservation, error) {
	key, cacheVersion, err := validateWorkflowCacheIdentity(key, cacheVersion)
	if err != nil {
		return WorkflowCacheSaveReservation{}, err
	}
	if objectSizeBytes < 0 {
		return WorkflowCacheSaveReservation{}, pkgerrors.BadRequest("object_size_bytes must be non-negative")
	}
	if objectSizeBytes > s.config.ArchiveMaxBytes {
		return WorkflowCacheSaveReservation{}, pkgerrors.BadRequest("cache archive exceeds configured size limit")
	}
	if !workflowCachePublisher(run.TriggerEvent) {
		return WorkflowCacheSaveReservation{}, pkgerrors.Forbidden("this run restores workflow caches but does not save them")
	}
	repository, bookmarkName, err := s.resolveWorkflowCacheScope(ctx, run.RepositoryID, run.TriggerRef)
	if err != nil {
		return WorkflowCacheSaveReservation{}, err
	}

	// Every reservation, including a retry from the same workflow run, gets an
	// immutable object key. A previously issued signed capability can therefore
	// recreate only its abandoned pending key; it can never write the new
	// reservation's staging object or final archive.
	objectKey := workflowCacheObjectKey(
		s.config.Prefix,
		repository.ID,
		run.ID,
		bookmarkName,
		key,
		cacheVersion,
		uuid.NewString(),
	)
	pendingExpiresAt := time.Now().UTC().Add(s.config.SignedURLExpiry + workflowCachePendingGrace)
	var cache db.WorkflowCache
	var replacement *db.WorkflowCache
	alreadyExists := false

	// The production billing policy takes the owner's storage lock before this
	// resolver runs and holds it until UpsertPendingWorkflowCache is committed.
	// The resolver is deliberately read-only: quota authorization must complete
	// before an expired or retryable reservation is destroyed. Pending/deleting
	// rows are included in both owner and repository usage, so admission requires
	// headroom for the full new archive while the replacement still exists.
	resolveAdditionalBytes := func(lockCtx context.Context) (int64, error) {
		existing, getErr := s.queries.GetWorkflowCacheByScopeVersion(lockCtx, db.GetWorkflowCacheByScopeVersionParams{
			RepositoryID: repository.ID,
			BookmarkName: bookmarkName,
			CacheKey:     key,
			CacheVersion: cacheVersion,
		})
		if getErr != nil && !stdErrors.Is(getErr, pgx.ErrNoRows) {
			return 0, pkgerrors.Internal("failed to load workflow cache reservation").WithCause(getErr)
		}
		if getErr == nil {
			now := time.Now().UTC()
			switch existing.Status {
			case "finalized":
				if !workflowCacheExpired(existing.ExpiresAt, now) {
					exists, existsErr := s.store.Exists(lockCtx, existing.ObjectKey)
					if existsErr != nil {
						return 0, pkgerrors.Internal("failed to verify cache archive").WithCause(existsErr)
					}
					if exists {
						cache = existing
						alreadyExists = true
						return 0, nil
					}
				}
			case "pending":
				foreignReservation := existing.WorkflowRunID.Valid && existing.WorkflowRunID.Int64 != run.ID
				if foreignReservation && !workflowCacheExpired(existing.ExpiresAt, now) {
					cache = existing
					alreadyExists = true
					return 0, nil
				}
			case "deleting":
				// Retry the retained physical deletion below. Until it succeeds,
				// its declared bytes remain in authoritative usage.
			default:
				return 0, pkgerrors.Conflict("workflow cache is in an invalid state")
			}

			captured := existing
			replacement = &captured
		}

		usage, usageErr := s.queries.GetWorkflowCacheRepoUsage(lockCtx, repository.ID)
		if usageErr != nil {
			return 0, pkgerrors.Internal("failed to load workflow cache usage").WithCause(usageErr)
		}
		if usage < 0 || usage > s.config.RepoQuotaBytes || objectSizeBytes > s.config.RepoQuotaBytes-usage {
			return 0, pkgerrors.Forbidden("workflow cache repository quota exceeded")
		}
		return objectSizeBytes, nil
	}
	reserve := func(commitCtx context.Context) error {
		if alreadyExists {
			return nil
		}
		if replacement != nil {
			// Claim the exact row captured under the authorization lock before
			// touching storage. A concurrent finalize/replacement makes the claim a
			// no-op, in which case this request must not upsert over the winner.
			deleted, cleanupErr := s.deleteCacheRow(commitCtx, *replacement)
			if cleanupErr != nil {
				return cleanupErr
			}
			if !deleted {
				return pkgerrors.Conflict("workflow cache reservation changed during admission")
			}
		}
		var reserveErr error
		cache, reserveErr = s.queries.UpsertPendingWorkflowCache(commitCtx, db.UpsertPendingWorkflowCacheParams{
			RepositoryID:    repository.ID,
			WorkflowRunID:   pgtype.Int8{Int64: run.ID, Valid: true},
			BookmarkName:    bookmarkName,
			CacheKey:        key,
			CacheVersion:    cacheVersion,
			ObjectKey:       objectKey,
			ObjectSizeBytes: objectSizeBytes,
			Compression:     workflowCacheCompression,
			ExpiresAt:       pendingExpiresAt,
		})
		if reserveErr != nil {
			return pkgerrors.Internal("failed to reserve workflow cache upload").WithCause(reserveErr)
		}
		if cache.Status != "pending" || cache.ObjectKey != objectKey ||
			!cache.WorkflowRunID.Valid || cache.WorkflowRunID.Int64 != run.ID ||
			cache.ObjectSizeBytes != objectSizeBytes {
			// This can only happen with a mixed-version/unserialized writer. Do not
			// issue a capability for a reservation this call did not establish.
			return pkgerrors.Conflict("workflow cache reservation changed during admission")
		}
		return nil
	}
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, repository.ID, resolveAdditionalBytes, reserve); err != nil {
		return WorkflowCacheSaveReservation{}, err
	}
	if alreadyExists {
		return WorkflowCacheSaveReservation{
			Cache:           cache,
			AlreadyExists:   true,
			ArchiveMaxBytes: s.config.ArchiveMaxBytes,
		}, nil
	}

	uploadKey, _ := workflowCacheUploadKey(s.store, cache.ObjectKey)
	upload, err := blob.SignedCreateOnlyUpload(ctx, s.store, uploadKey, "application/gzip", objectSizeBytes, s.config.SignedURLExpiry)
	if err != nil {
		// Keep an undeletable reservation metered. If both staged/final cleanup
		// and the exact metadata claim succeed, the failed signer leaves no bytes
		// and the quota can be released immediately.
		deleted, cleanupErr := s.deleteCacheRow(ctx, cache)
		if cleanupErr != nil {
			slog.Warn("workflow cache reservation cleanup failed after signing error", "cache_id", cache.ID, "repository_id", cache.RepositoryID, "error", cleanupErr)
		} else if deleted {
			if clearErr := clearPurgedStorageDeletionKeys(
				ctx,
				s.queries,
				cache.RepositoryID,
				workflowCacheStorageAllocationKey(cache.RepositoryID, cache.ObjectKey),
				cache.ObjectKey,
				blob.PendingUploadKey("workflow-caches", cache.ObjectKey),
			); clearErr != nil {
				slog.Warn("workflow cache purged deletion fence cleanup failed", "cache_id", cache.ID, "repository_id", cache.RepositoryID, "error", clearErr)
			}
		}
		return WorkflowCacheSaveReservation{}, pkgerrors.Internal("failed to create cache upload url").WithCause(err)
	}

	return WorkflowCacheSaveReservation{
		Cache:           cache,
		UploadURL:       upload.URL,
		UploadHeaders:   upload.Header,
		ArchiveMaxBytes: s.config.ArchiveMaxBytes,
	}, nil
}

func (s *workflowCacheService) observeRunnerCacheHit(result string) {
	if s == nil || s.metrics == nil {
		return
	}
	s.metrics.ObserveRunnerCacheHit(result)
}

func (s *workflowCacheService) FinalizeSave(ctx context.Context, run db.WorkflowRun, cacheID, objectSizeBytes int64) (db.WorkflowCache, error) {
	if cacheID <= 0 {
		return db.WorkflowCache{}, pkgerrors.BadRequest("cache id must be positive")
	}
	if objectSizeBytes < 0 {
		return db.WorkflowCache{}, pkgerrors.BadRequest("object_size_bytes must be non-negative")
	}

	cache, err := s.queries.GetWorkflowCacheByID(ctx, cacheID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowCache{}, pkgerrors.NotFound("workflow cache not found")
		}
		return db.WorkflowCache{}, pkgerrors.Internal("failed to load workflow cache").WithCause(err)
	}
	if cache.RepositoryID != run.RepositoryID {
		return db.WorkflowCache{}, pkgerrors.Forbidden("cache does not belong to this workflow run")
	}
	if cache.WorkflowRunID.Valid && cache.WorkflowRunID.Int64 != run.ID {
		return db.WorkflowCache{}, pkgerrors.Forbidden("cache was reserved by a different workflow run")
	}
	if cache.ObjectSizeBytes != objectSizeBytes {
		return db.WorkflowCache{}, pkgerrors.BadRequest("cache archive size did not match reservation")
	}
	if cache.Status == "finalized" {
		// A caller may retry through an old capability after finalization. The
		// immutable final object remains authoritative; discard only staging.
		if cleanupErr := s.purgePendingWorkflowCacheUpload(ctx, cache); cleanupErr != nil {
			slog.Warn("finalized workflow cache staging cleanup failed", "cache_id", cache.ID, "repository_id", cache.RepositoryID, "error", cleanupErr)
		}
		return cache, nil
	}
	if cache.Status != "pending" {
		return db.WorkflowCache{}, pkgerrors.Conflict("workflow cache is no longer pending")
	}

	validated, err := s.validateWorkflowCacheUpload(ctx, cache)
	if err != nil {
		return db.WorkflowCache{}, err
	}
	// Finalize under the per-owner storage lock and re-resolve the exact
	// reservation there. BeginSave already accounts for the pending archive,
	// so this lifecycle transition has a zero-byte delta; a concurrent winner
	// is an idempotent no-op rather than a second charge.
	var finalized db.WorkflowCache
	resolveAdditionalBytes := func(ctx context.Context) (int64, error) {
		current, getErr := s.queries.GetWorkflowCacheByID(ctx, cache.ID)
		if getErr != nil {
			if stdErrors.Is(getErr, pgx.ErrNoRows) {
				return 0, pkgerrors.NotFound("workflow cache not found")
			}
			return 0, pkgerrors.Internal("failed to load workflow cache").WithCause(getErr)
		}
		if !sameWorkflowCacheReservation(current, cache) {
			return 0, pkgerrors.Conflict("workflow cache reservation changed during finalization")
		}
		switch current.Status {
		case "finalized":
			if current.ObjectSizeBytes != objectSizeBytes {
				return 0, pkgerrors.Conflict("workflow cache finalized with a different size")
			}
			finalized = current
			return 0, nil
		case "pending":
			// BeginSave reserves the archive bytes in authoritative usage;
			// finalization changes lifecycle state but adds no storage.
			return 0, nil
		default:
			return 0, pkgerrors.Conflict("workflow cache is no longer pending")
		}
	}
	finalize := func(ctx context.Context) error {
		if finalized.Status == "finalized" {
			if err := s.purgePendingWorkflowCacheUpload(ctx, cache); err != nil {
				return pkgerrors.Internal("failed to clean up workflow cache staging upload").WithCause(err)
			}
			return nil
		}
		if err := s.prepareWorkflowCacheFinalBlob(ctx, cache, validated); err != nil {
			return err
		}
		// The WHERE clause is a compare-and-swap on the exact reservation this
		// run holds (repository, run, object key, still pending, not expired):
		// the ownership checks above are not atomic with this UPDATE, so
		// without the CAS a stale finalize could race UpsertPendingWorkflowCache
		// handing the row to another run and claim/overwrite its reservation
		// (issue 224).
		row, err := s.queries.FinalizeWorkflowCache(ctx, db.FinalizeWorkflowCacheParams{
			ID:              cacheID,
			ObjectSizeBytes: objectSizeBytes,
			ExpiresAt:       time.Now().UTC().Add(s.config.TTL),
			RepositoryID:    run.RepositoryID,
			WorkflowRunID:   pgtype.Int8{Int64: run.ID, Valid: true},
			ObjectKey:       cache.ObjectKey,
		})
		if err != nil {
			// Promotion precedes the metadata CAS. Reconcile every ambiguous/CAS
			// failure before deciding whether the immutable final object is owned.
			current, getErr := s.queries.GetWorkflowCacheByID(ctx, cache.ID)
			if getErr == nil && sameWorkflowCacheReservation(current, cache) &&
				current.Status == "finalized" && current.ObjectSizeBytes == objectSizeBytes {
				finalized = current
				if cleanupErr := s.purgePendingWorkflowCacheUpload(ctx, cache); cleanupErr != nil {
					return pkgerrors.Internal("failed to clean up workflow cache staging upload").WithCause(cleanupErr)
				}
				return nil
			}
			if getErr != nil && !stdErrors.Is(getErr, pgx.ErrNoRows) {
				// Ownership is ambiguous. Keep the final object and the metered row;
				// a retry can safely reconcile them.
				return pkgerrors.Internal("failed to finalize workflow cache").WithCause(getErr)
			}
			if getErr == nil && sameWorkflowCacheReservation(current, cache) &&
				current.Status == "pending" && !stdErrors.Is(err, pgx.ErrNoRows) {
				// A transport/transient UPDATE failure followed by the old pending
				// row does not prove that promotion is unowned: the database result
				// may still be in flight or unavailable to this snapshot. Preserve
				// both immutable locations so a retry can reconcile safely.
				return pkgerrors.Internal("failed to finalize workflow cache")
			}
			// No exact finalized reservation owns the unique object key. Remove
			// both locations so a delete/replacement race cannot strand bytes.
			if cleanupErr := s.deleteWorkflowCacheBlobSet(ctx, cache); cleanupErr != nil {
				return pkgerrors.Internal("failed to clean up unclaimed workflow cache upload").WithCause(cleanupErr)
			}
			if stdErrors.Is(getErr, pgx.ErrNoRows) {
				return pkgerrors.NotFound("workflow cache not found")
			}
			if !sameWorkflowCacheReservation(current, cache) {
				return pkgerrors.Conflict("workflow cache reservation changed during finalization")
			}
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.Conflict("workflow cache is no longer pending")
			}
			return pkgerrors.Internal("failed to finalize workflow cache").WithCause(err)
		}
		if !sameWorkflowCacheReservation(row, cache) || row.Status != "finalized" || row.ObjectSizeBytes != objectSizeBytes {
			if cleanupErr := s.deleteWorkflowCacheBlobSet(ctx, cache); cleanupErr != nil {
				return pkgerrors.Internal("failed to clean up unclaimed workflow cache upload").WithCause(cleanupErr)
			}
			return pkgerrors.Conflict("workflow cache reservation changed during finalization")
		}
		finalized = row
		return nil
	}
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, run.RepositoryID, resolveAdditionalBytes, finalize); err != nil {
		return db.WorkflowCache{}, err
	}

	if err := s.enforceRepositoryCachePolicy(ctx, run.RepositoryID, finalized.ID); err != nil {
		return db.WorkflowCache{}, err
	}
	return finalized, nil
}

func (s *workflowCacheService) AbortSave(ctx context.Context, run db.WorkflowRun, cacheID int64) error {
	if cacheID <= 0 {
		return pkgerrors.BadRequest("cache id must be positive")
	}
	cache, err := s.queries.GetWorkflowCacheByID(ctx, cacheID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return pkgerrors.Internal("failed to load workflow cache").WithCause(err)
	}
	if cache.RepositoryID != run.RepositoryID {
		return pkgerrors.Forbidden("cache does not belong to this workflow run")
	}
	if cache.WorkflowRunID.Valid && cache.WorkflowRunID.Int64 != run.ID {
		return pkgerrors.Forbidden("cache was reserved by a different workflow run")
	}
	if cache.Status != "pending" && cache.Status != "deleting" {
		return nil
	}
	_, err = s.deleteCacheRow(ctx, cache)
	return err
}

func (s *workflowCacheService) Cleanup(ctx context.Context) error {
	repositoryIDs, err := s.queries.ListWorkflowCacheRepositoryIDs(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to list workflow cache repositories").WithCause(err)
	}

	var errs []error
	var failedRepositoryIDs []int64
	for _, repositoryID := range repositoryIDs {
		if repositoryID <= 0 {
			continue
		}
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		if err := s.enforceRepositoryCachePolicy(ctx, repositoryID, 0); err != nil {
			slog.Warn("workflow cache cleanup failed for repository", "repository_id", repositoryID, "error", err)
			errs = append(errs, err)
			failedRepositoryIDs = append(failedRepositoryIDs, repositoryID)
		}
	}
	if len(errs) == 1 {
		if len(failedRepositoryIDs) == 1 {
			return pkgerrors.Internal(fmt.Sprintf("workflow cache cleanup failed for repository %d", failedRepositoryIDs[0])).WithCause(errs[0])
		}
		return errs[0]
	}
	if len(errs) > 1 {
		return pkgerrors.Internal("workflow cache cleanup failed").WithCause(stdErrors.Join(errs...))
	}
	return nil
}

func (s *workflowCacheService) List(ctx context.Context, repositoryID int64, filter WorkflowCacheListFilter) ([]db.WorkflowCache, error) {
	if repositoryID <= 0 {
		return nil, pkgerrors.BadRequest("repository id must be positive")
	}
	cacheKey := strings.TrimSpace(filter.CacheKey)
	bookmarkName := strings.TrimSpace(filter.Bookmark)
	pageSize, pageOffset, _, _ := normalizePage(filter.Page, filter.PerPage)
	rows, err := s.queries.ListWorkflowCaches(ctx, db.ListWorkflowCachesParams{
		RepositoryID: repositoryID,
		BookmarkName: bookmarkName,
		CacheKey:     cacheKey,
		PageSize:     pageSize,
		PageOffset:   pageOffset,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list workflow caches").WithCause(err)
	}
	return rows, nil
}

func (s *workflowCacheService) Clear(ctx context.Context, repositoryID int64, filter WorkflowCacheListFilter) (WorkflowCacheClearResult, error) {
	if repositoryID <= 0 {
		return WorkflowCacheClearResult{}, pkgerrors.BadRequest("repository id must be positive")
	}
	rows, err := s.queries.ListWorkflowCachesForClear(ctx, db.ListWorkflowCachesForClearParams{
		RepositoryID: repositoryID,
		BookmarkName: strings.TrimSpace(filter.Bookmark),
		CacheKey:     strings.TrimSpace(filter.CacheKey),
	})
	if err != nil {
		return WorkflowCacheClearResult{}, pkgerrors.Internal("failed to clear workflow caches").WithCause(err)
	}

	result := WorkflowCacheClearResult{}
	for _, cache := range rows {
		deleted, err := s.deleteCacheRow(ctx, cache)
		if err != nil {
			return WorkflowCacheClearResult{}, err
		}
		if !deleted {
			continue
		}
		result.DeletedCount++
		result.DeletedBytes += cache.ObjectSizeBytes
	}
	return result, nil
}

func (s *workflowCacheService) Stats(ctx context.Context, repositoryID int64) (WorkflowCacheStats, error) {
	if repositoryID <= 0 {
		return WorkflowCacheStats{}, pkgerrors.BadRequest("repository id must be positive")
	}
	row, err := s.queries.GetWorkflowCacheStats(ctx, repositoryID)
	if err != nil {
		return WorkflowCacheStats{}, pkgerrors.Internal("failed to load workflow cache stats").WithCause(err)
	}

	stats := WorkflowCacheStats{
		CacheCount:      row.CacheCount,
		TotalSizeBytes:  row.TotalSizeBytes,
		RepoQuotaBytes:  s.config.RepoQuotaBytes,
		ArchiveMaxBytes: s.config.ArchiveMaxBytes,
		TTLSeconds:      int64(s.config.TTL / time.Second),
	}
	if t, ok := workflowCacheNullableTime(row.LastHitAt); ok {
		stats.LastHitAt = &t
	}
	if t, ok := workflowCacheNullableTime(row.MaxExpiresAt); ok {
		stats.MaxExpiresAt = &t
	}
	return stats, nil
}

func (s *workflowCacheService) resolveWorkflowCacheScope(ctx context.Context, repositoryID int64, rawRef string) (db.Repository, string, error) {
	repository, err := s.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, "", pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, "", pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, normalizeWorkflowCacheBookmark(rawRef, repository.DefaultBookmark), nil
}

func (s *workflowCacheService) enforceRepositoryCachePolicy(ctx context.Context, repositoryID, protectedCacheID int64) error {
	usage, err := s.queries.GetWorkflowCacheRepoUsage(ctx, repositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to load workflow cache usage").WithCause(err)
	}

	now := time.Now().UTC()
	for {
		candidates, err := s.queries.ListWorkflowCacheEvictionCandidates(ctx, db.ListWorkflowCacheEvictionCandidatesParams{
			RepositoryID: repositoryID,
			LimitCount:   workflowCacheEvictionBatchSize,
		})
		if err != nil {
			return pkgerrors.Internal("failed to select workflow cache eviction candidates").WithCause(err)
		}
		if len(candidates) == 0 {
			return nil
		}

		progress := false
		for _, cache := range candidates {
			if cache.ID == protectedCacheID {
				continue
			}

			expired := workflowCacheExpired(cache.ExpiresAt, now)
			overQuota := usage > s.config.RepoQuotaBytes

			switch {
			case cache.Status == "deleting":
				deleted, err := s.deleteCacheRow(ctx, cache)
				if err != nil {
					return err
				}
				if deleted {
					usage -= cache.ObjectSizeBytes
					if usage < 0 {
						usage = 0
					}
					progress = true
				}
			case cache.Status == "pending" && expired:
				deleted, err := s.deleteCacheRow(ctx, cache)
				if err != nil {
					return err
				}
				if deleted {
					usage -= cache.ObjectSizeBytes
					if usage < 0 {
						usage = 0
					}
					progress = true
				}
			case cache.Status == "finalized" && (expired || overQuota):
				deleted, err := s.deleteCacheRow(ctx, cache)
				if err != nil {
					return err
				}
				if deleted {
					usage -= cache.ObjectSizeBytes
					if usage < 0 {
						usage = 0
					}
					progress = true
				}
			}
		}

		if !progress {
			return nil
		}
		if usage <= s.config.RepoQuotaBytes && len(candidates) < workflowCacheEvictionBatchSize {
			return nil
		}
	}
}

type validatedWorkflowCacheUpload struct {
	sourceKey string
	staged    bool
}

// workflowCacheUploadKey keeps unverified production uploads in the generic
// lifecycle-bounded pending namespace. Lightweight stores without promotion
// support retain their direct-key behavior for local development and tests.
func workflowCacheUploadKey(store WorkflowCacheStore, finalKey string) (string, bool) {
	if _, ok := store.(blob.CreateOnlyPromoter); ok {
		return blob.PendingUploadKey("workflow-caches", finalKey), true
	}
	return finalKey, false
}

// validateWorkflowCacheUpload accepts either the staged object or a previously
// promoted final object left by an interrupted finalization. The object size
// must equal the size committed by BeginSave; the client-provided finalize size is
// never used as an authority for unknown reservations.
func (s *workflowCacheService) validateWorkflowCacheUpload(ctx context.Context, cache db.WorkflowCache) (validatedWorkflowCacheUpload, error) {
	uploadKey, staged := workflowCacheUploadKey(s.store, cache.ObjectKey)
	attrs, err := s.store.Stat(ctx, uploadKey)
	if err == nil {
		if validationErr := s.validateWorkflowCacheObject(cache, attrs); validationErr != nil {
			if _, cleanupErr := s.deleteCacheRow(ctx, cache); cleanupErr != nil {
				return validatedWorkflowCacheUpload{}, cleanupErr
			}
			return validatedWorkflowCacheUpload{}, validationErr
		}
		return validatedWorkflowCacheUpload{sourceKey: uploadKey, staged: staged}, nil
	}
	if !stdErrors.Is(err, blob.ErrObjectNotFound) {
		return validatedWorkflowCacheUpload{}, pkgerrors.Internal("failed to verify uploaded cache archive")
	}
	if !staged {
		return validatedWorkflowCacheUpload{}, pkgerrors.BadRequest("cache archive upload not found")
	}

	attrs, err = s.store.Stat(ctx, cache.ObjectKey)
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		return validatedWorkflowCacheUpload{}, pkgerrors.BadRequest("cache archive upload not found")
	}
	if err != nil {
		return validatedWorkflowCacheUpload{}, pkgerrors.Internal("failed to verify uploaded cache archive").WithCause(err)
	}
	if validationErr := s.validateWorkflowCacheObject(cache, attrs); validationErr != nil {
		if _, cleanupErr := s.deleteCacheRow(ctx, cache); cleanupErr != nil {
			return validatedWorkflowCacheUpload{}, cleanupErr
		}
		return validatedWorkflowCacheUpload{}, validationErr
	}
	return validatedWorkflowCacheUpload{sourceKey: cache.ObjectKey, staged: true}, nil
}

func (s *workflowCacheService) validateWorkflowCacheObject(cache db.WorkflowCache, attrs blob.ObjectAttrs) error {
	actualSizeBytes := attrs.Size
	if actualSizeBytes == blob.UnknownObjectSize {
		// MemoryStore and older test doubles do not retain payload bytes. The
		// production GCS store always returns an authoritative size.
		actualSizeBytes = cache.ObjectSizeBytes
	}
	if actualSizeBytes < 0 {
		return pkgerrors.Internal("cache archive returned an invalid size")
	}
	if actualSizeBytes != cache.ObjectSizeBytes {
		return pkgerrors.BadRequest("cache archive size did not match reservation")
	}
	if actualSizeBytes > s.config.ArchiveMaxBytes {
		return pkgerrors.BadRequest("cache archive exceeds configured size limit")
	}
	return nil
}

// prepareWorkflowCacheFinalBlob establishes an immutable final object and then
// hard-purges all generations at the pending key. Promotion errors are
// reconciled against final storage so create-only race losers and ambiguous
// provider responses converge without overwriting authoritative bytes.
func (s *workflowCacheService) prepareWorkflowCacheFinalBlob(ctx context.Context, cache db.WorkflowCache, validated validatedWorkflowCacheUpload) error {
	var promotionErr error
	if validated.staged && validated.sourceKey != cache.ObjectKey {
		promoter, ok := s.store.(blob.CreateOnlyPromoter)
		if !ok {
			return pkgerrors.Internal("workflow cache promotion is unavailable")
		}
		promotionErr = promoter.PromoteCreateOnly(ctx, validated.sourceKey, cache.ObjectKey)
	}

	attrs, err := s.store.Stat(ctx, cache.ObjectKey)
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		if promotionErr != nil && !stdErrors.Is(promotionErr, blob.ErrObjectNotFound) {
			return pkgerrors.Internal("failed to promote workflow cache upload").WithCause(promotionErr)
		}
		return pkgerrors.BadRequest("cache archive upload not found")
	}
	if err != nil {
		return pkgerrors.Internal("failed to verify promoted cache archive").WithCause(err)
	}
	if validationErr := s.validateWorkflowCacheObject(cache, attrs); validationErr != nil {
		return validationErr
	}
	if err := s.purgePendingWorkflowCacheUpload(ctx, cache); err != nil {
		return pkgerrors.Internal("failed to clean up workflow cache staging upload").WithCause(err)
	}
	return nil
}

func (s *workflowCacheService) purgePendingWorkflowCacheUpload(ctx context.Context, cache db.WorkflowCache) error {
	err := blob.PurgeAllGenerations(ctx, s.store, blob.PendingUploadKey("workflow-caches", cache.ObjectKey))
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		return nil
	}
	return err
}

func (s *workflowCacheService) deleteWorkflowCacheBlobSet(ctx context.Context, cache db.WorkflowCache) error {
	var firstErr error
	if err := s.purgePendingWorkflowCacheUpload(ctx, cache); err != nil {
		firstErr = err
	}
	if strings.TrimSpace(cache.ObjectKey) != "" {
		if err := blob.PurgeAllGenerations(ctx, s.store, cache.ObjectKey); err != nil && !stdErrors.Is(err, blob.ErrObjectNotFound) && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *workflowCacheService) deleteCacheRow(ctx context.Context, cache db.WorkflowCache) (bool, error) {
	// Claim metadata before the fallible physical delete. Finalize and upsert
	// both exclude status=deleting, while a retained row keeps declared bytes
	// in quota accounting if blob deletion fails. A per-attempt token prevents
	// concurrent retry cleaners from acting under the same metadata claim.
	token := uuid.NewString()
	var claimed db.WorkflowCache
	var err error
	switch cache.Status {
	case "pending", "finalized":
		claimed, err = s.queries.ClaimWorkflowCacheDeletion(ctx, db.ClaimWorkflowCacheDeletionParams{
			ID:             cache.ID,
			RepositoryID:   cache.RepositoryID,
			WorkflowRunID:  cache.WorkflowRunID,
			ObjectKey:      cache.ObjectKey,
			ExpectedStatus: cache.Status,
			DeletionToken:  pgtype.Text{String: token, Valid: true},
		})
	case "deleting":
		claimed, err = s.queries.RetryWorkflowCacheDeletion(ctx, db.RetryWorkflowCacheDeletionParams{
			ID:            cache.ID,
			RepositoryID:  cache.RepositoryID,
			WorkflowRunID: cache.WorkflowRunID,
			ObjectKey:     cache.ObjectKey,
			DeletionToken: pgtype.Text{String: token, Valid: true},
		})
	default:
		return false, nil
	}
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, pkgerrors.Internal("failed to claim workflow cache deletion").WithCause(err)
	}
	if strings.TrimSpace(claimed.ObjectKey) != "" {
		// Retry leases are five minutes (see SQL), so bound the production blob
		// operation well below that fence. A timed-out worker releases its token
		// before any retry can acquire the same metadata claim.
		deleteCtx, cancelDelete := context.WithTimeout(ctx, workflowCachePhysicalDeleteTimeout)
		deleteErr := s.deleteWorkflowCacheBlobSet(deleteCtx, claimed)
		cancelDelete()
		if deleteErr != nil && !stdErrors.Is(deleteErr, blob.ErrObjectNotFound) {
			s.releaseCacheDeletionClaim(ctx, claimed, token)
			return false, pkgerrors.Internal("failed to delete workflow cache archive").WithCause(deleteErr)
		}
	}
	_, err = s.queries.DeleteClaimedWorkflowCache(ctx, db.DeleteClaimedWorkflowCacheParams{
		ID:            claimed.ID,
		RepositoryID:  claimed.RepositoryID,
		WorkflowRunID: claimed.WorkflowRunID,
		ObjectKey:     claimed.ObjectKey,
		DeletionToken: pgtype.Text{String: token, Valid: true},
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		s.releaseCacheDeletionClaim(ctx, claimed, token)
		return false, pkgerrors.Internal("failed to delete workflow cache metadata").WithCause(err)
	}
	return true, nil
}

func (s *workflowCacheService) releaseCacheDeletionClaim(ctx context.Context, cache db.WorkflowCache, token string) {
	if err := s.queries.ReleaseWorkflowCacheDeletionClaim(ctx, db.ReleaseWorkflowCacheDeletionClaimParams{
		ID:            cache.ID,
		RepositoryID:  cache.RepositoryID,
		WorkflowRunID: cache.WorkflowRunID,
		ObjectKey:     cache.ObjectKey,
		DeletionToken: pgtype.Text{String: token, Valid: true},
	}); err != nil {
		slog.Warn("workflow cache deletion claim release failed", "cache_id", cache.ID, "repository_id", cache.RepositoryID, "error", err)
	}
}

func sameWorkflowCacheReservation(current, captured db.WorkflowCache) bool {
	return current.ID == captured.ID &&
		current.RepositoryID == captured.RepositoryID &&
		current.WorkflowRunID == captured.WorkflowRunID &&
		current.BookmarkName == captured.BookmarkName &&
		current.CacheKey == captured.CacheKey &&
		current.CacheVersion == captured.CacheVersion &&
		current.ObjectKey == captured.ObjectKey &&
		current.ObjectSizeBytes == captured.ObjectSizeBytes &&
		current.Compression == captured.Compression
}

func validateWorkflowCacheIdentity(key, cacheVersion string) (string, string, error) {
	trimmedKey := strings.TrimSpace(key)
	if trimmedKey == "" {
		return "", "", pkgerrors.BadRequest("cache key is required")
	}
	if len(trimmedKey) > workflowCacheMaxKeyLength {
		return "", "", pkgerrors.BadRequest("cache key is too long")
	}
	if containsControlRune(trimmedKey) {
		return "", "", pkgerrors.BadRequest("cache key contains control characters")
	}

	trimmedVersion := strings.TrimSpace(cacheVersion)
	if trimmedVersion == "" {
		trimmedVersion = workflowCacheStaticVersion
	}
	if len(trimmedVersion) > workflowCacheMaxVersionLength {
		return "", "", pkgerrors.BadRequest("cache version is too long")
	}
	if containsControlRune(trimmedVersion) {
		return "", "", pkgerrors.BadRequest("cache version contains control characters")
	}
	return trimmedKey, trimmedVersion, nil
}

// containsControlRune reports whether s contains a control character (e.g. a
// newline), which would otherwise let a caller forge field boundaries in the
// object-key hash (issue 143).
func containsControlRune(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// workflowCachePublisher reports whether a run may save workflow caches. A
// saved archive is restored by later runs of its bookmark and of every other
// bookmark (the default bookmark is their fallback), so only a run executing
// that bookmark's own tree at a maintainer's request saves: a push, a
// schedule, or a person's dispatch. An invocation, an agent message, a
// landing request, issue or comment text, an alert and every other event run
// unreviewed code or act on someone else's input; they restore and never
// save. Unknown events save nothing.
//
// The trigger is provenance the server recorded, never a caller's label: the
// push hook records push, the scheduler schedule, and the dispatch routes
// workflow_dispatch only for a person, since they refuse run credentials
// (middleware.RefuseRunCredentials). Invoke records invoke whatever its body
// says.
func workflowCachePublisher(triggerEvent string) bool {
	switch NormalizeTriggerName(triggerEvent) {
	case "push", "schedule", "workflow_dispatch":
		return true
	}
	return false
}

func normalizeWorkflowCacheBookmark(rawRef, defaultBookmark string) string {
	ref := strings.TrimSpace(rawRef)
	if ref == "" {
		return defaultBookmark
	}
	switch {
	case strings.HasPrefix(ref, "refs/heads/"):
		ref = strings.TrimPrefix(ref, "refs/heads/")
	case strings.HasPrefix(ref, "refs/bookmarks/"):
		ref = strings.TrimPrefix(ref, "refs/bookmarks/")
	case strings.HasPrefix(ref, "bookmarks/"):
		ref = strings.TrimPrefix(ref, "bookmarks/")
	case strings.HasPrefix(ref, "refs/tags/"), strings.HasPrefix(ref, "tags/"):
		return defaultBookmark
	case strings.HasPrefix(ref, "refs/"):
		return defaultBookmark
	}
	if strings.TrimSpace(ref) == "" {
		return defaultBookmark
	}
	return ref
}

// workflowCacheObjectKey derives the blob key for a cache entry. Each field
// is written with an explicit length prefix rather than being concatenated
// with a plain separator: without that, tuples like
// (bookmark="m", key="a", version="b\nc") and (bookmark="m", key="a\nb",
// version="c") would hash identically and collide on the same object key
// (issue 143). The reserving workflow run ID is mixed in so that two
// concurrent runs do not share objects. BeginSave additionally supplies a
// random reservation nonce so retries by the same run are distinct too.
func workflowCacheObjectKey(prefix string, repositoryID, workflowRunID int64, bookmarkName, key, cacheVersion string, reservationNonce ...string) string {
	h := sha256.New()
	writeWorkflowCacheHashField(h, strconv.FormatInt(repositoryID, 10))
	writeWorkflowCacheHashField(h, strconv.FormatInt(workflowRunID, 10))
	writeWorkflowCacheHashField(h, bookmarkName)
	writeWorkflowCacheHashField(h, key)
	writeWorkflowCacheHashField(h, cacheVersion)
	if len(reservationNonce) > 0 {
		writeWorkflowCacheHashField(h, reservationNonce[0])
	}
	sum := h.Sum(nil)
	return fmt.Sprintf("%s/repos/%d/%s.tgz", strings.Trim(prefix, "/"), repositoryID, hex.EncodeToString(sum))
}

// writeWorkflowCacheHashField writes field into h prefixed with its byte
// length so that field boundaries cannot be forged by embedding the
// separator character inside a field value. hash.Hash writes never fail.
func writeWorkflowCacheHashField(h hash.Hash, field string) {
	_, _ = fmt.Fprintf(h, "%d:", len(field))
	_, _ = io.WriteString(h, field)
}

func workflowCacheExpired(expiresAt, now time.Time) bool {
	return !expiresAt.After(now)
}

func workflowCacheNullableTime(value interface{}) (time.Time, bool) {
	switch typed := value.(type) {
	case time.Time:
		return typed.UTC(), true
	case pgtype.Timestamptz:
		if typed.Valid {
			return typed.Time.UTC(), true
		}
	case *time.Time:
		if typed != nil {
			return typed.UTC(), true
		}
	case nil:
		return time.Time{}, false
	}
	return time.Time{}, false
}
