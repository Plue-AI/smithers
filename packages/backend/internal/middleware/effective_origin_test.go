package middleware

import (
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
