package egressrelay

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	testValue = "s3cr3t-Value/with+chars"
	testName  = "SMITHERS_CI_JOB_TOKEN"
)

// seen is what an upstream received, for asserting substitution.
type seen struct {
	mu            sync.Mutex
	authorization string
	other         string
	path          string
	query         string
	acceptEncode  string
	proxyAuth     string
}

// echoUpstream returns the value it received in a response header and, split
// across flushed chunks, in the body, so masking must cover both.
func echoUpstream(record *seen) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		record.mu.Lock()
		record.authorization = r.Header.Get("Authorization")
		record.other = r.Header.Get("X-Other")
		record.path = r.URL.Path
		record.query = r.URL.Query().Get("key")
		record.acceptEncode = r.Header.Get("Accept-Encoding")
		record.proxyAuth = r.Header.Get("Proxy-Authorization")
		record.mu.Unlock()
		w.Header().Set("X-Echo", r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "before "+testValue[:5])
		flusher.Flush()
		_, _ = io.WriteString(w, testValue[5:]+" after "+testValue)
	})
}

func newRelay(t *testing.T, config Config) *Relay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	config.Listener = listener
	relay, err := New(config)
	require.NoError(t, err)
	t.Cleanup(func() { _ = relay.Close() })
	return relay
}

func boundSecret(hosts ...string) sandbox.EgressProxySecret {
	return sandbox.EgressProxySecret{Name: testName, Value: testValue, Hosts: hosts,
		MatchHeaders: []string{"authorization"}, MatchQuery: true, MatchPath: true}
}

func proxiedClient(t *testing.T, grant Grant) *http.Client {
	t.Helper()
	proxyURL, err := url.Parse(grant.ProxyURL)
	require.NoError(t, err)
	roots := x509.NewCertPool()
	require.True(t, roots.AppendCertsFromPEM(grant.CACertPEM))
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots}}}
}

func placeholderRequest(t *testing.T, target string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, target+"/runs/"+testName+"/cache?key="+testName, nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+testName)
	req.Header.Set("X-Other", testName)
	req.Header.Set("Accept-Encoding", "gzip")
	return req
}

func assertInjectedAndMasked(t *testing.T, record *seen, response *http.Response) {
	t.Helper()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode, string(body))
	record.mu.Lock()
	defer record.mu.Unlock()
	assert.Equal(t, "Bearer "+testValue, record.authorization, "a bound header carries the value")
	assert.Equal(t, "/runs/"+testValue+"/cache", record.path, "a bound path carries the value")
	assert.Equal(t, testValue, record.query, "a bound query carries the value")
	assert.Equal(t, testName, record.other, "an unbound header keeps the placeholder")
	assert.Empty(t, record.acceptEncode, "identity bodies keep masking exact")
	assert.Empty(t, record.proxyAuth, "the relay credential never reaches the upstream")
	assert.Equal(t, "Bearer "+testName, response.Header.Get("X-Echo"), "a response header is masked")
	assert.Equal(t, "before "+testName+" after "+testName, string(body), "a response body is masked across chunks")
	assert.NotContains(t, string(body), testValue)
}

func TestRelayInjectsAndMasksPlainHTTP(t *testing.T) {
	record := &seen{}
	upstream := httptest.NewServer(echoUpstream(record))
	t.Cleanup(upstream.Close)
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}})
	grant, err := relay.Bind("ws-1", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	assert.NotContains(t, grant.ProxyURL, testValue)
	assert.Equal(t, []string{"127.0.0.1"}, grant.Hosts)

	response, err := proxiedClient(t, grant).Do(placeholderRequest(t, upstream.URL))
	require.NoError(t, err)
	defer response.Body.Close()
	assertInjectedAndMasked(t, record, response)
}

