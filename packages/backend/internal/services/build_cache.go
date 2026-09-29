package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The advisory lock classes the self-hosted smithers cache service uses, kept
// so an operator reading either implementation sees the same numbers.
const (
	buildCacheRepositoryLockClass    int32 = 0x62637270
	buildCachePublicationLockClass   int32 = 0x74666c77
	buildCacheArtifactLockClass      int32 = 0x74666361
	buildCacheMaxPublicationAttempts       = 3
)

// PublicationOutcome classifies the row a PUT /ac left behind.
type PublicationOutcome string

const (
	PublicationInserted  PublicationOutcome = "inserted"
	PublicationIdentical PublicationOutcome = "identical"
	PublicationConflict  PublicationOutcome = "conflict"
)

// ArtifactOutcome classifies the row a PUT /cas left behind.
type ArtifactOutcome string

const (
	ArtifactInserted ArtifactOutcome = "inserted"
	ArtifactPresent  ArtifactOutcome = "present"
	ArtifactRepaired ArtifactOutcome = "repaired"
)

// BuildCacheTx is the transactional slice of the store: the statements that
// classify a publication have to run under one advisory lock and one row
// lock, or the answer describes a row that may already be gone.
type BuildCacheTx interface {
	DeleteBuildCacheEntry(ctx context.Context, arg db.DeleteBuildCacheEntryParams) (string, error)
	DeleteBuildCacheEntryFenced(ctx context.Context, arg db.DeleteBuildCacheEntryFencedParams) (string, error)
	ExpireBuildCacheEntries(ctx context.Context, arg db.ExpireBuildCacheEntriesParams) error
	ExpireBuildCacheArtifacts(ctx context.Context, arg db.ExpireBuildCacheArtifactsParams) ([]string, error)
	BuildCacheRepositoryBytes(ctx context.Context, repositoryID int64) (int64, error)
	InsertBuildCacheEntry(ctx context.Context, arg db.InsertBuildCacheEntryParams) (string, error)
	LockBuildCacheEntry(ctx context.Context, arg db.LockBuildCacheEntryParams) (bool, error)
	TouchBuildCacheEntry(ctx context.Context, arg db.TouchBuildCacheEntryParams) error
	RecordBuildCacheEntryArtifacts(ctx context.Context, arg db.RecordBuildCacheEntryArtifactsParams) error
	InsertBuildCacheArtifact(ctx context.Context, arg db.InsertBuildCacheArtifactParams) (string, error)
	LockBuildCacheArtifact(ctx context.Context, arg db.LockBuildCacheArtifactParams) (db.LockBuildCacheArtifactRow, error)
	TouchBuildCacheArtifact(ctx context.Context, arg db.TouchBuildCacheArtifactParams) error
	RepairBuildCacheArtifact(ctx context.Context, arg db.RepairBuildCacheArtifactParams) error
	AdvisoryLock(ctx context.Context, class, key int32) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// BuildCacheStore is the persistence surface behind the build cache.
type BuildCacheStore interface {
	GetBuildCacheEntry(ctx context.Context, arg db.GetBuildCacheEntryParams) (string, error)
	ListExpiredBuildCacheRepositories(ctx context.Context, cutoff time.Time) ([]int64, error)
	GetBuildCacheArtifact(ctx context.Context, arg db.GetBuildCacheArtifactParams) (db.GetBuildCacheArtifactRow, error)
	ListPresentBuildCacheArtifacts(ctx context.Context, arg db.ListPresentBuildCacheArtifactsParams) ([]string, error)
	CreateBuildCacheReadToken(ctx context.Context, arg db.CreateBuildCacheReadTokenParams) (db.BuildCacheReadToken, error)
	ListBuildCacheReadTokens(ctx context.Context, repositoryID int64) ([]db.BuildCacheReadToken, error)
	GetActiveBuildCacheReadTokenByHash(ctx context.Context, tokenHash string) (db.BuildCacheReadToken, error)
	TouchBuildCacheReadToken(ctx context.Context, id int64) error
	RevokeBuildCacheReadToken(ctx context.Context, arg db.RevokeBuildCacheReadTokenParams) (int64, error)
	Begin(ctx context.Context) (BuildCacheTx, error)
	Ping(ctx context.Context) error
}

// pgxBuildCacheStore is the production store: sqlc queries over a pgx pool.
type pgxBuildCacheStore struct {
	*db.Queries
	pool *pgxpool.Pool
}

type pgxBuildCacheTx struct {
	*db.Queries
	tx pgx.Tx
}

func (t *pgxBuildCacheTx) AdvisoryLock(ctx context.Context, class, key int32) error {
	_, err := t.tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1::int4, $2::int4)", class, key)
	return err
}

