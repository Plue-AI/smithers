package middleware

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

// FixedOrigins is a known-origin source that never changes: configuration's
// list, or a test's.
func FixedOrigins(origins ...string) func() []string {
	fixed := append([]string(nil), origins...)
	return func() []string { return fixed }
}

// CanonicalOrigin is origin as a browser sends it in an Origin header: scheme
// and host in lower case, no trailing slash. A typed address such as
// http://Williams-Mac-mini.local:4000 is the same origin as the lower-case
// one the browser sends. A value that is not an origin is only trimmed.
func CanonicalOrigin(origin string) string {
	if canonical, err := config.CanonicalOrigin(origin); err == nil {
		return canonical
	}
	return strings.TrimRight(strings.TrimSpace(origin), "/")
}

// SameOrigin compares two origins in canonical form.
func SameOrigin(a, b string) bool {
	return CanonicalOrigin(a) == CanonicalOrigin(b)
}

// ResolveEffectiveOrigin implements spec §16.3.3 using the socket peer and
// known origins. Forwarded scheme and forwarded client addresses are ignored.
// The origin it returns is canonical (CanonicalOrigin), whatever the spelling
// of the known origin it matched.
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
			if origin != "" && origin != CanonicalOrigin(candidate) {
				return "", false
			}
			origin = CanonicalOrigin(candidate)
		}
	}
	if origin == "" {
		return "", false
	}
	return origin, true
}
