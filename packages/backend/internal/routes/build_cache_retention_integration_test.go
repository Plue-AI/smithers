//go:build integration

package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type cacheRetentionFixture struct {
	pool         *pgxpool.Pool
	owner        routesIntegrationUser
	repo         routesIntegrationRepo
	token        string
	blobs        *blob.MemoryStore
	first        *services.BuildCacheService
	second       *services.BuildCacheService
	firstRouter  http.Handler
	secondRouter http.Handler
}

type cacheDeleteFailureStore struct{ blob.Store }

func (cacheDeleteFailureStore) Delete(context.Context, string) error {
	return errors.New("injected blob deletion failure")
}

type cacheGenerationPurgeStore struct {
	*blob.MemoryStore
	purged []string
}

func (s *cacheGenerationPurgeStore) Delete(context.Context, string) error {
	return errors.New("ordinary Delete must not be used for build-cache expiry")
}

func (s *cacheGenerationPurgeStore) PurgeAllGenerations(ctx context.Context, key string) error {
	s.purged = append(s.purged, key)
	return s.MemoryStore.Delete(ctx, key)
}

func newCacheRetentionFixture(t *testing.T, maxBytes int64) *cacheRetentionFixture {
	t.Helper()
	pool := setupRoutesIntegrationPool(t)
	q := db.New(pool)
	owner := routesIntegrationCreateUser(t, pool, "cache_retention")
	repo := routesIntegrationCreateRepo(t, pool, owner, "cache", false)
	auth := services.NewAuthService(q, config.AuthConfig{}, nil, nil)
	pat, err := auth.CreateToken(context.Background(), owner.ID, services.CreateTokenRequest{
		Name: "cache retention", Scopes: []string{string(middleware.ScopeWriteRepository)},
	})
	require.NoError(t, err)
	blobs := blob.NewMemoryStore()
	first := services.NewBuildCacheService(services.NewPgxBuildCacheStore(q, pool), blobs, 0)
	second := services.NewBuildCacheService(services.NewPgxBuildCacheStore(db.New(pool), pool), blobs, 0)
	first.MaxRepositoryBytes, second.MaxRepositoryBytes = maxBytes, maxBytes
	h1, h2 := &BuildCacheHandler{Service: first}, &BuildCacheHandler{Service: second}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, first))
		r.Use(middleware.RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", h1.ActionCache)
		r.HandleFunc("/cas/{digest}", h1.Artifact)
		r.Post("/cas/findMissing", h1.FindMissing)
	})
	// The second service has its own store and handler; a separate router uses
	// the same auth and database to model another API process.
	router2 := chi.NewRouter()
	router2.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router2.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, second))
		r.Use(middleware.RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", h2.ActionCache)
		r.HandleFunc("/cas/{digest}", h2.Artifact)
		r.Post("/cas/findMissing", h2.FindMissing)
	})
	return &cacheRetentionFixture{pool: pool, owner: owner, repo: repo, token: pat.Token, blobs: blobs,
		first: first, second: second, firstRouter: router, secondRouter: router2}
}

func (f *cacheRetentionFixture) serve(repo routesIntegrationRepo, second bool, method, path, mediaType string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method,
		fmt.Sprintf("/api/repos/%s/%s/build-cache%s", repo.Owner, repo.Name, path), strings.NewReader(string(body)))
	request.Header.Set("Authorization", "Bearer "+f.token)
	if mediaType != "" {
		request.Header.Set("Content-Type", mediaType)
	}
	rec := httptest.NewRecorder()
	if second {
		f.secondRouter.ServeHTTP(rec, request)
	} else {
		f.firstRouter.ServeHTTP(rec, request)
	}
	return rec
}

func (f *cacheRetentionFixture) action(repo routesIntegrationRepo, second bool, method, key, body string) *httptest.ResponseRecorder {
	return f.serve(repo, second, method, "/ac/"+key, "application/json", []byte(body))
}

func (f *cacheRetentionFixture) artifact(repo routesIntegrationRepo, second bool, method, digest string, body []byte) *httptest.ResponseRecorder {
	return f.serve(repo, second, method, "/cas/"+digest, "application/octet-stream", body)
}

