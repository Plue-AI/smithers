package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// snapshotProxy provides only HTTPS CONNECT to the dependency hosts needed by
// guest snapshot preparation. It never creates or binds a listener: the root
// harness serves it on its existing 127.0.0.1 bridge listener.
func snapshotProxy() http.Handler {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	return newSnapshotProxy(dialer.DialContext)
}

func snapshotProxyTarget(authority string) (string, bool) {
	host, port, err := net.SplitHostPort(authority)
	if err != nil || port != "443" {
		return "", false
	}
	host = strings.ToLower(host)
	switch host {
	case "github.com", "codeload.github.com", "objects.githubusercontent.com",
		"release-assets.githubusercontent.com", "api.github.com", "registry.npmjs.org", "nodejs.org":
		return net.JoinHostPort(host, port), true
	default:
		return "", false
	}
}

// Only the dial transport is injectable. Tests route these exact approved
// authorities to real loopback TCP/TLS servers, avoiding internet traffic and
// credentials while exercising unchanged authorization and CONNECT handling.
func newSnapshotProxy(dial func(context.Context, string, string) (net.Conn, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			w.Header().Set("Allow", http.MethodConnect)
			http.Error(w, "CONNECT required", http.StatusMethodNotAllowed)
			return
		}
		target, allowed := snapshotProxyTarget(r.RequestURI)
		if !allowed {
			http.Error(w, "Target refused", http.StatusForbidden)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "Tunnel unavailable", http.StatusNotImplemented)
			return
		}
		upstream, err := dial(r.Context(), "tcp", target)
		if err != nil {
			http.Error(w, "Upstream unavailable", http.StatusBadGateway)
			return
		}
		defer upstream.Close()
		client, buffered, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer client.Close()
		if _, err := fmt.Fprint(buffered, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}
		finished := make(chan error, 2)
		copyHalf := func(destination net.Conn, source io.Reader) {
			_, err := io.Copy(destination, source)
			if half, ok := destination.(interface{ CloseWrite() error }); ok {
				if closeErr := half.CloseWrite(); err == nil {
					err = closeErr
				}
			} else {
				destination.Close()
			}
			finished <- err
		}
		// Read through net/http's buffered reader: the CONNECT request and the
		// first TLS bytes can arrive in one socket read.
		go copyHalf(upstream, buffered.Reader)
		go copyHalf(client, upstream)
		if err := <-finished; err != nil {
			client.Close()
			upstream.Close()
		}
		<-finished
	})
}
