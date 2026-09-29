package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type stubReadTokenResolver struct {
	rows map[string]db.BuildCacheReadToken
	err  error
}

func (s *stubReadTokenResolver) ResolveReadToken(_ context.Context, token string) (db.BuildCacheReadToken, error) {
	if s.err != nil {
		return db.BuildCacheReadToken{}, s.err
	}
	row, ok := s.rows[buildcache.TokenHash(token)]
	if !ok {
		return db.BuildCacheReadToken{}, pgx.ErrNoRows
	}
	return row, nil
}

func buildCacheTestRouter(t *testing.T, queries RepoContextQuerier, tokens BuildCacheReadTokenResolver) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	r.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
		r.Use(BuildCacheAccess(queries, tokens))
		r.Use(RequireBuildCacheWrite)
		r.HandleFunc("/ac/{keyDigest}", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Credential", string(BuildCacheCredentialFromContext(r.Context())))
			w.WriteHeader(http.StatusOK)
		})
	})
	return r
}

func repoQuerier(repos map[string]db.Repository, collaborators map[int64]string) *mockRepoContextQuerier {
	return &mockRepoContextQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo, ok := repos[arg.Owner+"/"+arg.LowerName]
			if !ok {
				return db.Repository{}, pgx.ErrNoRows
			}
			return repo, nil
		},
		getCollaboratorPermissionForRepoUserFn: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return collaborators[arg.UserID.Int64], nil
		},
	}
}

func TestBuildCacheAccess_PublicReadToken(t *testing.T) {
	t.Parallel()
	public := db.Repository{ID: 5, Name: "app", IsPublic: false}
	other := db.Repository{ID: 6, Name: "other", IsPublic: false}
	queries := repoQuerier(map[string]db.Repository{"acme/app": public, "acme/other": other}, nil)
	token := buildcache.ReadTokenPrefix + strings.Repeat("1", 40)
	resolver := &stubReadTokenResolver{rows: map[string]db.BuildCacheReadToken{
		buildcache.TokenHash(token): {ID: 1, RepositoryID: 5, TokenHash: buildcache.TokenHash(token)},
	}}
	router := buildCacheTestRouter(t, queries, resolver)

	get := func(path, bearer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	rec := get("/api/repos/acme/app/build-cache/ac/k", token)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "read", rec.Header().Get("X-Credential"))

	rec = get("/api/repos/acme/other/build-cache/ac/k", token)
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "a token reads exactly one repository")
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "smithers-build-cache")

	rec = get("/api/repos/acme/app/build-cache/ac/k", buildcache.ReadTokenPrefix+strings.Repeat("2", 40))
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "an unknown or revoked token is refused")

	rec = get("/api/repos/acme/app/build-cache/ac/k", "")
	assert.Equal(t, http.StatusNotFound, rec.Code, "a private repository stays hidden from anonymous callers")

	resolver.err = errors.New("db down")
	rec = get("/api/repos/acme/app/build-cache/ac/k", token)
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code, "a tier failure while resolving the token is a 503 the client retries")
	assert.Contains(t, rec.Body.String(), `"code":"service_unavailable"`)
	resolver.err = nil

	put := httptest.NewRequest(http.MethodPut, "/api/repos/acme/app/build-cache/ac/k", strings.NewReader(`{}`))
	put.Header.Set("Authorization", "Bearer "+token)
	put.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, put)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a read token may never publish")
	assert.Contains(t, rec.Body.String(), `"code":"forbidden"`)
}

func TestBuildCacheAccess_OrdinaryCredentials(t *testing.T) {
	t.Parallel()
	repo := db.Repository{ID: 5, Name: "app", IsPublic: true, UserID: pgtype.Int8{Int64: 100, Valid: true}}
	queries := repoQuerier(map[string]db.Repository{"acme/app": repo}, map[int64]string{7: "write", 8: "read"})
	router := buildCacheTestRouter(t, queries, &stubReadTokenResolver{})

	serve := func(method string, info *AuthInfo) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/repos/acme/app/build-cache/ac/k", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if info != nil {
			req = req.WithContext(ContextWithAuthInfo(req.Context(), info))
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	tokenInfo := func(userID int64, scopes string) *AuthInfo {
		return &AuthInfo{User: &db.User{ID: userID}, IsTokenAuth: true, RawScopes: scopes, Scopes: ParseTokenScopes(scopes)}
	}

	rec := serve(http.MethodGet, nil)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "read", rec.Header().Get("X-Credential"), "anonymous reads a public repository")
	rec = serve(http.MethodPut, nil)
	assert.Equal(t, http.StatusForbidden, rec.Code, "anonymous never publishes")

	rec = serve(http.MethodPut, tokenInfo(100, "write:repository"))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "write", rec.Header().Get("X-Credential"), "the owner with write:repository publishes")

	rec = serve(http.MethodPut, tokenInfo(100, "read:repository"))
	assert.Equal(t, http.StatusForbidden, rec.Code, "a read-scoped token cannot publish even as owner")

	rec = serve(http.MethodPut, tokenInfo(7, "write:repository,repo:5"))
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "write", rec.Header().Get("X-Credential"), "a collaborator's own token bound to this repository publishes")

	runInfo := tokenInfo(100, "write:repository,repo:5,agent-session:s1")
	runInfo.TokenSystemIssued = true
	rec = serve(http.MethodGet, runInfo)
	assert.Equal(t, "read", rec.Header().Get("X-Credential"), "a run credential reads")
	rec = serve(http.MethodPut, runInfo)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a run credential never publishes, even the owner's")
	rec = serve(http.MethodDelete, runInfo)
	assert.Equal(t, http.StatusForbidden, rec.Code, "a run credential never deletes")

	for _, userType := range []string{"bot", "service"} {
		for _, tokenAuth := range []bool{true, false} {
			info := tokenInfo(100, "write:repository")
			info.User.UserType = userType
			info.IsTokenAuth = tokenAuth
			rec = serve(http.MethodGet, info)
			assert.Equal(t, http.StatusOK, rec.Code, "%s token=%t reads", userType, tokenAuth)
			assert.Equal(t, "read", rec.Header().Get("X-Credential"))
			for _, method := range []string{http.MethodPut, http.MethodDelete} {
				rec = serve(method, info)
				assert.Equal(t, http.StatusForbidden, rec.Code, "%s token=%t %s", userType, tokenAuth, method)
			}
		}
	}

	rec = serve(http.MethodPut, tokenInfo(7, "write:repository,repo:999"))
	assert.Equal(t, http.StatusForbidden, rec.Code, "a token bound to another repository is not a write credential here")

	rec = serve(http.MethodGet, tokenInfo(8, "write:repository"))
	assert.Equal(t, "read", rec.Header().Get("X-Credential"), "a collaborator with read permission reads only")
	rec = serve(http.MethodPut, tokenInfo(8, "write:repository"))
	assert.Equal(t, http.StatusForbidden, rec.Code)

	rec = serve(http.MethodPut, &AuthInfo{User: &db.User{ID: 100}, IsTokenAuth: false, Scopes: ScopeSet{}})
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "write", rec.Header().Get("X-Credential"), "a session of the owner publishes")
}

