package middleware

import (
	"context"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEffectiveOriginSocketPeerAndKnownScheme(t *testing.T) {
	// Fixed host/scheme fixtures from spec §16.3.3 and C-GH-01.
	for _, tc := range []struct{ name, host, peer, forwarded, proto, origin, want string }{
		{"local", "localhost:4000", "127.0.0.1:12", "", "https", "", "http://localhost:4000"},
		{"remote localhost rejected", "localhost:4000", "192.0.2.1:12", "", "", "", ""},
		{"LAN", "lan-a:4000", "192.0.2.1:12", "", "https", "", "http://lan-a:4000"},
		{"TLS proxy without proto", "backend.internal", "127.0.0.1:12", "box.example", "", "", "https://box.example"},
		{"remote cannot forward", "backend.internal", "192.0.2.1:12", "box.example", "https", "", ""},
		{"forwarded for ignored", "backend.internal", "192.0.2.1:12", "box.example", "https", "", ""},
		{"foreign origin", "box.example", "127.0.0.1:12", "", "", "https://evil.example", "https://box.example"},
		{"wrong port", "lan-a:4001", "127.0.0.1:12", "", "", "", ""},
		{"malformed forwarded host", "backend.internal", "127.0.0.1:12", "box.example/path", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://"+tc.host+"/", nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("X-Forwarded-Host", tc.forwarded)
			r.Header.Set("X-Forwarded-Proto", tc.proto)
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			r.Header.Set("Origin", tc.origin)
			origin, ok := ResolveEffectiveOrigin(r, []string{"http://lan-a:4000", "https://box.example"})
			require.Equal(t, tc.want != "", ok)
			require.Equal(t, tc.want, origin)
		})
	}
	r := httptest.NewRequest("GET", "http://box.example/", nil)
	_, ok := ResolveEffectiveOrigin(r, []string{"http://box.example", "https://box.example"})
	require.False(t, ok, "ambiguous scheme fails closed")
}

func TestEffectiveOriginAfterRealIP(t *testing.T) {
	// §16.3.3: forwarding trust belongs to the socket peer, not the client IP.
	for _, tc := range []struct{ peer, xff, want string }{
		{"192.0.2.1:12", "127.0.0.1, 192.0.2.9", ""},
		{"127.0.0.1:12", "192.0.2.1, 192.0.2.9", "https://box.example"},
	} {
		r := httptest.NewRequest("GET", "http://backend.internal/setup", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("X-Forwarded-For", tc.xff)
		r.Header.Set("X-Forwarded-Host", "box.example")
		RealIP(1)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin, ok := ResolveEffectiveOrigin(r, []string{"https://box.example"})
			require.Equal(t, tc.want, origin)
			require.Equal(t, tc.want != "", ok)
		})).ServeHTTP(httptest.NewRecorder(), r)
	}
}