func (t *pgxBuildCacheTx) Commit(ctx context.Context) error   { return t.tx.Commit(ctx) }
func (t *pgxBuildCacheTx) Rollback(ctx context.Context) error { return t.tx.Rollback(ctx) }

func (s *pgxBuildCacheStore) Begin(ctx context.Context) (BuildCacheTx, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &pgxBuildCacheTx{Queries: s.Queries.WithTx(tx), tx: tx}, nil
}

func (s *pgxBuildCacheStore) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// NewPgxBuildCacheStore wraps the generated queries and the pool as a store.
func NewPgxBuildCacheStore(queries *db.Queries, pool *pgxpool.Pool) BuildCacheStore {
	return &pgxBuildCacheStore{Queries: queries, pool: pool}
}

// BuildCacheService hosts the smithers build cache protocol per repository.
// Action entries live in Postgres; artifact bytes live in the blob store under
// a repository-scoped key, so two repositories never see each other's cache.
type BuildCacheService struct {
	// Configure before serving requests. Nonpositive values select safe defaults.
	MaxAge             time.Duration
	MaxRepositoryBytes int64
	store              BuildCacheStore
	blobs              blob.Store
	maxArtifactBytes   int64
	now                func() time.Time
}

// NewBuildCacheService constructs the service. maxArtifactBytes bounds one
// PUT /cas body; zero selects the protocol default.
func NewBuildCacheService(store BuildCacheStore, blobs blob.Store, maxArtifactBytes int64) *BuildCacheService {
	if maxArtifactBytes <= 0 || maxArtifactBytes > buildcache.MaxArtifactBodyBytes {
		maxArtifactBytes = buildcache.DefaultArtifactBodyBytes
	}
	return &BuildCacheService{MaxAge: 30 * 24 * time.Hour, MaxRepositoryBytes: 1 << 30, store: store, blobs: blobs, maxArtifactBytes: maxArtifactBytes, now: time.Now}
}

// MaxArtifactBytes is the configured PUT /cas bound.
func (s *BuildCacheService) MaxArtifactBytes() int64 { return s.maxArtifactBytes }

// ArtifactBlobKey is the blob-store key for one repository's artifact.
func ArtifactBlobKey(repositoryID int64, digest string) string {
	return fmt.Sprintf("build-cache/%d/%s", repositoryID, digest)
}

func buildCacheLockKey(repositoryID int64, key string) int32 {
	h := fnv.New32a()
	_, _ = fmt.Fprintf(h, "%d:%s", repositoryID, key)
	return int32(h.Sum32())
}

func (s *BuildCacheService) cutoff() time.Time {
	age := s.MaxAge
	if age <= 0 {
		age = 30 * 24 * time.Hour
	}
	return s.now().Add(-age)
}

// All writers take this lock first, including writes to distinct keys on
// different replicas. Expiry never releases quota until object deletion succeeds.
func (s *BuildCacheService) prepareWrite(ctx context.Context, tx BuildCacheTx, repositoryID int64) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := tx.AdvisoryLock(ctx, buildCacheRepositoryLockClass, buildCacheLockKey(repositoryID, "")); err != nil {
		return err
	}
	cutoff := s.cutoff()
	if err := tx.ExpireBuildCacheEntries(ctx, db.ExpireBuildCacheEntriesParams{RepositoryID: repositoryID, Cutoff: cutoff}); err != nil {
		return err
	}
	keys, err := tx.ExpireBuildCacheArtifacts(ctx, db.ExpireBuildCacheArtifactsParams{RepositoryID: repositoryID, Cutoff: cutoff})
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := blob.PurgeAllGenerations(ctx, s.blobs, key); err != nil && !errors.Is(err, blob.ErrObjectNotFound) {
			return err
		}
	}
	return nil
}