func TestRelayInterceptsTLSToInjectAndMask(t *testing.T) {
	record := &seen{}
	upstream := httptest.NewTLSServer(echoUpstream(record))
	t.Cleanup(upstream.Close)
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}, RootCAs: roots})
	grant, err := relay.Bind("ws-tls", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)

	client := proxiedClient(t, grant)
	for range 2 { // the second request reuses the intercepted tunnel
		response, err := client.Do(placeholderRequest(t, upstream.URL))
		require.NoError(t, err)
		assertInjectedAndMasked(t, record, response)
		response.Body.Close()
	}

	// Revoking closes the open tunnel; a new one is refused.
	record.mu.Lock()
	record.authorization = ""
	record.mu.Unlock()
	relay.Revoke("ws-tls")
	_, err = client.Do(placeholderRequest(t, upstream.URL))
	require.ErrorContains(t, err, "Proxy Authentication Required")
	record.mu.Lock()
	assert.Empty(t, record.authorization, "nothing reached the upstream after revocation")
	record.mu.Unlock()
}

// An open tunnel ends the moment its binding is replaced.
func TestRelayClosesTunnelsOnRebind(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(upstream.Close)
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}})
	grant := mustGrant(t, relay, "ws", "127.0.0.1")
	conn, err := net.Dial("tcp", relay.Address())
	require.NoError(t, err)
	defer conn.Close()
	target := upstream.Listener.Addr().String()
	_, err = io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\nProxy-Authorization: Basic "+basic(grant)+"\r\n\r\n")
	require.NoError(t, err)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	mustGrant(t, relay, "ws", "127.0.0.1")
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(5*time.Second)))
	_, err = reader.ReadByte()
	assert.ErrorIs(t, err, io.EOF, "the relay closed the superseded tunnel")
}