func TestBuildCacheAccess_PrivateRepositoryNeedsPermission(t *testing.T) {
	t.Parallel()
	repo := db.Repository{ID: 5, Name: "app", IsPublic: false}
	queries := repoQuerier(map[string]db.Repository{"acme/app": repo}, map[int64]string{7: "read"})
	router := buildCacheTestRouter(t, queries, &stubReadTokenResolver{})
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/app/build-cache/ac/k", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 9}, IsTokenAuth: false, Scopes: ScopeSet{}}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusNotFound, rec.Code, "no permission on a private repository reads as not found")

	req = httptest.NewRequest(http.MethodGet, "/api/repos/acme/app/build-cache/ac/k", nil)
	req = req.WithContext(ContextWithAuthInfo(req.Context(), &AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: false, Scopes: ScopeSet{}}))
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "read", rec.Header().Get("X-Credential"))
}

// The access middleware answers before any route runs, so its refusals were
// the ones most likely to reach a client with no machine-readable verdict at
// all: the 401 carried an empty body, and the 403/503 carried the legacy
// `{"error": "..."}` key. All three now answer the registry envelope, with
// `code` and `fault` inside the 240 bytes the Cloudflare Worker reads.
func TestBuildCacheAccess_RefusalsCarryTheTypedEnvelope(t *testing.T) {
	t.Parallel()
	const workerReadCeiling = 240
	repo := db.Repository{ID: 5, Name: "app", IsPublic: false}
	queries := repoQuerier(map[string]db.Repository{"acme/app": repo}, nil)
	token := buildcache.ReadTokenPrefix + strings.Repeat("1", 40)
	resolver := &stubReadTokenResolver{rows: map[string]db.BuildCacheReadToken{
		buildcache.TokenHash(token): {ID: 1, RepositoryID: 5, TokenHash: buildcache.TokenHash(token)},
	}}
	router := buildCacheTestRouter(t, queries, resolver)

	typed := func(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode apierrors.Code) {
		t.Helper()
		body := rec.Body.String()
		require.Equal(t, wantStatus, rec.Code, body)
		assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
		var decoded apierrors.APIError
		require.NoError(t, json.Unmarshal([]byte(body), &decoded), body)
		var legacy map[string]json.RawMessage
		require.NoError(t, json.Unmarshal([]byte(body), &legacy))
		assert.NotContains(t, legacy, "error", "the legacy build cache envelope must be gone")
		entry, registered := apierrors.Lookup(decoded.Code)
		require.True(t, registered, "code %q is not in the registry", decoded.Code)
		assert.Equal(t, wantCode, decoded.Code, body)
		assert.Equal(t, entry.Fault, decoded.Fault)
		assert.NotEmpty(t, decoded.Message)
		head := body
		if len(head) > workerReadCeiling {
			head = head[:workerReadCeiling]
		}
		assert.Contains(t, head, `"code":"`+string(decoded.Code)+`"`)
		assert.Contains(t, head, `"fault":"`+string(decoded.Fault)+`"`)
	}

	get := func(bearer string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/app/build-cache/ac/k", nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	rec := get(buildcache.ReadTokenPrefix + strings.Repeat("2", 40))
	typed(t, rec, http.StatusUnauthorized, apierrors.CodeUnauthorized)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "smithers-build-cache",
		"the challenge header survives the envelope change")

	resolver.err = errors.New("db down")
	typed(t, get(token), http.StatusServiceUnavailable, apierrors.CodeServiceUnavailable)
	resolver.err = nil

	put := httptest.NewRequest(http.MethodPut, "/api/repos/acme/app/build-cache/ac/k", strings.NewReader(`{}`))
	put.Header.Set("Authorization", "Bearer "+token)
	put.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, put)
	typed(t, rec, http.StatusForbidden, apierrors.CodeForbidden)
}