// Cleanup reclaims a bounded batch from inactive repositories. Each repository
// commits separately, so a failed or cancelled sweep preserves prior progress.
func (s *BuildCacheService) Cleanup(ctx context.Context) error {
	repositories, err := s.store.ListExpiredBuildCacheRepositories(ctx, s.cutoff())
	if err != nil {
		return err
	}
	var failures error
	for _, repositoryID := range repositories {
		if err := ctx.Err(); err != nil {
			return errors.Join(failures, err)
		}
		tx, err := s.store.Begin(ctx)
		if err != nil {
			return errors.Join(failures, err)
		}
		err = s.prepareWrite(ctx, tx, repositoryID)
		if err == nil {
			err = tx.Commit(ctx)
		}
		_ = tx.Rollback(context.WithoutCancel(ctx))
		failures = errors.Join(failures, err)
	}
	return failures
}

func (s *BuildCacheService) checkQuota(ctx context.Context, tx BuildCacheTx, repositoryID int64) error {
	used, err := tx.BuildCacheRepositoryBytes(ctx, repositoryID)
	if err != nil {
		return err
	}
	limit := s.MaxRepositoryBytes
	if limit <= 0 {
		limit = 1 << 30
	}
	if used > limit {
		return pkgerrors.RequestEntityTooLarge("repository build cache quota exceeded")
	}
	return nil
}

// GetEntry returns the stored publication verbatim; the read is also the
// access record. A row that fails re-validation is an error, never a hit.
func (s *BuildCacheService) GetEntry(ctx context.Context, repositoryID int64, keyDigest string) (string, bool, error) {
	body, err := s.store.GetBuildCacheEntry(ctx, db.GetBuildCacheEntryParams{RepositoryID: repositoryID, KeyDigest: keyDigest, Cutoff: s.cutoff()})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	if err := buildcache.ValidateStoredBody(keyDigest, body); err != nil {
		return "", false, err
	}
	return body, true, nil
}

// PutEntry publishes one entry and classifies the row it left behind. First
// writer wins: an identical re-publication is not a conflict, a different
// result under the same key is, and a conflict records no references.
func (s *BuildCacheService) PutEntry(ctx context.Context, repositoryID int64, keyDigest string, publication buildcache.Publication) (PublicationOutcome, error) {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.prepareWrite(ctx, tx, repositoryID); err != nil {
		return "", err
	}
	if err := tx.AdvisoryLock(ctx, buildCachePublicationLockClass, buildCacheLockKey(repositoryID, keyDigest)); err != nil {
		return "", err
	}
	params := db.InsertBuildCacheEntryParams{
		RepositoryID:    repositoryID,
		KeyDigest:       keyDigest,
		Body:            publication.Body,
		ResultCanonical: publication.ResultCanonical,
	}
	if publication.CreatedAtMs != nil {
		params.CreatedAtMs = pgtype.Int8{Int64: *publication.CreatedAtMs, Valid: true}
	}
	if publication.RecordedRunID != nil && publication.RecordedEventSeq != nil {
		params.RecordedRunID = pgtype.Text{String: *publication.RecordedRunID, Valid: true}
		params.RecordedEventSeq = pgtype.Int8{Int64: *publication.RecordedEventSeq, Valid: true}
	}
	references := db.RecordBuildCacheEntryArtifactsParams{RepositoryID: repositoryID, KeyDigest: keyDigest, Digests: publication.Digests}
	for attempt := 0; attempt < buildCacheMaxPublicationAttempts; attempt++ {
		if _, err := tx.InsertBuildCacheEntry(ctx, params); err == nil {
			if err := s.checkQuota(ctx, tx, repositoryID); err != nil {
				return "", err
			}
			if len(references.Digests) > 0 {
				if err := tx.RecordBuildCacheEntryArtifacts(ctx, references); err != nil {
					return "", err
				}
			}
			return PublicationInserted, tx.Commit(ctx)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		same, err := tx.LockBuildCacheEntry(ctx, db.LockBuildCacheEntryParams{ResultCanonical: publication.ResultCanonical, RepositoryID: repositoryID, KeyDigest: keyDigest})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// A release got in before the row lock: retry, it is not a conflict.
				continue
			}
			return "", err
		}
		if !same {
			return PublicationConflict, tx.Commit(ctx)
		}
		if err := tx.TouchBuildCacheEntry(ctx, db.TouchBuildCacheEntryParams{RepositoryID: repositoryID, KeyDigest: keyDigest}); err != nil {
			return "", err
		}
		if len(references.Digests) > 0 {
			if err := tx.RecordBuildCacheEntryArtifacts(ctx, references); err != nil {
				return "", err
			}
		}
		return PublicationIdentical, tx.Commit(ctx)
	}
	return "", errors.New("publication lost the entry row to repeated release")
}