func TestRelayRefusesWhatItCannotEnforce(t *testing.T) {
	record := &seen{}
	upstream := httptest.NewServer(echoUpstream(record))
	t.Cleanup(upstream.Close)
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}})
	grant, err := relay.Bind("ws-1", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	client := proxiedClient(t, grant)
	status := func(client *http.Client, target string) int {
		t.Helper()
		response, err := client.Do(placeholderRequest(t, target))
		require.NoError(t, err)
		response.Body.Close()
		return response.StatusCode
	}

	// A host no binding names is not reachable through the relay.
	_, port, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	assert.Equal(t, http.StatusForbidden, status(client, "http://localhost:"+port))

	// No credential, or a forged one.
	assert.Equal(t, http.StatusProxyAuthRequired, status(&http.Client{Transport: &http.Transport{
		Proxy: http.ProxyURL(&url.URL{Scheme: "http", Host: relay.Address()})}}, upstream.URL))
	forged := grant
	forged.ProxyURL = (&url.URL{Scheme: "http", User: url.UserPassword(proxyUser, strings.Repeat("0", 64)), Host: relay.Address()}).String()
	assert.Equal(t, http.StatusProxyAuthRequired, status(proxiedClient(t, forged), upstream.URL))

	// Rebinding replaces the credential; an empty set revokes it.
	rebound, err := relay.Bind("ws-1", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	assert.NotEqual(t, grant.ProxyURL, rebound.ProxyURL)
	assert.Equal(t, http.StatusProxyAuthRequired, status(client, upstream.URL))
	assert.Equal(t, http.StatusOK, status(proxiedClient(t, rebound), upstream.URL))
	empty, err := relay.Bind("ws-1", nil)
	require.NoError(t, err)
	assert.Empty(t, empty.ProxyURL)
	assert.Equal(t, http.StatusProxyAuthRequired, status(proxiedClient(t, rebound), upstream.URL))

	// A bound host that resolves to a private address is refused unless
	// Config.Local names it exactly.
	strict := newRelay(t, Config{})
	strictGrant, err := strict.Bind("ws-2", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, status(proxiedClient(t, strictGrant), upstream.URL))

	// Only loopback clients, and only proxy-form requests.
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
	req.RemoteAddr = "10.0.0.8:4000"
	relay.ServeHTTP(recorder, req)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	current, err := relay.Bind("ws-1", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	recorder = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/origin-form", nil)
	req.RemoteAddr = "127.0.0.1:4000"
	req.Header.Set("Proxy-Authorization", "Basic "+basic(current))
	relay.ServeHTTP(recorder, req)
	assert.Equal(t, http.StatusBadRequest, recorder.Code, "the relay is a forward proxy, not an origin")
}

func basic(grant Grant) string {
	parsed, _ := url.Parse(grant.ProxyURL)
	password, _ := parsed.User.Password()
	return base64.StdEncoding.EncodeToString([]byte(parsed.User.Username() + ":" + password))
}

func TestBindRejectsUnenforceableSecrets(t *testing.T) {
	relay := newRelay(t, Config{})
	for name, secrets := range map[string][]sandbox.EgressProxySecret{
		"no host":          {{Name: "A", Value: "v", MatchHeaders: []string{"Authorization"}}},
		"no location":      {{Name: "A", Value: "v", Hosts: []string{"api.example.com"}}},
		"no value":         {{Name: "A", Hosts: []string{"api.example.com"}, MatchQuery: true}},
		"bad name":         {{Name: "A-B", Value: "v", Hosts: []string{"api.example.com"}, MatchQuery: true}},
		"duplicate":        {boundSecret("api.example.com"), boundSecret("api.example.com")},
		"self placeholder": {{Name: "A", Value: "xAx", Hosts: []string{"api.example.com"}, MatchQuery: true}},
		"host with a port": {{Name: "A", Value: "v", Hosts: []string{"api.example.com:443"}, MatchQuery: true}},
		"host with scheme": {{Name: "A", Value: "v", Hosts: []string{"https://api.example.com"}, MatchQuery: true}},
		"mixed valid+bad":  {boundSecret("api.example.com"), {Name: "B", Value: "v"}},
		"blank workspace":  nil,
	} {
		workspace := "ws"
		if name == "blank workspace" {
			workspace = " "
		}
		_, err := relay.Bind(workspace, secrets)
		assert.Error(t, err, name)
	}
	// A wildcard or address range would let the relay swap a value into
	// requests to every host it covers; only exact host names bind (#3212).
	for _, host := range []string{"*.example.com", "*.ngrok-free.app", "127.0.0.0/8", "127.0.0.1/32", "0.0.0.0/0", "::/0"} {
		_, err := relay.Bind("ws", []sandbox.EgressProxySecret{boundSecret("api.example.com"),
			{Name: "B", Value: "v", Hosts: []string{"api.example.com", host}, MatchQuery: true}})
		assert.ErrorIs(t, err, sandbox.ErrEgressSecretHostNotExact, host)
	}
	relay.mu.Lock()
	assert.Empty(t, relay.byWorkspace, "a refused set binds nothing")
	relay.mu.Unlock()
	_, err := New(Config{})
	assert.Error(t, err, "a relay needs a listener")
	public, err := net.Listen("tcp", "0.0.0.0:0")
	require.NoError(t, err)
	defer public.Close()
	_, err = New(Config{Listener: public})
	assert.Error(t, err, "a relay never listens beyond loopback")
}

// liveBinding binds values (named A, B, ...) and returns the relay's binding.
func liveBinding(t *testing.T, values ...string) *binding {
	t.Helper()
	relay := newRelay(t, Config{})
	var secrets []sandbox.EgressProxySecret
	for index, value := range values {
		secrets = append(secrets, sandbox.EgressProxySecret{Name: string(rune('A' + index)), Value: value,
			Hosts: []string{"api.example.com"}, MatchHeaders: []string{"Authorization"}})
	}
	_, err := relay.Bind("ws", secrets)
	require.NoError(t, err)
	relay.mu.Lock()
	defer relay.mu.Unlock()
	return relay.byToken[relay.byWorkspace["ws"]]
}

func TestMaskingBodyNeverLeaksASplitValue(t *testing.T) {
	for name, values := range map[string][]string{
		"self overlap":         {"abcabcabd", "zz"},
		"prefix of another":    {"tok", "tok-extended-secret"},
		"extension first":      {"tok-extended-secret", "tok"},
		"escaped forms differ": {"a b/c+d", "q"},
	} {
		bound := liveBinding(t, values...)
		var input strings.Builder
		for index, value := range values {
			input.WriteString("x" + value + value[:len(value)/2] + value + "y" + url.QueryEscape(value) + url.PathEscape(value))
			_ = index
		}
		for _, reader := range map[string]func(io.Reader) io.Reader{
			"one byte": iotest.OneByteReader, "half": iotest.HalfReader, "whole": func(r io.Reader) io.Reader { return r },
		} {
			body := &maskingBody{source: io.NopCloser(reader(strings.NewReader(input.String()))), bound: bound}
			out, err := io.ReadAll(body)
			require.NoError(t, err)
			assert.Equal(t, bound.mask(input.String()), string(out), name)
			for _, value := range values {
				for _, form := range []string{value, url.QueryEscape(value), url.PathEscape(value)} {
					assert.NotContains(t, string(out), form, name)
				}
			}
		}
	}
}

func TestGuestEnvironmentRoutesBoundHostsThroughTheRelay(t *testing.T) {
	env := GuestEnvironment(Grant{Hosts: []string{"127.0.0.1", "api.example.com"}}, "http://smithers:t@127.0.0.1:4001", "/state/egress-ca.pem")
	assert.Equal(t, "http://smithers:t@127.0.0.1:4001", env["HTTPS_PROXY"])
	assert.Equal(t, "http://smithers:t@127.0.0.1:4001", env["http_proxy"])
	assert.Equal(t, "/state/egress-ca.pem", env["SSL_CERT_FILE"])
	assert.Equal(t, "localhost,::1,host.microsandbox.internal", env["NO_PROXY"])
	assert.Equal(t, env["NO_PROXY"], env["no_proxy"])
	for _, value := range env {
		assert.NotContains(t, value, testValue)
	}
}

func TestRelayTunnelRefusalsAndUpstreamFailures(t *testing.T) {
	record := &seen{}
	upstream := httptest.NewServer(echoUpstream(record))
	t.Cleanup(upstream.Close)
	_, port, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	// A closed port stands in for an upstream that refuses connections.
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	closedAddress := closed.Addr().String()
	require.NoError(t, closed.Close())
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String(), closedAddress}})
	assert.Equal(t, relay.CACertPEM(), mustGrant(t, relay, "ws-ca", "127.0.0.1").CACertPEM)
	grant := mustGrant(t, relay, "ws", "127.0.0.1")

	connect := func(target string) int {
		t.Helper()
		conn, err := net.Dial("tcp", relay.Address())
		require.NoError(t, err)
		defer conn.Close()
		_, err = io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\nProxy-Authorization: Basic "+basic(grant)+"\r\n\r\n")
		require.NoError(t, err)
		response, err := http.ReadResponse(bufioReader(conn), nil)
		require.NoError(t, err)
		response.Body.Close()
		return response.StatusCode
	}
	assert.Equal(t, http.StatusForbidden, connect("example.com:443"), "no tunnel to an unbound host")
	assert.Equal(t, http.StatusBadRequest, connect("127.0.0.1"), "a tunnel needs host:port")

	client := proxiedClient(t, grant)
	get := func(target string, header http.Header) (*http.Response, string) {
		t.Helper()
		req := placeholderRequest(t, target)
		for name, values := range header {
			req.Header[name] = values
		}
		response, err := client.Do(req)
		require.NoError(t, err)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		return response, string(body)
	}
	// A bound private address is refused unless Config.Local names it.
	response, _ := get("http://127.0.0.2:"+port, nil)
	assert.Equal(t, http.StatusForbidden, response.StatusCode)
	// A refused upstream is a gateway error whose text never carries a value.
	response, body := get("http://"+closedAddress, nil)
	assert.Equal(t, http.StatusBadGateway, response.StatusCode)
	assert.NotContains(t, body, testValue)
	// Headers the client lists in Connection are hop-by-hop and dropped.
	response, _ = get(upstream.URL, http.Header{"Connection": {"X-Other"}})
	assert.Equal(t, http.StatusOK, response.StatusCode)
	record.mu.Lock()
	assert.Empty(t, record.other)
	record.mu.Unlock()
}

