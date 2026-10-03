package middleware

import (
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