func (f *cacheRetentionFixture) requireUsageMatchesRows(t *testing.T, repositoryID int64) int64 {
	t.Helper()
	ctx := context.Background()
	var rows, accounted int64
	require.NoError(t, f.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM (
			SELECT GREATEST(1024::bigint, octet_length(body)::bigint + octet_length(result_canonical)::bigint) AS size_bytes
			FROM build_cache_entries WHERE repository_id=$1
			UNION ALL
			SELECT GREATEST(1024::bigint, size_bytes) FROM build_cache_artifacts WHERE repository_id=$1
		) charged`, repositoryID).Scan(&rows))
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT COALESCE((SELECT size_bytes FROM build_cache_repository_usage WHERE repository_id=$1), 0)",
		repositoryID).Scan(&accounted))
	require.Equal(t, rows, accounted, "quota counter must equal independently summed live rows")
	return accounted
}

// This exercises the cache protocol through the production route, real auth,
// Postgres queries, and the real service. The clock is moved through server
// timestamps so client-supplied createdAtMs cannot determine retention.
func TestBuildCacheRetentionExpiredActionIsMiss(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	q := db.New(pool)
	owner := routesIntegrationCreateUser(t, pool, "cache_retention")
	repo := routesIntegrationCreateRepo(t, pool, owner, "cache", false)
	auth := services.NewAuthService(q, config.AuthConfig{}, nil, nil)
	pat, err := auth.CreateToken(context.Background(), owner.ID, services.CreateTokenRequest{
		Name: "cache retention", Scopes: []string{string(middleware.ScopeWriteRepository)},
	})
	require.NoError(t, err)
	cache := services.NewBuildCacheService(services.NewPgxBuildCacheStore(q, pool), blob.NewMemoryStore(), 0)
	handler := &BuildCacheHandler{Service: cache}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, cache))
		r.Use(middleware.RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", handler.ActionCache)
	})
	key := "expired-action"
	path := fmt.Sprintf("/api/repos/%s/%s/build-cache/ac/%s", repo.Owner, repo.Name, key)
	serve := func(method, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+pat.Token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	body := fmt.Sprintf(`{"keyDigest":%q,"createdAtMs":0,"result":{"exitOk":true}}`, key)
	require.Equal(t, http.StatusCreated, serve(http.MethodPut, body).Code)
	require.Equal(t, http.StatusOK, serve(http.MethodGet, "").Code,
		"fresh server-created entry must survive an old client timestamp")
	_, err = pool.Exec(context.Background(),
		"UPDATE build_cache_entries SET created_at=$1, last_accessed_at=now() WHERE repository_id=$2 AND key_digest=$3",
		time.Now().Add(-31*24*time.Hour), repo.ID, key)
	require.NoError(t, err)
	rec := serve(http.MethodGet, "")
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}

func TestBuildCacheRetentionConfiguredAgeAndDuplicateDoesNotRenew(t *testing.T) {
	f := newCacheRetentionFixture(t, 3*1024)
	f.first.MaxAge, f.second.MaxAge = 24*time.Hour, 24*time.Hour
	ctx := context.Background()
	key := "age-boundary"
	body := fmt.Sprintf(`{"keyDigest":%q,"createdAtMs":0,"result":{"exitOk":true}}`, key)
	require.Equal(t, http.StatusCreated, f.action(f.repo, false, http.MethodPut, key, body).Code)
	created := time.Now().Add(-23 * time.Hour).UTC().Truncate(time.Microsecond)
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_entries SET created_at=$1 WHERE repository_id=$2 AND key_digest=$3",
		created, f.repo.ID, key)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, f.action(f.repo, true, http.MethodPut, key, body).Code)
	var after time.Time
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT created_at FROM build_cache_entries WHERE repository_id=$1 AND key_digest=$2",
		f.repo.ID, key).Scan(&after))
	require.True(t, after.Equal(created), "duplicate PUT must retain server creation time: got %s, want %s", after, created)
	require.Equal(t, http.StatusOK, f.action(f.repo, false, http.MethodGet, key, "").Code)
	_, err = f.pool.Exec(ctx,
		"UPDATE build_cache_entries SET created_at=$1, last_accessed_at=now() WHERE repository_id=$2 AND key_digest=$3",
		time.Now().Add(-25*time.Hour), f.repo.ID, key)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, f.action(f.repo, true, http.MethodGet, key, "").Code)
}

func TestBuildCacheRetentionArtifactReferencesAndRepublication(t *testing.T) {
	f := newCacheRetentionFixture(t, 3*1024)
	ctx := context.Background()
	payload := []byte("artifact bytes")
	digest := buildcache.SHA256Hex(payload)
	key := "retained-reference"
	body := fmt.Sprintf(`{"keyDigest":%q,"createdAtMs":0,"result":{"exitOk":true},"meta":{"boundary":{"declaredOutputs":{"outputs":[{"digest":%q}]}}}}`, key, digest)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	require.Equal(t, http.StatusCreated, f.action(f.repo, false, http.MethodPut, key, body).Code)
	require.Equal(t, http.StatusOK, f.action(f.repo, false, http.MethodGet, key, "").Code)
	// A recent action must become a miss if one of its declared artifacts
	// expires; serving the action would give a client an unusable result.
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET created_at=$1, last_accessed_at=now() WHERE repository_id=$2 AND digest=$3",
		time.Now().Add(-31*24*time.Hour), f.repo.ID, digest)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, f.artifact(f.repo, false, http.MethodHead, digest, nil).Code)
	require.Equal(t, http.StatusNotFound, f.artifact(f.repo, false, http.MethodGet, digest, nil).Code)
	missing := f.serve(f.repo, false, http.MethodPost, "/cas/findMissing", "application/json",
		[]byte(fmt.Sprintf(`{"digests":[%q]}`, digest)))
	require.Equal(t, http.StatusOK, missing.Code, missing.Body.String())
	var result struct {
		Missing []string `json:"missing"`
	}
	require.NoError(t, json.Unmarshal(missing.Body.Bytes(), &result))
	require.Equal(t, []string{digest}, result.Missing)
	require.Equal(t, http.StatusNotFound, f.action(f.repo, false, http.MethodGet, key, "").Code)
	// A write prunes both the expired artifact and its dependent action and
	// removes the object. A client can then republish the same addresses.
	other := f.action(f.repo, false, http.MethodPut, "cleanup-trigger",
		`{"keyDigest":"cleanup-trigger","result":{"exitOk":true}}`)
	require.Equal(t, http.StatusCreated, other.Code, other.Body.String())
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1 AND key_digest=$2", f.repo.ID, key).Scan(&count))
	require.Zero(t, count)
	exists, err := f.blobs.Exists(ctx, services.ArtifactBlobKey(f.repo.ID, digest))
	require.NoError(t, err)
	require.False(t, exists)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, true, http.MethodPut, digest, payload).Code)
	require.Equal(t, http.StatusCreated, f.action(f.repo, true, http.MethodPut, key, body).Code)
	require.Equal(t, http.StatusOK, f.action(f.repo, false, http.MethodGet, key, "").Code)
}

func TestBuildCacheRetentionCleanupFailsClosedWhenBlobDeleteFails(t *testing.T) {
	f := newCacheRetentionFixture(t, 3*1024)
	ctx := context.Background()
	payload := []byte("must remain after failed cleanup")
	digest := buildcache.SHA256Hex(payload)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET created_at=$1 WHERE repository_id=$2 AND digest=$3",
		time.Now().Add(-31*24*time.Hour), f.repo.ID, digest)
	require.NoError(t, err)
	q := db.New(f.pool)
	failing := services.NewBuildCacheService(services.NewPgxBuildCacheStore(q, f.pool),
		cacheDeleteFailureStore{Store: f.blobs}, 0)
	failing.MaxRepositoryBytes = 3 * 1024
	handler := &BuildCacheHandler{Service: failing}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, failing))
		r.Use(middleware.RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", handler.ActionCache)
	})
	f.secondRouter = router
	refused := f.action(f.repo, true, http.MethodPut, "cleanup-refused",
		`{"keyDigest":"cleanup-refused","result":{"exitOk":true}}`)
	require.Equal(t, http.StatusServiceUnavailable, refused.Code, refused.Body.String())
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1 AND key_digest='cleanup-refused'",
		f.repo.ID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1 AND digest=$2", f.repo.ID, digest).Scan(&count))
	require.Equal(t, 1, count)
	exists, err := f.blobs.Exists(ctx, services.ArtifactBlobKey(f.repo.ID, digest))
	require.NoError(t, err)
	require.True(t, exists)
	// A healthy retry can finish the pending cleanup and publication.
	retry := f.action(f.repo, false, http.MethodPut, "cleanup-refused",
		`{"keyDigest":"cleanup-refused","result":{"exitOk":true}}`)
	require.Equal(t, http.StatusCreated, retry.Code, retry.Body.String())
}

func TestBuildCacheRetentionUsesGenerationPurge(t *testing.T) {
	f := newCacheRetentionFixture(t, 3*1024)
	ctx := context.Background()
	payload := []byte("all generations must go")
	digest := buildcache.SHA256Hex(payload)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET created_at=$1 WHERE repository_id=$2 AND digest=$3",
		time.Now().Add(-31*24*time.Hour), f.repo.ID, digest)
	require.NoError(t, err)
	q := db.New(f.pool)
	purger := &cacheGenerationPurgeStore{MemoryStore: f.blobs}
	service := services.NewBuildCacheService(services.NewPgxBuildCacheStore(q, f.pool), purger, 0)
	service.MaxRepositoryBytes = 3 * 1024
	handler := &BuildCacheHandler{Service: service}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, service))
		r.Use(middleware.RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", handler.ActionCache)
	})
	f.secondRouter = router
	response := f.action(f.repo, true, http.MethodPut, "purge-trigger",
		`{"keyDigest":"purge-trigger","result":{"exitOk":true}}`)
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	key := services.ArtifactBlobKey(f.repo.ID, digest)
	require.Equal(t, []string{key}, purger.purged)
	exists, err := f.blobs.Exists(ctx, key)
	require.NoError(t, err)
	require.False(t, exists)
}

func TestBuildCacheRetentionMissingPhysicalArtifactRepairs(t *testing.T) {
	f := newCacheRetentionFixture(t, 2*1024)
	ctx := context.Background()
	payload := []byte("repaired artifact")
	digest := buildcache.SHA256Hex(payload)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	require.NoError(t, f.blobs.Delete(ctx, services.ArtifactBlobKey(f.repo.ID, digest)))
	require.Equal(t, http.StatusNotFound, f.artifact(f.repo, false, http.MethodHead, digest, nil).Code)
	require.Equal(t, http.StatusNotFound, f.artifact(f.repo, true, http.MethodGet, digest, nil).Code)
	probe := f.serve(f.repo, false, http.MethodPost, "/cas/findMissing", "application/json",
		[]byte(fmt.Sprintf(`{"digests":[%q]}`, digest)))
	require.Equal(t, http.StatusOK, probe.Code, probe.Body.String())
	var result struct {
		Missing []string `json:"missing"`
	}
	require.NoError(t, json.Unmarshal(probe.Body.Bytes(), &result))
	require.Equal(t, []string{digest}, result.Missing)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1 AND digest=$2", f.repo.ID, digest).Scan(&count))
	require.Equal(t, 1, count, "the retained row lets a later upload repair the missing object")
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET size_bytes=2048 WHERE repository_id=$1 AND digest=$2", f.repo.ID, digest)
	require.NoError(t, err)
	require.Equal(t, int64(2048), f.requireUsageMatchesRows(t, f.repo.ID))
	require.Equal(t, http.StatusOK, f.artifact(f.repo, true, http.MethodPut, digest, payload).Code)
	require.Equal(t, http.StatusOK, f.artifact(f.repo, false, http.MethodHead, digest, nil).Code)
	got := f.artifact(f.repo, false, http.MethodGet, digest, nil)
	require.Equal(t, http.StatusOK, got.Code, got.Body.String())
	require.Equal(t, payload, got.Body.Bytes())
	require.Equal(t, int64(1024), f.requireUsageMatchesRows(t, f.repo.ID), "repair keeps one artifact charge")
}

func TestBuildCacheRetentionArtifactReadsAndDuplicateDoNotRenewAge(t *testing.T) {
	f := newCacheRetentionFixture(t, 2*1024)
	f.first.MaxAge, f.second.MaxAge = 24*time.Hour, 24*time.Hour
	ctx := context.Background()
	payload := []byte("old but recently read")
	digest := buildcache.SHA256Hex(payload)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	created := time.Now().Add(-23 * time.Hour).UTC().Truncate(time.Microsecond)
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET created_at=$1 WHERE repository_id=$2 AND digest=$3",
		created, f.repo.ID, digest)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, f.artifact(f.repo, false, http.MethodHead, digest, nil).Code)
	require.Equal(t, http.StatusOK, f.artifact(f.repo, true, http.MethodGet, digest, nil).Code)
	probe := f.serve(f.repo, false, http.MethodPost, "/cas/findMissing", "application/json",
		[]byte(fmt.Sprintf(`{"digests":[%q]}`, digest)))
	require.Equal(t, http.StatusOK, probe.Code, probe.Body.String())
	var result struct {
		Missing []string `json:"missing"`
	}
	require.NoError(t, json.Unmarshal(probe.Body.Bytes(), &result))
	require.Empty(t, result.Missing)
	require.Equal(t, http.StatusOK, f.artifact(f.repo, true, http.MethodPut, digest, payload).Code)
	var after time.Time
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT created_at FROM build_cache_artifacts WHERE repository_id=$1 AND digest=$2",
		f.repo.ID, digest).Scan(&after))
	require.True(t, after.Equal(created), "duplicate PUT and probes must preserve artifact creation time")
	_, err = f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET created_at=$1, last_accessed_at=now() WHERE repository_id=$2 AND digest=$3",
		time.Now().Add(-25*time.Hour), f.repo.ID, digest)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, f.artifact(f.repo, false, http.MethodHead, digest, nil).Code)
	require.Equal(t, http.StatusNotFound, f.artifact(f.repo, true, http.MethodGet, digest, nil).Code)
	probe = f.serve(f.repo, true, http.MethodPost, "/cas/findMissing", "application/json",
		[]byte(fmt.Sprintf(`{"digests":[%q]}`, digest)))
	require.Equal(t, http.StatusOK, probe.Code, probe.Body.String())
	require.NoError(t, json.Unmarshal(probe.Body.Bytes(), &result))
	require.Equal(t, []string{digest}, result.Missing)
}

func TestBuildCacheRetentionBackgroundCleanupDrainsBoundedBacklog(t *testing.T) {
	f := newCacheRetentionFixture(t, 1<<30)
	ctx := context.Background()
	inactive := routesIntegrationCreateRepo(t, f.pool, f.owner, "inactive_cache", false)
	old := time.Now().Add(-31 * 24 * time.Hour)
	for i := 0; i < 65; i++ {
		key := fmt.Sprintf("stale-entry-%02d", i)
		body := fmt.Sprintf(`{"keyDigest":%q,"result":{}}`, key)
		_, err := f.pool.Exec(ctx,
			"INSERT INTO build_cache_entries(repository_id,key_digest,body,result_canonical,created_at) VALUES($1,$2,$3,'{}',$4)",
			inactive.ID, key, body, old)
		require.NoError(t, err)
	}
	for i := 0; i < 17; i++ {
		digest := fmt.Sprintf("%064x", i+1)
		key := services.ArtifactBlobKey(inactive.ID, digest)
		require.NoError(t, f.blobs.Put(ctx, key, "application/octet-stream", strings.NewReader("x")))
		_, err := f.pool.Exec(ctx,
			"INSERT INTO build_cache_artifacts(repository_id,digest,size_bytes,gcs_key,created_at) VALUES($1,$2,1,$3,$4)",
			inactive.ID, digest, key, old)
		require.NoError(t, err)
	}
	require.Equal(t, int64(82*1024), f.requireUsageMatchesRows(t, inactive.ID))
	counts := func() (int, int) {
		t.Helper()
		var entries, artifacts int
		require.NoError(t, f.pool.QueryRow(ctx,
			"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1", inactive.ID).Scan(&entries))
		require.NoError(t, f.pool.QueryRow(ctx,
			"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1", inactive.ID).Scan(&artifacts))
		return entries, artifacts
	}
	require.NoError(t, f.first.Cleanup(ctx))
	entries, artifacts := counts()
	require.Equal(t, 1, entries, "one pass must remove at most 64 entries")
	require.Equal(t, 1, artifacts, "one pass must remove at most 16 artifacts")
	require.Equal(t, int64(2*1024), f.requireUsageMatchesRows(t, inactive.ID))
	require.NoError(t, f.second.Cleanup(ctx))
	entries, artifacts = counts()
	require.Zero(t, entries)
	require.Zero(t, artifacts)
	require.Zero(t, f.requireUsageMatchesRows(t, inactive.ID))
	for i := 0; i < 17; i++ {
		digest := fmt.Sprintf("%064x", i+1)
		exists, err := f.blobs.Exists(ctx, services.ArtifactBlobKey(inactive.ID, digest))
		require.NoError(t, err)
		require.False(t, exists)
	}
}

func TestBuildCacheRetentionQuotaRefusalAfterPurgeCanRecover(t *testing.T) {
	f := newCacheRetentionFixture(t, 1024)
	ctx := context.Background()
	payload := []byte("expired charged artifact")
	digest := buildcache.SHA256Hex(payload)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	_, err := f.pool.Exec(ctx,
		"UPDATE build_cache_artifacts SET created_at=$1 WHERE repository_id=$2 AND digest=$3",
		time.Now().Add(-31*24*time.Hour), f.repo.ID, digest)
	require.NoError(t, err)
	large := strings.Repeat("x", 1100)
	refused := f.action(f.repo, false, http.MethodPut, "too-large",
		fmt.Sprintf(`{"keyDigest":"too-large","result":{"data":%q}}`, large))
	require.Equal(t, http.StatusRequestEntityTooLarge, refused.Code, refused.Body.String())
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1 AND digest=$2", f.repo.ID, digest).Scan(&count))
	require.Equal(t, 1, count, "refused write rolls back expiry metadata")
	require.Equal(t, int64(1024), f.requireUsageMatchesRows(t, f.repo.ID))
	exists, err := f.blobs.Exists(ctx, services.ArtifactBlobKey(f.repo.ID, digest))
	require.NoError(t, err)
	require.False(t, exists, "purged object stays absent after the SQL rollback")
	accepted := f.action(f.repo, true, http.MethodPut, "small",
		`{"keyDigest":"small","result":{"exitOk":true}}`)
	require.Equal(t, http.StatusCreated, accepted.Code, accepted.Body.String())
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1 AND digest=$2", f.repo.ID, digest).Scan(&count))
	require.Zero(t, count)
	require.Equal(t, int64(1024), f.requireUsageMatchesRows(t, f.repo.ID))
}

func TestBuildCacheRepositoryQuotaAcrossActionsAndArtifacts(t *testing.T) {
	f := newCacheRetentionFixture(t, 2*1024)
	ctx := context.Background()
	a := `{"keyDigest":"a","result":{"exitOk":true}}`
	b := `{"keyDigest":"b","result":{"exitOk":true}}`
	require.Equal(t, http.StatusCreated, f.action(f.repo, false, http.MethodPut, "a", a).Code)
	require.Equal(t, http.StatusCreated, f.action(f.repo, true, http.MethodPut, "b", b).Code)
	// An identical publication at the exact cap is free; a third publication
	// is refused with the quota error and leaves no row behind.
	require.Equal(t, http.StatusOK, f.action(f.repo, true, http.MethodPut, "a", a).Code)
	require.Equal(t, int64(2*1024), f.requireUsageMatchesRows(t, f.repo.ID))
	refused := f.action(f.repo, false, http.MethodPut, "c", `{"keyDigest":"c","result":{"exitOk":true}}`)
	require.Equal(t, http.StatusRequestEntityTooLarge, refused.Code, refused.Body.String())
	require.Contains(t, strings.ToLower(refused.Body.String()), "quota")
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1 AND key_digest='c'", f.repo.ID).Scan(&count))
	require.Zero(t, count)
	require.Equal(t, int64(2*1024), f.requireUsageMatchesRows(t, f.repo.ID))
	artifact := []byte("shared quota artifact")
	digest := buildcache.SHA256Hex(artifact)
	refused = f.artifact(f.repo, false, http.MethodPut, digest, artifact)
	require.Equal(t, http.StatusRequestEntityTooLarge, refused.Code, refused.Body.String())
	require.Contains(t, strings.ToLower(refused.Body.String()), "quota")
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1 AND digest=$2", f.repo.ID, digest).Scan(&count))
	require.Zero(t, count)
	exists, err := f.blobs.Exists(ctx, services.ArtifactBlobKey(f.repo.ID, digest))
	require.NoError(t, err)
	require.False(t, exists)
	// Other repositories receive their own allowance.
	repo2 := routesIntegrationCreateRepo(t, f.pool, f.owner, "other_cache", false)
	require.Equal(t, http.StatusCreated, f.artifact(repo2, false, http.MethodPut, digest, artifact).Code)
	require.Equal(t, http.StatusCreated, f.action(repo2, false, http.MethodPut, "a", a).Code)
	require.Equal(t, http.StatusOK, f.artifact(repo2, false, http.MethodHead, digest, nil).Code)
	require.Equal(t, int64(2*1024), f.requireUsageMatchesRows(t, repo2.ID))
	// Releasing one action permits one artifact, confirming the two types
	// draw from the same allowance.
	require.Equal(t, http.StatusOK, f.action(f.repo, false, http.MethodDelete, "b", "").Code)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, true, http.MethodPut, digest, artifact).Code)
	require.Equal(t, http.StatusOK, f.artifact(f.repo, false, http.MethodPut, digest, artifact).Code)
	require.Equal(t, int64(2*1024), f.requireUsageMatchesRows(t, f.repo.ID))
}

func TestBuildCacheRepositoryQuotaSerializesConcurrentServices(t *testing.T) {
	f := newCacheRetentionFixture(t, 1024)
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for i, key := range []string{"parallel-a", "parallel-b"} {
		wg.Add(1)
		go func(second bool, key string) {
			defer wg.Done()
			<-start
			results <- f.action(f.repo, second, http.MethodPut, key,
				fmt.Sprintf(`{"keyDigest":%q,"result":{"exitOk":true}}`, key))
		}(i == 1, key)
	}
	close(start)
	wg.Wait()
	close(results)
	statuses := map[int]int{}
	for response := range results {
		statuses[response.Code]++
		if response.Code == http.StatusRequestEntityTooLarge {
			require.Contains(t, strings.ToLower(response.Body.String()), "quota")
		}
	}
	require.Equal(t, map[int]int{http.StatusCreated: 1, http.StatusRequestEntityTooLarge: 1}, statuses)
	var count int
	require.NoError(t, f.pool.QueryRow(context.Background(),
		"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1", f.repo.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestBuildCacheRepositoryQuotaCountsBytesAboveFloor(t *testing.T) {
	f := newCacheRetentionFixture(t, 1500)
	ctx := context.Background()
	exact := bytes.Repeat([]byte("e"), 1500)
	digest := buildcache.SHA256Hex(exact)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, exact).Code,
		"an artifact at the byte limit fits")
	over := bytes.Repeat([]byte("o"), 1501)
	overDigest := buildcache.SHA256Hex(over)
	repo2 := routesIntegrationCreateRepo(t, f.pool, f.owner, "over_artifact", false)
	refused := f.artifact(repo2, true, http.MethodPut, overDigest, over)
	require.Equal(t, http.StatusRequestEntityTooLarge, refused.Code, refused.Body.String())
	require.Contains(t, strings.ToLower(refused.Body.String()), "quota")
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1", repo2.ID).Scan(&count))
	require.Zero(t, count)

	// The action charge includes both the verbatim envelope and the canonical
	// result. One extra whitespace byte in the envelope crosses the same cap.
	large := strings.Repeat("v", 1100)
	canonical := fmt.Sprintf(`{"data":%q}`, large)
	body := fmt.Sprintf(`{"keyDigest":"large","result":%s}`, canonical)
	capBytes := int64(len(body) + len(canonical))
	f.first.MaxRepositoryBytes, f.second.MaxRepositoryBytes = capBytes, capBytes
	repo3 := routesIntegrationCreateRepo(t, f.pool, f.owner, "exact_action", false)
	require.Equal(t, http.StatusCreated, f.action(repo3, false, http.MethodPut, "large", body).Code)
	repo4 := routesIntegrationCreateRepo(t, f.pool, f.owner, "over_action", false)
	refused = f.action(repo4, true, http.MethodPut, "large", body+" ")
	require.Equal(t, http.StatusRequestEntityTooLarge, refused.Code, refused.Body.String())
	require.Contains(t, strings.ToLower(refused.Body.String()), "quota")
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1", repo4.ID).Scan(&count))
	require.Zero(t, count)
}

func TestBuildCacheRepositoryQuotaSerializesMixedWriters(t *testing.T) {
	f := newCacheRetentionFixture(t, 1024)
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 2)
	artifact := []byte("parallel artifact")
	digest := buildcache.SHA256Hex(artifact)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		results <- f.action(f.repo, false, http.MethodPut, "parallel-action",
			`{"keyDigest":"parallel-action","result":{"exitOk":true}}`)
	}()
	go func() {
		defer wg.Done()
		<-start
		results <- f.artifact(f.repo, true, http.MethodPut, digest, artifact)
	}()
	close(start)
	wg.Wait()
	close(results)
	statuses := map[int]int{}
	for response := range results {
		statuses[response.Code]++
		if response.Code == http.StatusRequestEntityTooLarge {
			require.Contains(t, strings.ToLower(response.Body.String()), "quota")
		}
	}
	require.Equal(t, map[int]int{http.StatusCreated: 1, http.StatusRequestEntityTooLarge: 1}, statuses)
	var count int
	require.NoError(t, f.pool.QueryRow(context.Background(),
		"SELECT (SELECT count(*) FROM build_cache_entries WHERE repository_id=$1) + (SELECT count(*) FROM build_cache_artifacts WHERE repository_id=$1)",
		f.repo.ID).Scan(&count))
	require.Equal(t, 1, count)
}

func TestBuildCacheRepositoryUsageCascadesWithRepository(t *testing.T) {
	f := newCacheRetentionFixture(t, 2*1024)
	ctx := context.Background()
	payload := []byte("cascade artifact")
	digest := buildcache.SHA256Hex(payload)
	require.Equal(t, http.StatusCreated, f.artifact(f.repo, false, http.MethodPut, digest, payload).Code)
	require.Equal(t, http.StatusCreated, f.action(f.repo, false, http.MethodPut, "cascade",
		`{"keyDigest":"cascade","result":{"exitOk":true}}`).Code)
	require.Equal(t, int64(2*1024), f.requireUsageMatchesRows(t, f.repo.ID))
	// Repository deletion is fenced by its durable storage journal. Supply
	// that real product contract so this exercises the cache row cascade.
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	token := strings.Repeat("a", 64)
	_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations
		(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
		VALUES ($1,'delete',$2,'test-storage',$3,$4,$5)`,
		f.repo.ID, token, f.repo.Owner, f.repo.Name, f.owner.ID)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "SELECT set_config('smithers.repository_storage_operation_token', $1, true)", token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "DELETE FROM repositories WHERE id=$1", f.repo.ID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	var count int
	require.NoError(t, f.pool.QueryRow(ctx,
		"SELECT count(*) FROM build_cache_repository_usage WHERE repository_id=$1", f.repo.ID).Scan(&count))
	require.Zero(t, count)
}
