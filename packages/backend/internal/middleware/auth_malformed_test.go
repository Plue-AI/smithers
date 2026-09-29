package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestAuthLoader_MalformedHeaderBoundary(t *testing.T) {
	for _, authorization := range []string{
		"Bearer jjhub_" + strings.Repeat("a", 40),
		"token jjhub_" + strings.Repeat("a", 40),
		"Bearer smithers_flowhost_" + strings.Repeat("a", 40),
		"token smithers_flowhost_" + strings.Repeat("a", 40),
		"Bearer smithers_short",
		"Bearer smithers_cachero_" + strings.Repeat("a", 40),
		"Bearer worker-secret",
		"LFS signed-grant",
		"Basic dXNlcjpwYXNz",
		"Bearer",
		"Digest credential",
		"",
	} {
		for _, path := range []string{"/api/public", "/api/repos/alice/private", "/api/user"} {
			t.Run(authorization+path, func(t *testing.T) {
				q := &mockAuthLoaderQuerier{}
				handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					t.Fatal("malformed credential reached the route")
				}))
				req := httptest.NewRequest(http.MethodGet, path, nil)
				req.Header.Set("Authorization", authorization)
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "old-session"})
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)

				require.Equal(t, http.StatusUnauthorized, rec.Code)
				require.Equal(t, `Bearer error="invalid_token"`, rec.Header().Get("WWW-Authenticate"))
				require.Equal(t, "invalid_token", apiErrorCode(t, rec))
				require.Zero(t, q.getAuthInfoByTokenHashHit)
				require.Zero(t, q.getAuthSessionBySessionKeyHit)
			})
		}
	}
}

func TestAuthLoader_AbsentHeaderPreservesAnonymousBehavior(t *testing.T) {
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/api/public", http.StatusOK},
		{"/api/repos/alice/private", http.StatusNotFound},
		{"/api/user", http.StatusUnauthorized},
	} {
		t.Run(tc.path, func(t *testing.T) {
			q := &mockAuthLoaderQuerier{}
			handler := AuthLoader(q, config.AuthConfig{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Nil(t, UserFromContext(r.Context()))
				w.WriteHeader(tc.status)
			}))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			require.Equal(t, tc.status, rec.Code)
			require.Empty(t, rec.Header().Get("WWW-Authenticate"))
			require.Zero(t, q.getAuthInfoByTokenHashHit)
		})
	}
}

func TestAuthLoader_DelegatesOtherCredentialGates(t *testing.T) {
	for _, tc := range []struct {
		path   string
		header string
	}{
		{"/alice/demo.git/info/lfs/objects/batch", "LFS signed-grant"},
		{"/api/repos/alice/demo/lfs/verify", "LFS signed-grant"},
		{"/api/auth/github/token-exchange", "Bearer worker-secret"},
		{"/api/telemetry/errors", "Bearer worker-secret"},
		{"/api/oauth2/token", "Basic Y2xpZW50OnNtaXRoZXJzX29hc19zZWNyZXQ="},
		{"/api/oauth2/revoke", "Basic Y2xpZW50OnNtaXRoZXJzX29hc19zZWNyZXQ="},
		{"/api/repos/alice/demo/build-cache/ac/key", "Bearer smithers_cachero_" + strings.Repeat("a", 40)},
	} {
		t.Run(tc.path, func(t *testing.T) {
			q := &mockAuthLoaderQuerier{}
			handler := AuthLoader(q, config.AuthConfig{WorkerExchangeToken: "worker-secret"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Nil(t, UserFromContext(r.Context()))
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodPost, tc.path, nil)
			req.Header.Set("Authorization", tc.header)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			require.Equal(t, http.StatusNoContent, rec.Code)
			require.Zero(t, q.getAuthInfoByTokenHashHit)
		})
	}
}

func TestAuthLoader_WorkerRoutesRejectUnrecognizedBearer(t *testing.T) {
	for _, path := range []string{"/api/auth/github/token-exchange", "/api/telemetry/errors"} {
		t.Run(path, func(t *testing.T) {
			q := &mockAuthLoaderQuerier{}
			handler := AuthLoader(q, config.AuthConfig{WorkerExchangeToken: "worker-secret"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("unrecognized bearer reached the route")
			}))
			req := httptest.NewRequest(http.MethodPost, path, nil)
			req.Header.Set("Authorization", "Bearer jjhub_"+strings.Repeat("a", 40))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			require.Equal(t, "invalid_token", apiErrorCode(t, rec))
		})
	}
}
