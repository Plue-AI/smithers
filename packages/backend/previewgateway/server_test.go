package previewgateway

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

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
	handler.SetRelayToken("relay-secret")
	request := relayRequest("/__preview/demo.preview.jjhub.tech/hello?x=1")
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
	handler.SetRelayToken("relay-secret")
	request := relayRequest("https://3000-ws-1.preview.jjhub.tech:443/hello?x=1")
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

}

func relayRequest(target string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Header.Set(RelayTokenHeader, "relay-secret")
	return request
}

// fakePreviewAPI answers the API's grant check (POST
// /internal/workspace-previews/authorize) the way routes'
// WorkspacePreviewTicketHandler does: 204 while the grant holds, 403 once the
// share is removed or the user suspended.
type fakePreviewAPI struct {
	revoked bool
	down    bool
	checks  int
}

func (a *fakePreviewAPI) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	a.checks++
	var body AuthorizeRequest
	switch {
	case a.down:
		writer.WriteHeader(http.StatusBadGateway)
	case request.Header.Get("Authorization") != "Bearer relay-secret":
		writer.WriteHeader(http.StatusUnauthorized)
	case json.NewDecoder(request.Body).Decode(&body) != nil:
		writer.WriteHeader(http.StatusBadRequest)
	case a.revoked || body.Ticket == "":
		writer.WriteHeader(http.StatusForbidden)
	default:
		writer.WriteHeader(http.StatusNoContent)
	}
}

// TestUserPreviewHostRequiresTicket pins audit W2: a user preview host
// (<port>-<workspace-id>.preview...) is served only to a viewer holding an
// API-minted ticket whose grant the API still confirms.
func TestUserPreviewHostRequiresTicket(t *testing.T) {
	const domain = "3000-11111111-1111-4111-8111-111111111111.preview.jjhub.tech"
	grant := Grant{Domain: domain, WorkspaceID: "11111111-1111-4111-8111-111111111111", RepositoryID: 7, UserID: 42}
	api := &fakePreviewAPI{}
	apiServer := httptest.NewServer(api)
	defer apiServer.Close()
	dialer := &testDialer{requests: make(chan *http.Request, 4)}
	handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
	handler.SetRelayToken("relay-secret")
	handler.SetGrantAuthorizer(&APIAuthorizer{URL: apiServer.URL, RelayToken: "relay-secret", HTTPClient: apiServer.Client()})
	now := time.Now()
	handler.now = func() time.Time { return now }
	serve := func(request *http.Request) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	// Anonymous: refused before the box is dialed, by Host and by path.
	for _, target := range []string{"https://" + domain + "/hello?x=1", RoutePrefix + domain + "/hello"} {
		recorder := serve(httptest.NewRequest(http.MethodGet, target, nil))
		assert.Equal(t, http.StatusUnauthorized, recorder.Code, target)
		assert.Empty(t, dialer.domain, "%s: anonymous request dialed the workspace", target)
	}

	// A ticket for another preview, a tampered ticket, and a session ticket
	// in the exchange slot are all refused.
	exchange, err := handler.tickets.Issue(grant, PurposeExchange, ExchangeTicketTTL)
	require.NoError(t, err)
	other := grant
	other.Domain = "3001-11111111-1111-4111-8111-111111111111.preview.jjhub.tech"
	otherTicket, err := handler.tickets.Issue(other, PurposeExchange, ExchangeTicketTTL)
	require.NoError(t, err)
	sessionTicket, err := handler.tickets.Issue(grant, PurposeSession, SessionTicketTTL)
	require.NoError(t, err)
	forged, err := NewTickets("another-secret").Issue(grant, PurposeExchange, ExchangeTicketTTL)
	require.NoError(t, err)
	for name, ticket := range map[string]string{"other domain": otherTicket, "session as exchange": sessionTicket,
		"forged": forged, "tampered": exchange[:len(exchange)-2] + "AA"} {
		recorder := serve(httptest.NewRequest(http.MethodGet, "https://"+domain+"/?"+TicketQueryParameter+"="+url.QueryEscape(ticket), nil))
		assert.Equal(t, http.StatusUnauthorized, recorder.Code, name)
	}
	assert.Empty(t, dialer.domain)

	// A valid exchange ticket becomes a host-only session cookie and a
	// redirect to the same URL without the ticket.
	recorder := serve(httptest.NewRequest(http.MethodGet, "https://"+domain+"/app/page?x=1&"+TicketQueryParameter+"="+url.QueryEscape(exchange), nil))
	require.Equal(t, http.StatusFound, recorder.Code)
	assert.Equal(t, "/app/page?x=1", recorder.Header().Get("Location"))
	assert.Empty(t, dialer.domain, "the exchange itself never reaches the box")
	cookies := recorder.Result().Cookies()
	require.Len(t, cookies, 1)
	session := cookies[0]
	assert.Equal(t, SessionCookieName, session.Name)
	assert.True(t, session.Secure)
	assert.True(t, session.HttpOnly)
	assert.Empty(t, session.Domain, "the session cookie must be host-only")

	// The session cookie serves the preview; the guest sees its own cookies
	// but never the preview session.
	request := httptest.NewRequest(http.MethodGet, "https://"+domain+"/app/page?x=1", nil)
	request.AddCookie(&http.Cookie{Name: "app", Value: "guest"})
	request.AddCookie(session)
	recorder = serve(request)
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "preview", recorder.Body.String())
	assert.Equal(t, domain, dialer.domain)
	upstream := <-dialer.requests
	assert.Equal(t, "app=guest", upstream.Header.Get("Cookie"))
	assert.Equal(t, "/app/page?x=1", upstream.URL.RequestURI())

	// The session is bound to its host.
	request = httptest.NewRequest(http.MethodGet, "https://"+other.Domain+"/", nil)
	request.AddCookie(session)
	assert.Equal(t, http.StatusUnauthorized, serve(request).Code)

	// Revoked (share removed, user suspended): refused within the recheck
	// interval, long before the ticket expires.
	api.revoked = true
	now = now.Add(grantRecheckInterval + time.Second)
	dialer.domain = ""
	request = httptest.NewRequest(http.MethodGet, "https://"+domain+"/app/page", nil)
	request.AddCookie(session)
	assert.Equal(t, http.StatusUnauthorized, serve(request).Code)
	assert.Empty(t, dialer.domain, "a revoked grant dialed the workspace")

	// The API unreachable: fail closed, as unavailable rather than denied.
	api.revoked, api.down = false, true
	request = httptest.NewRequest(http.MethodGet, "https://"+domain+"/", nil)
	request.AddCookie(session)
	assert.Equal(t, http.StatusServiceUnavailable, serve(request).Code)
	assert.Empty(t, dialer.domain)

	// An expired private session falls back only to explicit public consent.
	api.down = false
	now = now.Add(SessionTicketTTL + time.Hour)
	handler.tickets.now = handler.now
	checks := api.checks
	request = httptest.NewRequest(http.MethodGet, "https://"+domain+"/", nil)
	request.AddCookie(session)
	assert.Equal(t, http.StatusUnauthorized, serve(request).Code)
	assert.Equal(t, checks+1, api.checks)
}