// T-INS-04 / §16.3.3: literal origins and envelopes, never helper-derived oracles.
func TestInstallOriginGuard(t *testing.T) {
	for _, tc := range []struct {
		name, peer, host, origin, path string
		status                         int
		code                           string
	}{
		{"LAN", "192.0.2.1:9", "lan-a:4000", "http://lan-a:4000", "/api/install", 204, ""},
		{"different origin", "192.0.2.1:9", "lan-a:4000", "https://box.example", "/api/install", 403, "origin"},
		{"unknown", "192.0.2.1:9", "evil.example", "", "/api/install", 421, "unknown_origin"},
		{"remote loopback", "192.0.2.1:9", "localhost:4000", "", "/api/install", 421, "unknown_origin"},
		{"local readiness", "127.0.0.1:9", "unknown", "", "/readyz", 204, ""},
		{"remote readiness", "192.0.2.1:9", "unknown", "", "/readyz", 421, "unknown_origin"},
		{"ipv4", "127.0.0.1:9", "127.0.0.1:4000", "", "/api/install", 204, ""},
		{"ipv6", "[::1]:9", "[::1]:4000", "", "/api/install", 204, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://"+tc.host+tc.path, nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			InstallEffectiveOrigin(func(context.Context) ([]string, error) {
				return []string{"http://lan-a:4000", "https://box.example"}, nil
			})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(w, r)
			require.Equal(t, tc.status, w.Code)
			if tc.code != "" {
				var body map[string]any
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
				require.Equal(t, tc.code, body["code"])
			}
		})
	}
}
func TestInstallOriginSnapshotAndCookieScheme(t *testing.T) {
	origins := []string{"https://box.example"}
	guard := InstallEffectiveOrigin(func(context.Context) ([]string, error) { return origins, nil })
	request := func() int {
		r := httptest.NewRequest("GET", "http://box.example/api/install", nil)
		r.RemoteAddr = "127.0.0.1:9"
		r.Header.Set("X-Forwarded-Proto", "http")
		w := httptest.NewRecorder()
		guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Changing the provider mid-request cannot change the chosen scheme.
			origins = []string{"http://box.example"}
			require.Equal(t, "https://box.example", EffectiveOrigin(r.Context()))
			require.True(t, CookieSecure(r, false))
			require.Equal(t, "https://box.example", EffectiveOrigin(r.Context()))
			w.WriteHeader(204)
		})).ServeHTTP(w, r)
		return w.Code
	}
	require.Equal(t, 204, request())
	origins = nil
	require.Equal(t, 421, request())
}

func TestInstallMutationAndUpgradeOrigin(t *testing.T) {
	for _, tc := range []struct {
		name, origin, token string
		bearer, upgrade     bool
		status              int
		code                string
	}{
		{"mutation accepted", "http://lan-a:4000", "csrf", false, false, 204, ""},
		{"mutation missing Origin", "", "csrf", false, false, 403, "origin"},
		{"mutation missing CSRF", "http://lan-a:4000", "", false, false, 403, "csrf"},
		{"mutation wrong CSRF", "http://lan-a:4000", "wrong", false, false, 403, "csrf"},
		{"bearer", "", "", true, false, 204, ""},
		{"upgrade missing Origin", "", "", false, true, 403, "origin"},
		{"upgrade accepted", "http://lan-a:4000", "", false, true, 204, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			method := "POST"
			if tc.upgrade {
				method = "GET"
			}
			r := httptest.NewRequest(method, "http://lan-a:4000/api/live", nil)
			r.RemoteAddr = "192.0.2.1:9"
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-CSRF-Token", tc.token)
			r.AddCookie(&http.Cookie{Name: CSRFCookieName, Value: "csrf"})
			r = r.WithContext(ContextWithAuthInfo(r.Context(), &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: tc.bearer}))
			w := httptest.NewRecorder()
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
			guarded := CSRF(next)
			if tc.upgrade {
				guarded = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if CheckInstallCookieOrigin(w, r) {
						next.ServeHTTP(w, r)
					}
				})
			}
			InstallEffectiveOrigin(func(context.Context) ([]string, error) { return []string{"http://lan-a:4000"}, nil })(guarded).ServeHTTP(w, r)
			require.Equal(t, tc.status, w.Code)
			if tc.code != "" {
				var b map[string]any
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &b))
				require.Equal(t, tc.code, b["code"])
				require.Equal(t, "permission", b["class"])
			}
		})
	}
}

func TestInstallOAuthLoopbackAliasesRedirectBeforeState(t *testing.T) {
	for _, host := range []string{"127.0.0.1:4000", "[::1]:4000"} {
		request := httptest.NewRequest("GET", "http://"+host+"/api/auth/github?return_to=%2F", nil)
		request.RemoteAddr = "127.0.0.1:9"
		called := false
		w := httptest.NewRecorder()
		InstallEffectiveOrigin(func(context.Context) ([]string, error) { return nil, nil })(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })).ServeHTTP(w, request)
		require.False(t, called)
		require.Equal(t, 302, w.Code)
		require.Equal(t, "http://localhost:4000/api/auth/github?return_to=%2F", w.Header().Get("Location"))
		require.Empty(t, w.Header().Values("Set-Cookie"))
	}
}