// DeleteEntry removes one entry, optionally fenced by the provenance it was
// published with.
func (s *BuildCacheService) DeleteEntry(ctx context.Context, repositoryID int64, keyDigest string, fence *buildcache.Fence) (bool, error) {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := tx.AdvisoryLock(ctx, buildCacheRepositoryLockClass, buildCacheLockKey(repositoryID, "")); err != nil {
		return false, err
	}
	if fence == nil {
		_, err = tx.DeleteBuildCacheEntry(ctx, db.DeleteBuildCacheEntryParams{RepositoryID: repositoryID, KeyDigest: keyDigest})
	} else {
		_, err = tx.DeleteBuildCacheEntryFenced(ctx, db.DeleteBuildCacheEntryFencedParams{
			RepositoryID:     repositoryID,
			KeyDigest:        keyDigest,
			RecordedRunID:    pgtype.Text{String: fence.RunID, Valid: true},
			RecordedEventSeq: pgtype.Int8{Int64: fence.EventSeq, Valid: true},
		})
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, tx.Commit(ctx)
}

// HasArtifact reports presence and freshens the row.
func (s *BuildCacheService) HasArtifact(ctx context.Context, repositoryID int64, digest string) (bool, error) {
	row, err := s.store.GetBuildCacheArtifact(ctx, db.GetBuildCacheArtifactParams{RepositoryID: repositoryID, Digest: digest, Cutoff: s.cutoff()})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	exists, err := s.blobs.Exists(ctx, row.GcsKey)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, nil
	}
	return true, nil
}

// OpenArtifact streams one artifact's bytes. The caller closes the reader.
func (s *BuildCacheService) OpenArtifact(ctx context.Context, repositoryID int64, digest string) (io.ReadCloser, int64, bool, error) {
	row, err := s.store.GetBuildCacheArtifact(ctx, db.GetBuildCacheArtifactParams{RepositoryID: repositoryID, Digest: digest, Cutoff: s.cutoff()})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, false, nil
		}
		return nil, 0, false, err
	}
	reader, err := s.blobs.NewReader(ctx, row.GcsKey)
	if err != nil {
		if errors.Is(err, blob.ErrObjectNotFound) {
			return nil, 0, false, nil
		}
		return nil, 0, false, err
	}
	return reader, row.SizeBytes, true, nil
}

