package middleware

import (
	"context"
	"net"
	"net/http"
	"strings"
)

type socketPeerKey struct{}

// RealIP rewrites r.RemoteAddr from X-Forwarded-For using a trusted-hop
// count. trustedHops is the number of trailing XFF entries appended by our
// own proxies, counted from the RIGHT; the real client is the entry
// immediately left of that suffix. Behind GKE Ingress (GCLB) the load
// balancer appends "<client-ip>, <lb-ip>", so trustedHops=1 selects the
// LB-observed TCP peer, which a client cannot spoof. trustedHops<=0 keeps
// the socket RemoteAddr and ignores all forwarding headers (direct
// exposure: dev, docker-compose). True-Client-IP and X-Real-IP are never
// consulted. On a missing/short header or an unparsable entry the socket
// RemoteAddr is kept (fail-closed to the trusted peer).
func RealIP(trustedHops int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(context.WithValue(r.Context(), socketPeerKey{}, r.RemoteAddr))
			if trustedHops > 0 {
				if ip := clientIPFromForwardedFor(
					// Join every header line: a proxy that does not merge
					// duplicates appends its entries as a new line, and
					// Header.Get would return only the client's first line.
					strings.Join(r.Header.Values("X-Forwarded-For"), ","), trustedHops); ip != "" {
					r.RemoteAddr = ip
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func clientIPFromForwardedFor(header string, trustedHops int) string {
	if header == "" {
		return ""
	}
	parts := strings.Split(header, ",")
	idx := len(parts) - trustedHops - 1
	if idx < 0 {
		return ""
	}
	ip := net.ParseIP(strings.TrimSpace(parts[idx]))
	if ip == nil {
		return ""
	}
	return ip.String()
}
