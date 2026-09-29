//go:build integration

package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestBuildCacheAgentAccountPublication(t *testing.T) {
	pool := setupRoutesIntegrationPool(t)
	q := db.New(pool)
	auth := services.NewAuthService(q, config.AuthConfig{}, nil, nil)
	cache := services.NewBuildCacheService(services.NewPgxBuildCacheStore(q, pool), nil, 0)
	handler := &BuildCacheHandler{Service: cache}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(middleware.BuildCacheAccess(q, cache))
		r.Use(middleware.RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", handler.ActionCache)
	})

	for _, accountType := range []string{"user", "bot", "service"} {
		t.Run(accountType, func(t *testing.T) {
			ctx := context.Background()
			owner := routesIntegrationCreateUser(t, pool, "cache_"+accountType)
			_, err := pool.Exec(ctx, "UPDATE users SET user_type=$1 WHERE id=$2", accountType, owner.ID)
			require.NoError(t, err)
			repo := routesIntegrationCreateRepo(t, pool, owner, "cache", false)
			pat, err := auth.CreateToken(ctx, owner.ID, services.CreateTokenRequest{
				Name: "cache publication", Scopes: []string{string(middleware.ScopeWriteRepository)},
			})
			require.NoError(t, err)
			base := fmt.Sprintf("/api/repos/%s/%s/build-cache/ac/", repo.Owner, repo.Name)
			body := func(key string) string {
				return fmt.Sprintf(`{"keyDigest":%q,"result":{"exitOk":true}}`, key)
			}
			serve := func(method, key, payload string) *httptest.ResponseRecorder {
				req := httptest.NewRequest(method, base+key, strings.NewReader(payload))
				req.Header.Set("Authorization", "Bearer "+pat.Token)
				req.Header.Set("Content-Type", "application/json")
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				return rec
			}
			count := func(key string) int {
				var n int
				require.NoError(t, pool.QueryRow(ctx,
					"SELECT count(*) FROM build_cache_entries WHERE repository_id=$1 AND key_digest=$2",
					repo.ID, key).Scan(&n))
				return n
			}
			key := "unreviewed-result"
			rec := serve(http.MethodPut, key, body(key))
			if accountType == "user" {
				require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
				require.Equal(t, 1, count(key))
				require.Equal(t, http.StatusOK, serve(http.MethodGet, key, "").Code)
			} else {
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
				require.Zero(t, count(key))
				require.Equal(t, http.StatusNotFound, serve(http.MethodGet, key, "").Code)
			}
			// An existing valid publication must survive refused deletion.
			existing := "existing-result"
			publication, err := buildcache.ParsePublication(existing, body(existing))
			require.NoError(t, err)
			_, err = cache.PutEntry(ctx, repo.ID, existing, publication)
			require.NoError(t, err)
			require.Equal(t, 1, count(existing))
			if accountType != "user" {
				require.Equal(t, http.StatusForbidden, serve(http.MethodDelete, existing, "").Code)
				require.Equal(t, 1, count(existing))
				require.Equal(t, http.StatusOK, serve(http.MethodGet, existing, "").Code)
			}
			_, err = pool.Exec(ctx, "UPDATE access_tokens SET system_issued=true WHERE id=$1", pat.ID)
			require.NoError(t, err)
			refused := "system-issued-result"
			rec = serve(http.MethodPut, refused, body(refused))
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			require.Zero(t, count(refused))
			require.Equal(t, http.StatusForbidden, serve(http.MethodDelete, existing, "").Code)
			require.Equal(t, 1, count(existing))
			require.Equal(t, http.StatusOK, serve(http.MethodGet, existing, "").Code)
		})
	}
}
