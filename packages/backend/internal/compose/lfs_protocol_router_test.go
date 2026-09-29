package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const routerTestLFSSigningSecret = "router-test-lfs-signing-secret"

type routerLFSProtocolService struct {
	batchCalled   bool
	batchErr      error
	confirmCalled bool
	batchActor    *db.User
	confirmActor  *db.User
	batchClaims   lfsauth.Claims
	confirmClaims lfsauth.Claims
	confirmDelay  time.Duration
	verifyAuth    string
}

func (s *routerLFSProtocolService) Batch(ctx context.Context, actor *db.User, owner, repo string, input services.LFSBatchInput) (services.LFSBatchResponse, error) {
	if authInfo := middleware.AuthInfoFromContext(ctx); authInfo != nil {
		if restricted := authInfo.RepositoryRestriction(); restricted != 0 && restricted != 101 {
			return services.LFSBatchResponse{}, pkgerrors.Forbidden("repository-bound token cannot access resources outside its repository")
		}
	}
	s.batchCalled = true
	s.batchActor = actor
	s.batchClaims, _ = lfsauth.ClaimsFromContext(ctx)
	if s.batchErr != nil {
		return services.LFSBatchResponse{}, s.batchErr
	}
	verify := services.LFSBatchActionLink{Href: "https://plue.example/api/repos/alice/demo/lfs/verify"}
	if claims, ok := lfsauth.ClaimsFromContext(ctx); ok {
		manager, err := lfsauth.NewManager(routerTestLFSSigningSecret)
		if err != nil {
			return services.LFSBatchResponse{}, err
		}
		token, _, err := manager.IssueVerify(lfsauth.VerifyGrant{
			RepositoryID: claims.RepositoryID,
			Owner:        owner,
			Repository:   repo,
			OID:          input.Objects[0].Oid,
			Size:         input.Objects[0].Size,
			Principal:    claims.Principal,
		}, time.Hour)
		if err != nil {
			return services.LFSBatchResponse{}, err
		}
		s.verifyAuth = lfsauth.AuthorizationValue(token)
		verify.Header = map[string]string{"Authorization": s.verifyAuth}
	}
	return services.LFSBatchResponse{
		Transfer: "basic",
		Objects: []services.LFSBatchObjectResponse{{
			Oid:  input.Objects[0].Oid,
			Size: input.Objects[0].Size,
			Actions: map[string]services.LFSBatchActionLink{
				"upload": {Href: "https://storage.example/upload"},
				"verify": verify,
			},
		}},
	}, nil
}

func TestServerRouter_AnonymousLFSBatchLetsServiceHidePrivateRepository(t *testing.T) {
	for _, path := range []string{
		"/api/repos/alice/demo/lfs/objects/batch",
		"/alice/demo.git/info/lfs/objects/batch",
		"/api/repos/alice/demo/lfs/batch",
	} {
		t.Run(path, func(t *testing.T) {
			service := &routerLFSProtocolService{batchErr: pkgerrors.NotFound("repository not found")}
			router := defaultRouter(nil, &routes.LFSHandler{Service: service})
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"operation":"download","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}]}`))
			req.Header.Set("Content-Type", routes.LFSJSONMediaType)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
			assert.True(t, service.batchCalled)
			assert.Nil(t, service.batchActor)
		})
	}
}

func (s *routerLFSProtocolService) ConfirmUpload(ctx context.Context, actor *db.User, _, _ string, input services.LFSConfirmUploadInput) (db.LfsObject, error) {
	if authInfo := middleware.AuthInfoFromContext(ctx); authInfo != nil {
		if restricted := authInfo.RepositoryRestriction(); restricted != 0 && restricted != 101 {
			return db.LfsObject{}, pkgerrors.Forbidden("repository-bound token cannot access resources outside its repository")
		}
	}
	if s.confirmDelay > 0 {
		time.Sleep(s.confirmDelay)
	}
	s.confirmCalled = true
	s.confirmActor = actor
	s.confirmClaims, _ = lfsauth.ClaimsFromContext(ctx)
	return db.LfsObject{ID: 7, Oid: input.Oid, Size: input.Size}, nil
}

