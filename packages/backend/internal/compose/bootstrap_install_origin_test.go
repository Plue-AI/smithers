package compose

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/cors"
	"github.com/stretchr/testify/require"
)

// T-INS-04 regression, found by C-INS-01 on the composed install
// (2026-10-07): GET /api/bootstrap sat in front of the router, so an install
// answered it 200 for any Host, an origin the owner never set included, and
// with CORS allow headers for a configured origin. Spec §16.3.3 exempts only
// /readyz from loopback and the host-relay port.
func TestInstallBootstrapAnswersKnownOriginsOnly(t *testing.T) {
	origins := []string{"http://lan-a:4000", "https://box.example"}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	handler := withInstallBootstrap(next, newAppBootstrap(bootstrapFeatures{install: true, identity: true}), func() []string { return origins })
	ask := func(method, path, host, peer string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, "http://"+host+path, nil)
		request.RemoteAddr = peer
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		for name := range response.Header() {
			require.False(t, strings.HasPrefix(name, "Access-Control-"), "%s %s from %s carries %s", method, host, peer, name)
		}
		return response
	}
	const loopback, lan = "127.0.0.1:51000", "192.0.2.7:51000"
	const unknown = `{"class":"user","code":"unknown_origin","message":"unknown_origin"}`
	const foreign = `{"class":"permission","code":"origin","message":"origin"}`

	for _, known := range []struct {
		name, host, peer string
		headers          map[string]string
	}{
		{"loopback on the Mac", "localhost:4000", loopback, nil},
		{"the loopback address", "127.0.0.1:4000", loopback, nil},
		{"the page's own Origin", "localhost:4000", loopback, map[string]string{"Origin": "http://localhost:4000"}},
		{"an owner-set origin from the network", "lan-a:4000", lan, nil},
		{"an owner-set origin typed with capitals", "LAN-A:4000", lan, map[string]string{"Origin": "http://lan-a:4000"}},
		{"the https origin behind a loopback proxy", "127.0.0.1:4000", loopback, map[string]string{"X-Forwarded-Host": "box.example", "Origin": "https://box.example"}},
		{"a network peer's forwarding headers are ignored", "lan-a:4000", lan, map[string]string{"X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https"}},
		{"a bearer request needs no Origin", "lan-a:4000", lan, map[string]string{"Authorization": "Bearer token", "Origin": "http://evil.example"}},
	} {
		response := ask(http.MethodGet, "/api/bootstrap", known.host, known.peer, known.headers)
		require.Equal(t, http.StatusOK, response.Code, known.name)
		var document map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &document), known.name)
		require.Equal(t, "cloud", document["host"], known.name)
		require.Equal(t, "redirect", document["authFlow"], known.name)
		require.Equal(t, []any{"install", "identity"}, document["capabilities"], known.name)
		require.Equal(t, "no-store", response.Header().Get("Cache-Control"), known.name)
	}

	for _, refused := range []struct {
		name, host, peer string
		headers          map[string]string
		status           int
		body             string
	}{
		{"a host the owner never set", "evil.example", loopback, nil, http.StatusMisdirectedRequest, unknown},
		{"a host the owner never set, from the network", "unset-origin.test:4000", lan, nil, http.StatusMisdirectedRequest, unknown},
		{"the loopback host from the network", "localhost:4000", lan, nil, http.StatusMisdirectedRequest, unknown},
		{"a forwarded host from the network", "evil.example", lan, map[string]string{"X-Forwarded-Host": "lan-a:4000"}, http.StatusMisdirectedRequest, unknown},
		{"another known origin as Origin", "lan-a:4000", lan, map[string]string{"Origin": "https://box.example"}, http.StatusForbidden, foreign},
		{"a foreign Origin", "localhost:4000", loopback, map[string]string{"Origin": "http://evil.example"}, http.StatusForbidden, foreign},
	} {
		response := ask(http.MethodGet, "/api/bootstrap", refused.host, refused.peer, refused.headers)
		require.Equal(t, refused.status, response.Code, refused.name)
		require.JSONEq(t, refused.body, response.Body.String(), refused.name)
		require.NotContains(t, response.Body.String(), "capabilities", refused.name)
	}

	// The document keeps its methods on a known origin.
	head := ask(http.MethodHead, "/api/bootstrap", "localhost:4000", loopback, nil)
	require.Equal(t, http.StatusOK, head.Code)
	require.Empty(t, head.Body.String())
	post := ask(http.MethodPost, "/api/bootstrap", "localhost:4000", loopback, nil)
	require.Equal(t, http.StatusMethodNotAllowed, post.Code)
	require.Equal(t, "GET, HEAD", post.Header().Get("Allow"))
	// A refused host learns nothing from the method either.
	require.Equal(t, http.StatusMisdirectedRequest, ask(http.MethodPost, "/api/bootstrap", "evil.example", loopback, nil).Code)

	// An origin the owner removes is refused on the next request, no restart.
	origins = []string{"https://box.example"}
	removed := ask(http.MethodGet, "/api/bootstrap", "lan-a:4000", lan, nil)
	require.Equal(t, http.StatusMisdirectedRequest, removed.Code)
	require.JSONEq(t, unknown, removed.Body.String())
	require.Equal(t, http.StatusOK, ask(http.MethodGet, "/api/bootstrap", "localhost:4000", loopback, nil).Code, "loopback survives the change")

	// Every other path is the router's, which resolves the origin itself.
	require.Equal(t, http.StatusTeapot, ask(http.MethodGet, "/api/user", "evil.example", lan, nil).Code)
	require.Equal(t, http.StatusTeapot, ask(http.MethodGet, "/api/bootstrap/extra", "evil.example", lan, nil).Code)
}

