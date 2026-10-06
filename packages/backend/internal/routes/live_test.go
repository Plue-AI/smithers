package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The upgrade's refusals before any topic: each answers the error envelope
// and never upgrades.
func TestLiveRefusesBeforeUpgrading(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	handler := &LiveHandler{Hub: live.NewHub(ctx, nil), Queries: &db.Queries{}, Origins: func() []string { return []string{"http://install.test:4000"} },
		Topics: func(*http.Request) (live.Resolver, int64) {
			t.Fatal("refused upgrades resolve no topic")
			return nil, 0
		}}
	session := &middleware.AuthInfo{User: &db.User{ID: 2}, SessionHash: "session"}
	for _, tc := range []struct {
		name    string
		handler *LiveHandler
		host    string
		origin  string
		auth    *middleware.AuthInfo
		status  int
		code    string
	}{
		{"no live provider", &LiveHandler{}, "install.test:4000", "http://install.test:4000", session, 503, "live_unavailable"},
		{"unknown host", handler, "elsewhere.test:4000", "http://elsewhere.test:4000", session, 421, "unknown_origin"},
		{"signed out", handler, "install.test:4000", "http://install.test:4000", nil, 401, "unauthenticated"},
		{"a token", handler, "install.test:4000", "http://install.test:4000", &middleware.AuthInfo{User: &db.User{ID: 2}, IsTokenAuth: true, TokenHash: "t"}, 401, "unauthenticated"},
		{"another origin", handler, "install.test:4000", "http://evil.test", session, 403, "origin"},
		{"no origin", handler, "install.test:4000", "", session, 403, "origin"},
		{"no revocation provider", handler, "install.test:4000", "http://install.test:4000", session, 503, "live_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/api/live", nil)
			request.Host = tc.host
			request.RemoteAddr = "192.0.2.1:5000"
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			request.Header.Set("Sec-WebSocket-Protocol", live.Protocol)
			if tc.auth != nil {
				request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), tc.auth))
			}
			response := httptest.NewRecorder()
			tc.handler.ServeHTTP(response, request)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			var envelope struct{ Code string }
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &envelope))
			require.Equal(t, tc.code, envelope.Code)
		})
	}
}

// Projection/error branches use the already-authorized request context. The
// production router/real roster boundary is exercised by the packaged-host test.
func TestStackSnapshotRefusalsAndProjection(t *testing.T) {
	auth := &middleware.AuthInfo{User: &db.User{ID: 2}}
	request := httptest.NewRequest("GET", "/api/stack", nil)
	ctx := middleware.ContextWithAuthInfo(request.Context(), auth)
	ctx = services.WithInstallAuthorization(ctx, "todo.read", services.InstallAuthorization{UserID: 2})
	request = request.WithContext(ctx)
	valid := json.RawMessage(`{"repository":"owner/repo","items":[]}`)
	for _, tc := range []struct {
		name       string
		repository int64
		resolve    live.Resolver
		status     int
	}{
		{"not bound", 0, nil, 503},
		{"missing resolver", 1, nil, 503},
		{"unsupported topic", 1, func(context.Context, string) (live.Source, string) { return live.Source{}, live.Unsupported }, 503},
		{"missing builder", 1, func(context.Context, string) (live.Source, string) { return live.Source{}, "" }, 503},
		{"read failure", 1, func(context.Context, string) (live.Source, string) {
			return live.Source{Build: func(context.Context) (json.RawMessage, error) { return nil, errors.New("private database error") }}, ""
		}, 503},
		{"snapshot", 1, func(_ context.Context, topic string) (live.Source, string) {
			require.Equal(t, "home", topic)
			return live.Source{Build: func(ctx context.Context) (json.RawMessage, error) {
				require.Same(t, auth, middleware.AuthInfoFromContext(ctx))
				return valid, nil
			}}, ""
		}, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := &LiveHandler{Queries: &db.Queries{}, Topics: func(*http.Request) (live.Resolver, int64) { return tc.resolve, tc.repository }}
			response := httptest.NewRecorder()
			handler.Stack(response, request)
			require.Equal(t, tc.status, response.Code)
			require.Equal(t, "application/json", response.Header().Get("Content-Type"))
			if tc.status == 200 {
				require.JSONEq(t, string(valid), response.Body.String())
				require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			} else {
				require.Contains(t, response.Body.String(), `"code":"stack_unavailable"`)
				require.NotContains(t, response.Body.String(), "private database error")
			}
		})
	}
	for _, h := range []*LiveHandler{nil, {}, {Queries: &db.Queries{}}} {
		response := httptest.NewRecorder()
		h.Stack(response, request)
		require.Equal(t, 503, response.Code)
	}
	response := httptest.NewRecorder()
	(&LiveHandler{Queries: &db.Queries{}, Topics: func(*http.Request) (live.Resolver, int64) {
		t.Fatal("unauthenticated requests resolve nothing")
		return nil, 0
	}}).Stack(response, httptest.NewRequest("GET", "/api/stack", nil))
	require.Equal(t, 401, response.Code)
}