func TestServerRouter_GitLFSVerifyIsOutsideShortAPITimeout(t *testing.T) {
	oldTimeout := apiJSONTimeout
	apiJSONTimeout = 10 * time.Millisecond
	t.Cleanup(func() { apiJSONTimeout = oldTimeout })

	service := &routerLFSProtocolService{confirmDelay: 50 * time.Millisecond}
	router := defaultRouter(nil, &routes.LFSHandler{Service: service})
	body := `{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", strings.NewReader(body))
	req.Header.Set("Content-Type", routes.LFSJSONMediaType)
	req = withRouterTokenAuth(req, middleware.ScopeWriteRepository)
	req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.True(t, service.confirmCalled)
}

func (*routerLFSProtocolService) DeleteObject(context.Context, *db.User, string, string, string) error {
	return nil
}

func (*routerLFSProtocolService) ListObjects(context.Context, *db.User, string, string, int, int) ([]db.LfsObject, int64, error) {
	return nil, 0, nil
}

func TestServerRouter_GitLFSVendorJSONProtocol(t *testing.T) {
	service := &routerLFSProtocolService{}
	router := defaultRouter(nil, &routes.LFSHandler{Service: service})

	t.Run("batch accepts vendor json with charset", func(t *testing.T) {
		body := `{"operation":"upload","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/objects/batch", strings.NewReader(body))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType+"; charset=utf-8")
		req.Header.Set("Accept", routes.LFSJSONMediaType)
		req = withRouterTokenAuth(req, middleware.ScopeReadRepository, middleware.ScopeWriteRepository)
		req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.True(t, service.batchCalled)
		assert.Equal(t, routes.LFSJSONMediaType, rec.Header().Get("Content-Type"))
		assert.Contains(t, rec.Body.String(), `"verify"`)
		// authenticated is intentionally omitted. Per the git-lfs client,
		// false/omitted makes verify use its normal credential-helper path for
		// the configured callback origin instead of requiring echoed secrets.
		assert.NotContains(t, rec.Body.String(), `"authenticated":true`)
	})

	t.Run("ssh deploy key scoped credential completes discovered batch and verify", func(t *testing.T) {
		manager, err := lfsauth.NewManager(routerTestLFSSigningSecret)
		require.NoError(t, err)
		token, claims, err := manager.Issue(lfsauth.Grant{
			RepositoryID: 101,
			Owner:        "alice",
			Repository:   "demo",
			Operation:    lfsauth.OperationUpload,
			Principal:    lfsauth.PrincipalDeployKey,
		}, time.Minute)
		require.NoError(t, err)
		authorization := lfsauth.AuthorizationValue(token)

		body := `{"operation":"upload","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/info/lfs/objects/batch", strings.NewReader(body))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType)
		req.Header.Set("Authorization", authorization)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Nil(t, service.batchActor, "deploy-key grants intentionally have no db.User")
		assert.Equal(t, claims.RepositoryID, service.batchClaims.RepositoryID)
		assert.Equal(t, lfsauth.PrincipalDeployKey, service.batchClaims.Principal)
		assert.NotContains(t, rec.Body.String(), authorization, "Batch must not extend the broad repository credential")
		assert.Contains(t, rec.Body.String(), service.verifyAuth)
		verifyToken := strings.TrimPrefix(service.verifyAuth, lfsauth.AuthorizationScheme+" ")
		verifyClaims, err := manager.Verify(verifyToken)
		require.NoError(t, err)
		assert.Equal(t, lfsauth.PurposeVerify, verifyClaims.Purpose)
		assert.Equal(t, strings.Repeat("a", 64), verifyClaims.OID)
		assert.Equal(t, int64(3), verifyClaims.Size)

		verifyBody := `{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}`
		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", strings.NewReader(verifyBody))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType)
		req.Header.Set("Authorization", service.verifyAuth)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Nil(t, service.confirmActor)
		assert.Equal(t, claims.RepositoryID, service.confirmClaims.RepositoryID)
		assert.Equal(t, lfsauth.PurposeVerify, service.confirmClaims.Purpose)

		req = httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/objects/batch", strings.NewReader(body))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType)
		req.Header.Set("Authorization", service.verifyAuth)
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "verify-only credentials must fail closed on Batch")
	})

	t.Run("scoped credential fails closed for wrong repo operation and missing auth", func(t *testing.T) {
		manager, err := lfsauth.NewManager(routerTestLFSSigningSecret)
		require.NoError(t, err)
		issue := func(owner string, operation lfsauth.Operation) string {
			token, _, issueErr := manager.Issue(lfsauth.Grant{
				RepositoryID: 101,
				Owner:        owner,
				Repository:   "demo",
				Operation:    operation,
				Principal:    lfsauth.PrincipalDeployKey,
			}, time.Minute)
			require.NoError(t, issueErr)
			return lfsauth.AuthorizationValue(token)
		}
		body := `{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}`

		for name, authorization := range map[string]string{
			"wrong repo":      issue("bob", lfsauth.OperationUpload),
			"wrong operation": issue("alice", lfsauth.OperationDownload),
			"missing":         "",
		} {
			t.Run(name, func(t *testing.T) {
				req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", strings.NewReader(body))
				req.Header.Set("Content-Type", routes.LFSJSONMediaType)
				if authorization != "" {
					req.Header.Set("Authorization", authorization)
				}
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				if authorization == "" {
					assert.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
				} else {
					assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
				}
			})
		}
	})

	t.Run("http git remote discovers standard batch endpoint", func(t *testing.T) {
		body := `{"operation":"upload","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/info/lfs/objects/batch", strings.NewReader(body))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType+"; charset=utf-8")
		req.Header.Set("Accept", routes.LFSJSONMediaType)
		req = withRouterTokenAuth(req, middleware.ScopeReadRepository, middleware.ScopeWriteRepository)
		req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, routes.LFSJSONMediaType, rec.Header().Get("Content-Type"))
		assert.Equal(t, "5000", rec.Header().Get("X-RateLimit-Limit"),
			"the Git-discovered LFS route must share the global authenticated API limiter")
		assert.Contains(t, rec.Body.String(), `"verify"`)
	})

	t.Run("api batch allows anonymous public download", func(t *testing.T) {
		body := `{"operation":"download","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/objects/batch", strings.NewReader(body))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType)
		req = withRouterRepoContext(req, 101, middleware.PermissionRead)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, routes.LFSJSONMediaType, rec.Header().Get("Content-Type"))
	})

	t.Run("verify accepts vendor json and returns protocol 200", func(t *testing.T) {
		body := `{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/lfs/verify", strings.NewReader(body))
		req.Header.Set("Content-Type", routes.LFSJSONMediaType+"; charset=utf-8")
		req.Header.Set("Accept", routes.LFSJSONMediaType)
		req = withRouterTokenAuth(req, middleware.ScopeWriteRepository)
		req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.True(t, service.confirmCalled)
		assert.Equal(t, routes.LFSJSONMediaType, rec.Header().Get("Content-Type"))
		assert.Empty(t, rec.Body.String())
	})
}

func TestServerRouter_LFSCanonicalAndGitDiscoveryPreserveRepositoryRestriction(t *testing.T) {
	for _, tc := range []struct {
		name string
		path string
		body string
	}{
		{name: "canonical batch", path: "/api/repos/alice/demo/lfs/objects/batch", body: `{"operation":"upload","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}]}`},
		{name: "git discovery batch", path: "/alice/demo.git/info/lfs/objects/batch", body: `{"operation":"upload","objects":[{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}]}`},
		{name: "canonical verify", path: "/api/repos/alice/demo/lfs/verify", body: `{"oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &routerLFSProtocolService{}
			router := defaultRouter(nil, &routes.LFSHandler{Service: service})
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", routes.LFSJSONMediaType)
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
				User:        &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
				IsTokenAuth: true,
				RawScopes:   string(middleware.ScopeWriteRepository) + "," + middleware.RepositoryRestrictionScope(202),
				Scopes:      middleware.ParseTokenScopes(string(middleware.ScopeWriteRepository)),
			}))
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			assert.False(t, service.batchCalled)
			assert.False(t, service.confirmCalled)
		})
	}
}
