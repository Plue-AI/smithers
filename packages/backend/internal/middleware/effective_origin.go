package middleware

import (
	"context"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// ResolveEffectiveOrigin implements spec §16.3.3 using the socket peer and
// known origins. Forwarded scheme and forwarded client addresses are ignored.
func ResolveEffectiveOrigin(r *http.Request, publicOrigins []string) (string, bool) {
	host := r.Host
	socketPeer := r.RemoteAddr
	if original, ok := r.Context().Value(socketPeerKey{}).(string); ok {
		socketPeer = original
	}
	peer, _, err := net.SplitHostPort(socketPeer)
	if err != nil {
		peer = socketPeer
	}
	loopback := net.ParseIP(peer) != nil && net.ParseIP(peer).IsLoopback()
	if loopback && r.Header.Get("X-Forwarded-Host") != "" {
		host = strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
	}
	if strings.ContainsAny(host, "/?#@\\") {
		return "", false
	}
	known := append([]string(nil), publicOrigins...)
	if loopback {
		known = append(known, "http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000")
	}
	origin := ""
	for _, candidate := range known {
		u, err := url.Parse(candidate)
		if err == nil && strings.EqualFold(u.Host, host) {
			if origin != "" && origin != strings.TrimRight(candidate, "/") {
				return "", false
			}
			origin = strings.TrimRight(candidate, "/")
		}
	}
	if origin == "" {
		return "", false
	}
	return origin, true
}

type effectiveOriginKey struct{}

// EffectiveOrigin returns the one origin captured before authentication.
func EffectiveOrigin(ctx context.Context) string {
	origin, _ := ctx.Value(effectiveOriginKey{}).(string)
	return origin
}

// CookieSecure preserves the deployment setting outside the install composition.
func CookieSecure(r *http.Request, fallback bool) bool {
	if origin := EffectiveOrigin(r.Context()); origin != "" {
		return strings.HasPrefix(origin, "https://")
	}
	return fallback
}

// InstallEffectiveOrigin snapshots committed settings before RealIP/authentication.
// The host-relay uses its separate credential-only router, never this chain.
func InstallEffectiveOrigin(origins func(context.Context) ([]string, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			peer, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				peer = r.RemoteAddr
			}
			if r.URL.Path == "/readyz" && net.ParseIP(peer) != nil && net.ParseIP(peer).IsLoopback() {
				next.ServeHTTP(w, r)
				return
			}
			known, err := origins(r.Context())
			if err != nil {
				pkgerrors.WriteError(w, pkgerrors.Internal("install origins unavailable").WithCause(err))
				return
			}
			origin, ok := ResolveEffectiveOrigin(r, known)
			if !ok {
				pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeUnknownOrigin, "install origin is not configured"))
				return
			}
			if header := r.Header.Get("Origin"); header != "" && header != origin {
				pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeOrigin, "request origin differs from install origin"))
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), effectiveOriginKey{}, origin))
			if r.Method == http.MethodGet && (r.URL.Path == "/api/auth/github" || r.URL.Path == "/api/auth/github/cli") && (origin == "http://127.0.0.1:4000" || origin == "http://[::1]:4000") {
				http.Redirect(w, r, "http://localhost:4000"+r.URL.RequestURI(), http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CheckInstallCookieOrigin is shared by mutations and actual transport upgrades.
// Token credentials are stateless and carry no ambient session authority.
func CheckInstallCookieOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := EffectiveOrigin(r.Context())
	if origin == "" {
		return true
	}
	info := AuthInfoFromContext(r.Context())
	if info == nil || info.IsTokenAuth {
		return true
	}
	if r.Header.Get("Origin") != origin {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeOrigin, "request origin required"))
		return false
	}
	return true
}
