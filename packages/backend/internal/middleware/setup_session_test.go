package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestSetupSessionBoundary(t *testing.T) {
	for _, path := range []string{"/api/todos", "/api/todos/1/merge", "/api/members", "/api/approvals", "/api/auth/github/token-exchange", "/api/install", "/api/install/setup/repository", "/api/github-app/setup", "/api/auth/github", "/api/auth/github/callback"} {
		t.Run(path, func(t *testing.T) {
			called := false
			handler := SetupSessionBoundary(func(context.Context, string) error { return nil })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(204) }))
			req := httptest.NewRequest("GET", path, nil)
			req.AddCookie(&http.Cookie{Name: "smithers_setup_session", Value: "live"})
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			allowed := path == "/api/install" || path == "/api/install/setup/repository" || path == "/api/github-app/setup" || path == "/api/auth/github" || path == "/api/auth/github/callback"
			require.Equal(t, allowed, called)
			if allowed {
				require.Equal(t, 204, rec.Code)
			} else {
				require.Equal(t, 403, rec.Code)
				require.JSONEq(t, `{"code":"permission","class":"permission","message":"setup only"}`, rec.Body.String())
			}
		})
	}
	for _, code := range []pkgerrors.Code{pkgerrors.CodeSetupClosed, pkgerrors.CodeUnauthenticated} {
		handler := SetupSessionBoundary(func(context.Context, string) error { return pkgerrors.New(code, string(code)) })(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("invalid setup reached route") }))
		req := httptest.NewRequest("GET", "/api/install", nil)
		req.AddCookie(&http.Cookie{Name: "smithers_setup_session", Value: "dead"})
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, 401, rec.Code)
		require.Contains(t, rec.Body.String(), `"class":"permission"`)
	}
}

// The app reads /api/auth/session on an install and /api/user elsewhere. A
// 403 on either left the setup card's Sign in reporting "unavailable" and
// never reaching /api/auth/github (real install run 6, 2026-10-09).
func TestSetupIdentityIsSignedOut(t *testing.T) {
	for _, path := range []string{"/api/user", "/api/auth/session"} {
		t.Run(path, func(t *testing.T) {
			handler := SetupSessionBoundary(func(context.Context, string) error { return nil })(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("setup reached person identity") }))
			req := httptest.NewRequest("GET", path, nil)
			req.AddCookie(&http.Cookie{Name: "smithers_setup_session", Value: "live"})
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			require.Equal(t, 401, rec.Code)
			require.Contains(t, rec.Body.String(), `"code":"unauthenticated"`)
			require.Contains(t, rec.Body.String(), `"class":"permission"`)
		})
	}
	post := httptest.NewRequest("POST", "/api/auth/session", nil)
	post.AddCookie(&http.Cookie{Name: "smithers_setup_session", Value: "live"})
	rec := httptest.NewRecorder()
	SetupSessionBoundary(func(context.Context, string) error { return nil })(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("setup reached a session write") })).ServeHTTP(rec, post)
	require.Equal(t, 403, rec.Code)
}