// PutArtifact stores bytes whose digest the caller already verified. The row
// and the object publish together: the row is visible only once the upload
// committed, and an upload failure leaves no row behind.
func (s *BuildCacheService) PutArtifact(ctx context.Context, repositoryID int64, digest string, body []byte) (ArtifactOutcome, error) {
	if int64(len(body)) > s.maxArtifactBytes {
		return "", pkgerrors.RequestEntityTooLarge("request body exceeds the configured bound")
	}
	if buildcache.SHA256Hex(body) != digest {
		return "", pkgerrors.BadRequest("bytes digest to " + buildcache.SHA256Hex(body))
	}
	key := ArtifactBlobKey(repositoryID, digest)
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.prepareWrite(ctx, tx, repositoryID); err != nil {
		return "", err
	}
	if err := tx.AdvisoryLock(ctx, buildCacheArtifactLockClass, buildCacheLockKey(repositoryID, digest)); err != nil {
		return "", err
	}
	for attempt := 0; attempt < buildCacheMaxPublicationAttempts; attempt++ {
		_, err := tx.InsertBuildCacheArtifact(ctx, db.InsertBuildCacheArtifactParams{RepositoryID: repositoryID, Digest: digest, SizeBytes: int64(len(body)), GcsKey: key})
		if err == nil {
			if err := s.checkQuota(ctx, tx, repositoryID); err != nil {
				return "", err
			}
			if err := blob.Put(ctx, s.blobs, key, "application/octet-stream", bytes.NewReader(body)); err != nil {
				return "", err
			}
			return ArtifactInserted, tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		row, err := tx.LockBuildCacheArtifact(ctx, db.LockBuildCacheArtifactParams{RepositoryID: repositoryID, Digest: digest})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return "", err
		}
		exists, err := s.blobs.Exists(ctx, row.GcsKey)
		if err != nil {
			return "", err
		}
		if exists && row.SizeBytes == int64(len(body)) {
			if err := tx.TouchBuildCacheArtifact(ctx, db.TouchBuildCacheArtifactParams{RepositoryID: repositoryID, Digest: digest}); err != nil {
				return "", err
			}
			return ArtifactPresent, tx.Commit(ctx)
		}
		// The row outlived its object, or recorded a size the bytes do not
		// have. The address now holds the content the client published.
		if err := tx.RepairBuildCacheArtifact(ctx, db.RepairBuildCacheArtifactParams{SizeBytes: int64(len(body)), GcsKey: key, RepositoryID: repositoryID, Digest: digest}); err != nil {
			return "", err
		}
		if err := s.checkQuota(ctx, tx, repositoryID); err != nil {
			return "", err
		}
		if err := blob.Put(ctx, s.blobs, key, "application/octet-stream", bytes.NewReader(body)); err != nil {
			return "", err
		}
		return ArtifactRepaired, tx.Commit(ctx)
	}
	return "", errors.New("artifact publication lost its row to repeated release")
}

// PresentDigests reports unexpired artifact records and records access.
// Access does not renew the creation-based maximum age.
func (s *BuildCacheService) PresentDigests(ctx context.Context, repositoryID int64, digests []string) (map[string]struct{}, error) {
	present := map[string]struct{}{}
	if len(digests) == 0 {
		return present, nil
	}
	rows, err := s.store.ListPresentBuildCacheArtifacts(ctx, db.ListPresentBuildCacheArtifactsParams{RepositoryID: repositoryID, Digests: digests, Cutoff: s.cutoff()})
	if err != nil {
		return nil, err
	}
	for _, digest := range rows {
		digest = strings.TrimSpace(digest)
		exists, err := s.blobs.Exists(ctx, ArtifactBlobKey(repositoryID, digest))
		if err != nil {
			return nil, err
		}
		if exists {
			present[digest] = struct{}{}
		}
	}
	return present, nil
}

// Health answers the readiness probe: the database is reachable.
func (s *BuildCacheService) Health(ctx context.Context) error { return s.store.Ping(ctx) }

// BuildCacheReadTokenResponse is the API shape of one public read token.
type BuildCacheReadTokenResponse struct {
	ID              int64      `json:"id"`
	Repository      string     `json:"repository"`
	Name            string     `json:"name"`
	NamespacePrefix string     `json:"namespace_prefix"`
	LastEight       string     `json:"last_eight"`
	CreatedAt       time.Time  `json:"created_at"`
	LastUsedAt      *time.Time `json:"last_used_at,omitempty"`
}

// BuildCacheReadTokenCreated carries the plaintext exactly once.
type BuildCacheReadTokenCreated struct {
	BuildCacheReadTokenResponse
	// Token is the public read token. It grants nothing except reading this
	// repository's build cache and is safe to commit to the repository.
	Token    string `json:"token"`
	Endpoint string `json:"endpoint"`
}

