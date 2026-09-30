package egressrelay

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type auditLog struct {
	mu     sync.Mutex
	events []AuditEvent
}

func (l *auditLog) add(event AuditEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
}

func (l *auditLog) all() []AuditEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]AuditEvent(nil), l.events...)
}

// assertValueFree fails when any audit field carries the secret value, its
// escaped forms, or the relay credential.
func assertValueFree(t *testing.T, events []AuditEvent, grant Grant) {
	t.Helper()
	raw, err := json.Marshal(events)
	require.NoError(t, err)
	parsed, err := url.Parse(grant.ProxyURL)
	require.NoError(t, err)
	token, _ := parsed.User.Password()
	for _, secret := range []string{testValue, "s3cr3t-Value%2Fwith%2Bchars", "s3cr3t-Value%2Fwith+chars", "s3cr3t-Value/with%2Bchars"} {
		assert.NotContains(t, string(raw), secret)
	}
	assert.NotEmpty(t, token)
	assert.NotContains(t, string(raw), token)
}

func TestRelayAuditsABoundRequestOnceWithoutSecretMaterial(t *testing.T) {
	for _, tls_ := range []bool{false, true} {
		record := &seen{}
		var upstream *httptest.Server
		config := Config{}
		if tls_ {
			upstream = httptest.NewTLSServer(echoUpstream(record))
			roots := x509.NewCertPool()
			roots.AddCert(upstream.Certificate())
			config.RootCAs = roots
		} else {
			upstream = httptest.NewServer(echoUpstream(record))
		}
		t.Cleanup(upstream.Close)
		log := &auditLog{}
		config.Local, config.Audit = []string{upstream.Listener.Addr().String()}, log.add
		relay := newRelay(t, config)
		grant, err := relay.Bind("ws-audit", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
		require.NoError(t, err)

		response, err := proxiedClient(t, grant).Do(placeholderRequest(t, upstream.URL))
		require.NoError(t, err)
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()

		events := log.all()
		require.Len(t, events, 1, "tls=%v: one row per bound request", tls_)
		event := events[0]
		assert.Equal(t, "ws-audit", event.WorkspaceID)
		assert.Equal(t, "127.0.0.1", event.Host)
		assert.Equal(t, http.MethodGet, event.Method)
		assert.Equal(t, http.StatusOK, event.Status)
		assert.True(t, event.Allowed)
		assert.Equal(t, []string{testName}, event.Swapped)
		assert.Equal(t, "/[redacted]", event.Path, "a path that carried a secret is not recorded")
		assert.False(t, event.Time.IsZero())
		assertValueFree(t, events, grant)
	}
}

func TestRelayAuditKeepsAPathThatCarriesNoSecretAndDropsTheQuery(t *testing.T) {
	upstream := httptest.NewServer(echoUpstream(&seen{}))
	t.Cleanup(upstream.Close)
	log := &auditLog{}
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}, Audit: log.add})
	grant, err := relay.Bind("ws-path", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, upstream.URL+"/plain/path?key="+testName, strings.NewReader("x"))
	require.NoError(t, err)
	response, err := proxiedClient(t, grant).Do(req)
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()

	events := log.all()
	require.Len(t, events, 1)
	assert.Equal(t, "/plain/path", events[0].Path)
	assert.Equal(t, http.MethodPost, events[0].Method)
	assert.Equal(t, []string{testName}, events[0].Swapped, "a swapped query still names the secret")
}

func TestRelayAuditsRefusalsWithoutSecretMaterial(t *testing.T) {
	upstream := httptest.NewServer(echoUpstream(&seen{}))
	t.Cleanup(upstream.Close)
	log := &auditLog{}
	relay := newRelay(t, Config{Local: []string{upstream.Listener.Addr().String()}, Audit: log.add})
	grant, err := relay.Bind("ws-refuse", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	client := proxiedClient(t, grant)
	_, port, _ := strings.Cut(upstream.Listener.Addr().String(), ":")

	// A host no binding names.
	response, err := client.Do(placeholderRequest(t, "http://localhost:"+port))
	require.NoError(t, err)
	response.Body.Close()
	// A plaintext request to a bound host that is not the backend's address.
	response, err = client.Do(placeholderRequest(t, "http://127.0.0.1:1"))
	require.NoError(t, err)
	response.Body.Close()
	// A CONNECT to an unbound host.
	connect := client.Transport.(*http.Transport).Clone()
	connect.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // test client
	_, err = (&http.Client{Transport: connect}).Get("https://localhost:" + port + "/x")
	require.Error(t, err)

	events := log.all()
	require.Len(t, events, 3)
	for _, event := range events {
		assert.False(t, event.Allowed)
		assert.Equal(t, http.StatusForbidden, event.Status)
		assert.Equal(t, "ws-refuse", event.WorkspaceID)
		assert.Empty(t, event.Swapped)
	}
	assert.Equal(t, "localhost", events[0].Host)
	assert.Equal(t, http.MethodGet, events[0].Method)
	assert.Equal(t, "/runs/"+testName+"/cache", events[0].Path, "an unswapped path is recorded query-free")
	assert.Equal(t, http.MethodConnect, events[2].Method)
	assertValueFree(t, events, grant)
}

func TestRelayAuditsAFailedForwardAsNotAllowed(t *testing.T) {
	upstream := httptest.NewServer(echoUpstream(&seen{}))
	addr := upstream.Listener.Addr().String()
	log := &auditLog{}
	relay := newRelay(t, Config{Local: []string{addr}, Audit: log.add})
	grant, err := relay.Bind("ws-fail", []sandbox.EgressProxySecret{boundSecret("127.0.0.1")})
	require.NoError(t, err)
	target := upstream.URL
	upstream.Close()

	response, err := proxiedClient(t, grant).Do(placeholderRequest(t, target))
	require.NoError(t, err)
	response.Body.Close()
	events := log.all()
	require.Len(t, events, 1)
	assert.False(t, events[0].Allowed)
	assert.Equal(t, http.StatusBadGateway, events[0].Status)
	assert.Equal(t, []string{testName}, events[0].Swapped)
	assertValueFree(t, events, grant)
}