func mustGrant(t *testing.T, relay *Relay, workspace string, hosts ...string) Grant {
	t.Helper()
	grant, err := relay.Bind(workspace, []sandbox.EgressProxySecret{boundSecret(hosts...)})
	require.NoError(t, err)
	return grant
}

func bufioReader(conn net.Conn) *bufio.Reader { return bufio.NewReader(conn) }

// Upstream text the masker cannot see is never forwarded: the reason phrase
// and trailers are replaced or dropped, escaped reflections are masked, and a
// compressed body is refused rather than passed through.
func TestRelayMasksEveryUpstreamChannel(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := r.Header.Get("Authorization")
		switch r.URL.Query().Get("mode") {
		case "gzip":
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = io.WriteString(w, authorization)
		case "trailer":
			w.Header().Set("Trailer", "X-Leak")
			w.Header().Set("Location", "/p/"+url.PathEscape(testValue)+"?k="+url.QueryEscape(testValue))
			_, _ = io.WriteString(w, "body")
			w.Header().Set("X-Leak", authorization)
		}
	}))
	t.Cleanup(upstream.Close)
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}, RootCAs: roots})
	client := proxiedClient(t, mustGrant(t, relay, "ws", "127.0.0.1"))
	get := func(mode string) *http.Response {
		t.Helper()
		req := placeholderRequest(t, upstream.URL)
		req.URL.RawQuery = "mode=" + mode
		response, err := client.Do(req)
		require.NoError(t, err)
		return response
	}
	response := get("trailer")
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	response.Body.Close()
	assert.Equal(t, "body", string(body))
	assert.Equal(t, "200 OK", response.Status)
	assert.Empty(t, response.Trailer.Get("X-Leak"), "trailers are dropped")
	assert.Equal(t, "/p/"+testName+"?k="+testName, response.Header.Get("Location"), "escaped reflections are masked")

	response = get("gzip")
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	assert.Equal(t, http.StatusBadGateway, response.StatusCode)
	assert.NotContains(t, string(body), testValue)
}

