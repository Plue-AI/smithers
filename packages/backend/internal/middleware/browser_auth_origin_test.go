package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCanonicalBrowserAuthOrigin(t *testing.T) {
	for _, tc := range []struct {
		name, target, forwardedHost, forwardedProto, method, wantLocation string
		wantNext                                                          bool
	}{
		{"browser", "https://api.example/api/auth/github?return_to=%2Fo%2Fr", "", "", "GET", "https://app.example/api/auth/github?return_to=%2Fo%2Fr", false},
		{"native", "https://api.example/api/auth/github/cli?callback_port=41523&callback_state=bound", "", "", "GET", "https://app.example/api/auth/github/cli?callback_port=41523&callback_state=bound", false},
		{"oauth consent", "https://api.example/api/oauth2/authorize?client_id=fixture&state=bound", "", "", "GET", "https://app.example/api/oauth2/authorize?client_id=fixture&state=bound", false},
		{"same origin", "https://app.example/api/auth/github", "", "", "GET", "", true},
		{"edge proxy", "http://api.internal/api/auth/github", "app.example", "https", "GET", "", true},
		{"foreign header", "http://api.internal/api/auth/github", "evil.example", "https", "GET", "https://app.example/api/auth/github", false},
		{"forwarded list", "http://api.internal/api/auth/github", "evil.example, app.example", "https", "GET", "https://app.example/api/auth/github", false},
		{"wrong scheme", "http://app.example/api/auth/github", "", "", "GET", "https://app.example/api/auth/github", false},
		{"TLS-terminating load balancer", "http://app.example/api/auth/github", "", "https", "GET", "", true},
		{"load balancer native", "http://app.example/api/auth/github/cli?callback_port=41523", "", "https", "GET", "", true},
		{"load balancer plain HTTP", "http://app.example/api/auth/github", "", "http", "GET", "https://app.example/api/auth/github", false},
		{"token API unchanged", "https://api.example/api/oauth2/token", "", "", "POST", "", true},
		{"callback unchanged", "https://api.example/api/auth/github/callback?code=fixture", "", "", "GET", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			h := CanonicalBrowserAuthOrigin("https://app.example/api/auth/github/callback")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(204) }))
			r := httptest.NewRequest(tc.method, tc.target, nil)
			r.Header.Set("X-Forwarded-Host", tc.forwardedHost)
			r.Header.Set("X-Forwarded-Proto", tc.forwardedProto)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			require.Equal(t, tc.wantNext, called)
			require.Equal(t, tc.wantLocation, w.Header().Get("Location"))
			if !tc.wantNext {
				require.Equal(t, http.StatusFound, w.Code)
				require.Empty(t, w.Result().Cookies(), "redirect before placing a host-only cookie")
			}
		})
	}
}
