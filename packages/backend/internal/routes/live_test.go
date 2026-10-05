package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
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
		{"another origin", handler, "install.test:4000", "http://evil.test", session, 403, "forbidden"},
		{"no origin", handler, "install.test:4000", "", session, 403, "forbidden"},
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
