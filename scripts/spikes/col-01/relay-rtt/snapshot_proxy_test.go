package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSnapshotProxyTargetExactHTTPSAllowlist(t *testing.T) {
	for _, host := range []string{"github.com", "codeload.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "api.github.com", "registry.npmjs.org", "nodejs.org"} {
		t.Run(host, func(t *testing.T) {
			target, ok := snapshotProxyTarget(host + ":443")
			if !ok || target != host+":443" {
				t.Fatalf("explicit target denied: %q %v", target, ok)
			}
		})
	}
	for _, authority := range []string{"github.com", "github.com:80", "github.com:0443", "github.com:443/", "github.com:443?x=1", "github.com.:443", "github.com.evil.test:443", "evil.github.com:443", "user@github.com:443", "https://github.com:443", "http://github.com:443", "localhost:443", "127.0.0.1:443", "[::1]:443", "registry.npmjs.org:8080", "example.com:443", " github.com:443", "github.com:443\n", "github%2ecom:443", "github.com:443:443", ""} {
		t.Run(authority, func(t *testing.T) {
			if _, ok := snapshotProxyTarget(authority); ok {
				t.Fatalf("unapproved authority accepted: %q", authority)
			}
		})
	}
}

func TestSnapshotProxyRefusesMethodsAndTargetsBeforeDial(t *testing.T) {
	called := false
	handler := newSnapshotProxy(func(context.Context, string, string) (net.Conn, error) {
		called = true
		return nil, fmt.Errorf("must not dial")
	})
	for _, tc := range []struct{ method, target string }{{"GET", "http://github.com/"}, {"POST", "http://github.com/"}, {"CONNECT", "github.com:80"}, {"CONNECT", "example.com:443"}, {"CONNECT", "https://github.com:443"}} {
		t.Run(tc.method+tc.target, func(t *testing.T) {
			req := &http.Request{Method: tc.method, RequestURI: tc.target, Header: make(http.Header)}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code < 400 || recorder.Code >= 500 {
				t.Fatalf("rejection status=%d", recorder.Code)
			}
			if called {
				t.Fatal("rejected request caused outbound dial")
			}
		})
	}
}

func TestSnapshotProxyTunnelPreservesRealTLSRequestAndResponse(t *testing.T) {
	payload := bytes.Repeat([]byte{0, 1, 2, 10, 13, 127, 128, 255}, 8192)
	seen := make(chan []byte, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		seen <- data
		w.Write(data)
	}))
	defer upstream.Close()
	proxy := httptest.NewServer(newSnapshotProxy(func(ctx context.Context, network, target string) (net.Conn, error) {
		if network != "tcp" || target != "github.com:443" {
			return nil, fmt.Errorf("unexpected dial %s %s", network, target)
		}
		return (&net.Dialer{}).DialContext(ctx, "tcp", upstream.Listener.Addr().String())
	}))
	defer proxy.Close()
	client, err := net.DialTimeout("tcp", proxy.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(client, "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
	reader := bufio.NewReader(client)
	response, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("CONNECT status=%d", response.StatusCode)
	}
	pool := x509.NewCertPool()
	pool.AddCert(upstream.Certificate())
	secure := tls.Client(client, &tls.Config{RootCAs: pool, ServerName: "example.com", MinVersion: tls.VersionTLS12})
	if err := secure.Handshake(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", "https://github.com/payload", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Close = true
	if err := req.Write(secure); err != nil {
		t.Fatal(err)
	}
	response, err = http.ReadResponse(bufio.NewReader(secure), req)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("TLS echo corrupted: got %d bytes", len(data))
	}
	if !bytes.Equal(<-seen, payload) {
		t.Fatal("upstream received corrupted body")
	}
}

func TestSnapshotProxyTunnelKeepsBytesBufferedAfterCONNECT(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	payload := bytes.Repeat([]byte("buffered\x00\xff"), 128)
	finished := make(chan error, 1)
	go func() {
		conn, err := upstream.Accept()
		if err != nil {
			finished <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		data := make([]byte, len(payload))
		_, err = io.ReadFull(conn, data)
		if err == nil && !bytes.Equal(data, payload) {
			err = fmt.Errorf("buffered bytes corrupted")
		}
		if err == nil {
			_, err = conn.Write(data)
		}
		finished <- err
	}()
	proxy := httptest.NewServer(newSnapshotProxy(func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", upstream.Addr().String())
	}))
	defer proxy.Close()
	client, err := net.DialTimeout("tcp", proxy.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(5 * time.Second))
	frame := append([]byte("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"), payload...)
	if _, err := client.Write(frame); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(client)
	response, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("CONNECT status=%d", response.StatusCode)
	}
	data := make([]byte, len(payload))
	if _, err := io.ReadFull(reader, data); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatal("buffered bytes lost or reordered")
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotProxyDialFailureIsVisible(t *testing.T) {
	proxy := httptest.NewServer(newSnapshotProxy(func(context.Context, string, string) (net.Conn, error) {
		return nil, fmt.Errorf("upstream unavailable")
	}))
	defer proxy.Close()
	client, err := net.DialTimeout("tcp", proxy.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	fmt.Fprint(client, "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(client), &http.Request{Method: "CONNECT"})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("dial failure status=%d", response.StatusCode)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if strings.Contains(string(data), "upstream unavailable") {
		t.Fatal("raw dial diagnostics exposed")
	}
}