// Credentials go over plaintext HTTP only to Config.Local.
func TestRelayRefusesPlaintextToPublicHosts(t *testing.T) {
	relay := newRelay(t, Config{})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://api.example.com/v1", nil)
	req.RemoteAddr = "127.0.0.1:5000"
	req.Header.Set("Proxy-Authorization", "Basic "+basic(mustGrant(t, relay, "ws", "api.example.com")))
	relay.ServeHTTP(recorder, req)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "https only")
}

// The deny list refuses private and IPv4-mapped private addresses and admits
// public IPv4 and IPv6 ones.
func TestRelayDenyListAdmitsPublicAddresses(t *testing.T) {
	relay := newRelay(t, Config{})
	for address, denied := range map[string]bool{
		"8.8.8.8": false, "1.1.1.1": false, "2606:4700:4700::1111": false,
		"10.0.0.1": true, "127.0.0.1": true, "169.254.169.254": true, "::ffff:10.0.0.1": true, "::1": true, "fd00::1": true,
	} {
		assert.Equal(t, denied, relay.denied(net.ParseIP(address)), address)
	}
}

// Cleanup of a superseded grant never revokes the workspace's newer binding.
func TestRevokeGrantSparesANewerBinding(t *testing.T) {
	relay := newRelay(t, Config{})
	older := mustGrant(t, relay, "ws", "api.example.com")
	newer := mustGrant(t, relay, "ws", "api.example.com")
	relay.RevokeGrant("ws", older)
	require.NotNil(t, relay.authenticate("Basic "+basic(newer)))
	relay.RevokeGrant(" ws ", newer)
	assert.Nil(t, relay.authenticate("Basic "+basic(newer)))
	relay.RevokeGrant("ws", Grant{})
}

func TestSecretBindsOnlyItsExactHost(t *testing.T) {
	secret := boundSecret("api.example.com", "127.0.0.1", "k.example.com")
	for host, want := range map[string]bool{
		"api.example.com":      true,
		"API.Example.com":      true,
		"127.0.0.1":            true,
		"x.api.example.com":    false,
		"api.example.com.evil": false,
		"evilapi.example.com":  false,
		"example.com":          false,
		"api.example.com.":     false,
		"127.0.0.2":            false,
		"*.api.example.com":    false,
		"api.example.com:443":  false,
		"":                     false,
		// Non-ASCII never matches: lower-casing and IDNA can disagree.
		"api.exampl\u0435.com": false,
		"\u212a.example.com":   false,
	} {
		assert.Equal(t, want, secretBindsHost(secret, host), host)
	}
	// An address literal matches every spelling of the one address.
	literal := boundSecret("::1", "::ffff:10.0.0.1")
	literal.Hosts = normalizedHosts(literal.Hosts)
	for host, want := range map[string]bool{"::1": true, "[::1]": true, "0:0::1": true, "10.0.0.1": true, "::2": false, "10.0.0.2": false} {
		assert.Equal(t, want, secretBindsHost(literal, host), host)
	}
}