// The hosted composition keeps its bootstrap in front of the router with its
// CORS policy: it has no install origins, and Plue's app reads it cross-origin.
func TestHostedBootstrapKeepsItsCORSPolicy(t *testing.T) {
	handler := withAppBootstrap(http.NotFoundHandler(), newAppBootstrap(bootstrapFeatures{identity: true}), cors.Options{
		AllowedOrigins: []string{"https://app.example"}, AllowCredentials: true})
	request := httptest.NewRequest(http.MethodGet, "http://api.example/api/bootstrap", nil)
	request.RemoteAddr = "192.0.2.7:51000"
	request.Header.Set("Origin", "https://app.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, "https://app.example", response.Header().Get("Access-Control-Allow-Origin"))
	require.Equal(t, "true", response.Header().Get("Access-Control-Allow-Credentials"))
}

// The production composition wires the install's Address into its bootstrap
// (compose/main.go): the same process answers a known origin and refuses any
// other before the document is read.
func TestInstallBootstrapOriginThroughCompositionPostgres(t *testing.T) {
	splitProcessDatabase(t)
	handler := startSplitProcess(t, Options{})
	ask := func(host, peer, origin string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/bootstrap", nil)
		request.RemoteAddr = peer
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		for name := range response.Header() {
			require.False(t, strings.HasPrefix(name, "Access-Control-"), "%s from %s carries %s", host, peer, name)
		}
		return response
	}
	known := ask("127.0.0.1:4000", "127.0.0.1:51000", "http://127.0.0.1:4000")
	require.Equal(t, http.StatusOK, known.Code, known.Body.String())
	var document struct {
		Capabilities []string `json:"capabilities"`
	}
	require.NoError(t, json.Unmarshal(known.Body.Bytes(), &document))
	require.Contains(t, document.Capabilities, "install")
	for _, refused := range []struct {
		host, peer, origin string
		status             int
		body               string
	}{
		{"evil.example", "127.0.0.1:51000", "", http.StatusMisdirectedRequest, `{"class":"user","code":"unknown_origin","message":"unknown_origin"}`},
		{"127.0.0.1:4000", "192.0.2.7:51000", "", http.StatusMisdirectedRequest, `{"class":"user","code":"unknown_origin","message":"unknown_origin"}`},
		{"127.0.0.1:4000", "127.0.0.1:51000", "http://evil.example", http.StatusForbidden, `{"class":"permission","code":"origin","message":"origin"}`},
	} {
		response := ask(refused.host, refused.peer, refused.origin)
		require.Equal(t, refused.status, response.Code, refused.host)
		require.JSONEq(t, refused.body, response.Body.String())
	}
}

func TestInstallSignedOutSessionThroughCompositionPostgres(t *testing.T) {
	splitProcessDatabase(t)
	handler := startSplitProcess(t, Options{})
	for _, cookie := range []string{"", "smithers_session=expired-session"} {
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4000/api/auth/session", nil)
		request.RemoteAddr = "127.0.0.1:51000"
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.JSONEq(t, `null`, response.Body.String())
		request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4000/api/user", nil)
		request.RemoteAddr = "127.0.0.1:51000"
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusUnauthorized, response.Code)
	}
}
