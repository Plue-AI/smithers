package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

type scopedCacheRepoQuerier struct {
	middleware.RepoContextQuerier
	repo db.Repository
}

func (q scopedCacheRepoQuerier) GetRepoByOwnerAndLowerName(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return q.repo, nil
}

type scopedCacheTokenResolver struct{ row db.BuildCacheReadToken }

func (s scopedCacheTokenResolver) ResolveReadToken(_ context.Context, _ string) (db.BuildCacheReadToken, error) {
	return s.row, nil
}

func TestBuildCacheReadTokenNamespaceIsEnforcedByRoute(t *testing.T) {
	t.Parallel()
	service := newMockBuildCacheService()
	key := strings.Repeat("a", 64)
	for _, namespace := range []string{"pr-1/", "main/", "pr-2/", "pr-10/"} {
		service.entries[service.key(7, namespace+key)] = buildcache.Publication{Body: `{"result":"hit"}`}
	}
	handler := &BuildCacheHandler{Service: service}
	token := buildcache.ReadTokenPrefix + strings.Repeat("1", 40)
	router := chi.NewRouter()
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(scopedCacheRepoQuerier{repo: db.Repository{ID: 7, Name: "app"}}, scopedCacheTokenResolver{
			row: db.BuildCacheReadToken{RepositoryID: 7, TokenHash: buildcache.TokenHash(token), NamespacePrefix: "pr-1/"},
		}))
		r.Use(middleware.RequireBuildCacheWrite)
		r.Get("/ac/{keyDigest}", handler.ActionCache)
		r.Get("/cas/{digest}", handler.Artifact)
		r.Post("/cas/findMissing", handler.FindMissing)
	})
	for _, tc := range []struct {
		key    string
		status int
	}{
		{"pr-1/" + key, http.StatusOK},
		{"main/" + key, http.StatusForbidden},
		{"pr-2/" + key, http.StatusForbidden},
		{"pr-10/" + key, http.StatusForbidden},
		{key, http.StatusForbidden},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/app/build-cache/ac/"+url.PathEscape(tc.key), nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, tc.status, rec.Code, tc.key+": "+rec.Body.String())
	}
	// A key is decoded exactly once: a double-encoded separator stays literal,
	// so it names a different key than pr-1/<key> and is outside the namespace.
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/app/build-cache/ac/pr-1%252F"+key, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/cas/" + key},
		{http.MethodPost, "/cas/findMissing"},
	} {
		req := httptest.NewRequest(tc.method, "/api/repos/acme/app/build-cache"+tc.path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code, tc.path)
	}
}