func readTokenResponse(repository string, row db.BuildCacheReadToken) BuildCacheReadTokenResponse {
	response := BuildCacheReadTokenResponse{
		ID:              row.ID,
		Repository:      repository,
		Name:            row.Name,
		NamespacePrefix: row.NamespacePrefix,
		LastEight:       row.TokenLastEight,
		CreatedAt:       row.CreatedAt.UTC(),
	}
	if row.LastUsedAt.Valid {
		at := row.LastUsedAt.Time.UTC()
		response.LastUsedAt = &at
	}
	return response
}

// CreateReadToken mints a public read token for one repository.
func (s *BuildCacheService) CreateReadToken(ctx context.Context, actor *db.User, repository *db.Repository, repositoryFullName, name, endpoint, namespacePrefix string) (BuildCacheReadTokenCreated, error) {
	if repository == nil {
		return BuildCacheReadTokenCreated{}, pkgerrors.NotFound("repository not found")
	}
	name = strings.TrimSpace(name)
	if len(name) > 255 {
		return BuildCacheReadTokenCreated{}, pkgerrors.BadRequest("token name must be at most 255 characters")
	}
	if !buildcache.ValidNamespacePrefix(namespacePrefix) {
		return BuildCacheReadTokenCreated{}, pkgerrors.BadRequest("namespace_prefix must be one namespace ending in /")
	}
	plaintext := buildcache.ReadTokenPrefix + randomHex(20)
	hash := buildcache.TokenHash(plaintext)
	params := db.CreateBuildCacheReadTokenParams{
		RepositoryID:    repository.ID,
		Name:            name,
		TokenHash:       hash,
		TokenLastEight:  plaintext[len(plaintext)-8:],
		NamespacePrefix: namespacePrefix,
	}
	if actor != nil {
		params.CreatedBy = pgtype.Int8{Int64: actor.ID, Valid: true}
	}
	row, err := s.store.CreateBuildCacheReadToken(ctx, params)
	if err != nil {
		return BuildCacheReadTokenCreated{}, err
	}
	return BuildCacheReadTokenCreated{
		BuildCacheReadTokenResponse: readTokenResponse(repositoryFullName, row),
		Token:                       plaintext,
		Endpoint:                    endpoint,
	}, nil
}

// ListReadTokens lists the active public read tokens of one repository.
func (s *BuildCacheService) ListReadTokens(ctx context.Context, repository *db.Repository, repositoryFullName string) ([]BuildCacheReadTokenResponse, error) {
	if repository == nil {
		return nil, pkgerrors.NotFound("repository not found")
	}
	rows, err := s.store.ListBuildCacheReadTokens(ctx, repository.ID)
	if err != nil {
		return nil, err
	}
	out := make([]BuildCacheReadTokenResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, readTokenResponse(repositoryFullName, row))
	}
	return out, nil
}

// RevokeReadToken revokes one token; a token of another repository is 404.
func (s *BuildCacheService) RevokeReadToken(ctx context.Context, repository *db.Repository, id int64) error {
	if repository == nil {
		return pkgerrors.NotFound("repository not found")
	}
	if _, err := s.store.RevokeBuildCacheReadToken(ctx, db.RevokeBuildCacheReadTokenParams{ID: id, RepositoryID: repository.ID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("build cache token not found")
		}
		return err
	}
	return nil
}

// ResolveReadToken maps a presented public read token to its active row.
// The middleware calls it; a revoked or unknown token is pgx.ErrNoRows.
func (s *BuildCacheService) ResolveReadToken(ctx context.Context, token string) (db.BuildCacheReadToken, error) {
	if !buildcache.IsReadToken(token) {
		return db.BuildCacheReadToken{}, pgx.ErrNoRows
	}
	row, err := s.store.GetActiveBuildCacheReadTokenByHash(ctx, buildcache.TokenHash(token))
	if err != nil {
		return db.BuildCacheReadToken{}, err
	}
	if err := s.store.TouchBuildCacheReadToken(ctx, row.ID); err != nil {
		slog.Debug("build cache read token touch failed", "error", err)
	}
	return row, nil
}