func TestUserPreviewWithoutGrantAuthorizerFailsClosed(t *testing.T) {
	const domain = "3000-ws-1.preview.jjhub.tech"
	dialer := &testDialer{}
	handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
	handler.SetRelayToken("relay-secret")
	session, err := handler.tickets.Issue(Grant{Domain: domain, WorkspaceID: "ws-1", RepositoryID: 1, UserID: 1}, PurposeSession, SessionTicketTTL)
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodGet, "https://"+domain+"/", nil)
	request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	assert.Empty(t, dialer.domain)
}

func TestUserPreviewGuestCannotSetSessionCookie(t *testing.T) {
	const domain = "3000-ws-1.preview.jjhub.tech"
	guest := &setCookieDialer{}
	handler := NewHandler(guest, []string{".preview.jjhub.tech"}, nil)
	handler.SetRelayToken("relay-secret")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, relayRequest(RoutePrefix+domain+"/"))
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, []string{"app=1"}, recorder.Header().Values("Set-Cookie"))
}

type setCookieDialer struct{}

func (setCookieDialer) Dial(context.Context, string) (net.Conn, error) {
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		request, err := http.ReadRequest(newBufferedReader(server))
		if err != nil {
			return
		}
		_ = request.Body.Close()
		_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nSet-Cookie: "+SessionCookieName+"=x; Path=/\r\nSet-Cookie: app=1\r\nContent-Length: 2\r\n\r\nok")
	}()
	return client, nil
}

func TestPublicPreviewCannotServeAnotherPreviewOrigin(t *testing.T) {
	const victim = "3000-victim.preview.jjhub.tech"
	const attacker = "3000-attacker.preview.jjhub.tech"
	for _, host := range []string{victim, "gateway.internal"} {
		dialer := &testDialer{}
		handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
		handler.SetRelayToken("secret")
		handler.SetGrantAuthorizer(&publicPreviewGrant{public: true})
		ticket, err := handler.tickets.Issue(Grant{Domain: victim, WorkspaceID: "victim", RepositoryID: 1, UserID: 1}, PurposeSession, SessionTicketTTL)
		require.NoError(t, err)
		request := httptest.NewRequest(http.MethodGet, "https://"+host+RoutePrefix+attacker+"/", nil)
		request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: ticket})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusUnauthorized, response.Code, "public content must not be embedded under %s", host)
		require.Empty(t, dialer.domain, "refuse cross-origin routing before workspace wake")
	}
}
