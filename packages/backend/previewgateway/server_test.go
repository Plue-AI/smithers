package previewgateway

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testDialer struct {
	domain   string
	requests chan *http.Request
}

func (d *testDialer) Dial(ctx context.Context, domain string) (net.Conn, error) {
	d.domain = domain
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		request, err := http.ReadRequest(newBufferedReader(server))
		if err != nil {
			return
		}
		if d.requests != nil {
			d.requests <- request
		}
		_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\npreview")
		_ = request.Body.Close()
	}()
	return client, nil
}

func TestHandlerProxiesMappedPreviewPath(t *testing.T) {
	dialer := &testDialer{}
	handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
	request := httptest.NewRequest(http.MethodGet, "/__preview/demo.preview.jjhub.tech/hello?x=1", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "preview", recorder.Body.String())
	assert.Equal(t, "demo.preview.jjhub.tech", dialer.domain)
}

func TestHandlerRejectsUnapprovedDomain(t *testing.T) {
	handler := NewHandler(&testDialer{}, []string{".preview.jjhub.tech"}, nil)
	request := httptest.NewRequest(http.MethodGet, "/__preview/metadata.google.internal/", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	assert.Equal(t, http.StatusNotFound, recorder.Code)
}

func TestHandlerUpstreamHost(t *testing.T) {
	for _, tt := range []struct {
		name          string
		domain        string
		incomingHost  string
		path          string
		upstreamHost  string
		forwardedHost string
	}{
		{
			name: "user preview", domain: "demo.preview.jjhub.tech",
			incomingHost: "preview-gateway.internal:3000", path: "/hello",
			upstreamHost: "demo.preview.jjhub.tech", forwardedHost: "preview-gateway.internal:3000",
		},
		{
			name: "desktop stream keeps its routed Host", domain: "smithers-desk-vm-123.preview.jjhub.tech",
			incomingHost: "smithers-desk-vm-123.preview.jjhub.tech", path: "/websockify",
			upstreamHost: "smithers-desk-vm-123.preview.jjhub.tech", forwardedHost: "smithers-desk-vm-123.preview.jjhub.tech",
		},
		{
			name: "gateway prefix inside user preview", domain: "demo-smithers-gw-vm-123.preview.jjhub.tech",
			incomingHost: "demo-smithers-gw-vm-123.preview.jjhub.tech", path: "/health",
			upstreamHost: "demo-smithers-gw-vm-123.preview.jjhub.tech", forwardedHost: "demo-smithers-gw-vm-123.preview.jjhub.tech",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dialer := &testDialer{requests: make(chan *http.Request, 1)}
			handler := NewHandler(dialer, []string{".preview.jjhub.tech", ".example.test"}, nil)
			handler.SetRelayToken("relay-secret")
			request := httptest.NewRequest(http.MethodGet, RoutePrefix+tt.domain+tt.path+"?x=1", nil)
			request.Host = tt.incomingHost
			request.Header.Set("X-Forwarded-Host", "untrusted.example")
			request.Header.Set(RelayTokenHeader, "relay-secret")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			require.Equal(t, http.StatusOK, recorder.Code)
			assert.Equal(t, tt.domain, dialer.domain)
			upstream := <-dialer.requests
			assert.Equal(t, tt.upstreamHost, upstream.Host)
			assert.Equal(t, tt.forwardedHost, upstream.Header.Get("X-Forwarded-Host"))
			assert.Empty(t, upstream.Header.Get(RelayTokenHeader), "the relay credential never reaches the box")
			assert.Equal(t, tt.path+"?x=1", upstream.URL.RequestURI())
		})
	}
}

func TestControllerDialerAuthenticatesPreviewStream(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer preview-secret" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		_ = socket.Close(websocket.StatusNormalClosure, "done")
	}))
	defer controller.Close()
	dialer := &ControllerDialer{
		ControllerURL: controller.URL, HTTPClient: controller.Client(), APIKey: "preview-secret",
	}
	connection, err := dialer.Dial(context.Background(), "demo.preview.jjhub.tech")
	require.NoError(t, err)
	require.NoError(t, connection.Close())
}

func newBufferedReader(reader io.Reader) *bufio.Reader { return bufio.NewReader(reader) }

// The GCE load balancer terminates *.preview.jjhub.tech and forwards the bare
// request, so a workspace service URL (https://3000-ws.preview.jjhub.tech/) is
// routed by Host, not by the /__preview/ path the API relay rewrites to.
func TestHandlerRoutesPreviewHostWithoutPathPrefix(t *testing.T) {
	dialer := &testDialer{requests: make(chan *http.Request, 1)}
	handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
	request := httptest.NewRequest(http.MethodGet, "https://3000-ws-1.preview.jjhub.tech:443/hello?x=1", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "3000-ws-1.preview.jjhub.tech", dialer.domain)
	upstream := <-dialer.requests
	assert.Equal(t, "/hello?x=1", upstream.URL.RequestURI())
	assert.Equal(t, "3000-ws-1.preview.jjhub.tech", upstream.Host)

	// An unapproved Host on a bare path stays a not_found, never a proxy.
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "https://metadata.google.internal/hello", nil))
	assert.Equal(t, http.StatusNotFound, recorder.Code)
}

// TestHandlerRequiresRelayTokenForPlatformDomains pins the door: the gateway is
// reachable from the public internet (api.jjhub.tech/__preview and the
// wildcard Ingress), so platform domains (smithers-desk-*, and the retired
// smithers-gw-*), whose only authorized caller is the API relay, must carry
// the relay credential or be refused before the box is ever dialed.
func TestHandlerRequiresRelayTokenForPlatformDomains(t *testing.T) {
	for _, domain := range []string{
		"smithers-desk-vm-1.preview.jjhub.tech",
		"smithers-gw-vm-1.preview.jjhub.tech",
		"smithers-gw-vm-1.example.test",
	} {
		t.Run(domain, func(t *testing.T) {
			dialer := &testDialer{}
			handler := NewHandler(dialer, []string{".preview.jjhub.tech", ".example.test"}, nil)
			handler.SetRelayToken("relay-secret")

			for name, header := range map[string]string{"missing": "", "wrong": "relay-secre"} {
				request := httptest.NewRequest(http.MethodGet, RoutePrefix+domain+"/websockify", nil)
				if header != "" {
					request.Header.Set(RelayTokenHeader, header)
				}
				recorder := httptest.NewRecorder()
				handler.ServeHTTP(recorder, request)
				assert.Equal(t, http.StatusUnauthorized, recorder.Code, name)
				assert.Empty(t, dialer.domain, "%s: the box was dialed before the credential was checked", name)
			}

			request := httptest.NewRequest(http.MethodGet, RoutePrefix+domain+"/websockify", nil)
			request.Header.Set(RelayTokenHeader, "relay-secret")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			assert.Equal(t, http.StatusOK, recorder.Code)
			assert.Equal(t, domain, dialer.domain)
		})
	}

	t.Run("no token configured fails closed", func(t *testing.T) {
		dialer := &testDialer{}
		handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
		request := httptest.NewRequest(http.MethodGet, RoutePrefix+"smithers-desk-vm-1.preview.jjhub.tech/", nil)
		request.Header.Set(RelayTokenHeader, "")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusUnauthorized, recorder.Code)
		assert.Empty(t, dialer.domain)
	})

	t.Run("user previews stay public", func(t *testing.T) {
		dialer := &testDialer{}
		handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
		handler.SetRelayToken("relay-secret")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, RoutePrefix+"3000-ws-1.preview.jjhub.tech/", nil))
		assert.Equal(t, http.StatusOK, recorder.Code)
	})
}
