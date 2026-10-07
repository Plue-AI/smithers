package compose

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/stretchr/testify/require"
)

// The installed launcher already accepts an owner's HTTPS proxy and CA file.
// Exercise that production boundary instead of forwarding test-only SMITHERS
// endpoint overrides. Only the two GitHub authorities are accepted; no request
// from this fixture can reach the public network.
func isolationGitHubProxy(t *testing.T, root string) (proxyURL, caFile string) {
	t.Helper()
	return isolationGitHubProxyFor(t, root, "", nil)
}

// isolationGitHubProxyFor also hosts the installations' repositories, whose
// Git objects live under gitRoot as <owner>/<repo>.git.
func isolationGitHubProxyFor(t *testing.T, root, gitRoot string, installations []githubfake.Installation) (proxyURL, caFile string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	fake, err := githubfake.New(githubfake.Config{AppID: 42, Slug: "isolation-check", OwnerLogin: "isolation-owner", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PrivateKeyPEM: privateKey, ConversionCode: "manifest-code", OAuthCode: "owner-code", GitRoot: gitRoot, Installations: installations})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "C-SEC-02 fixture"}, DNSNames: []string{"github.com", "api.github.com"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	require.NoError(t, err)
	certificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	caFile = filepath.Join(root, "github-fixture-ca.pem")
	require.NoError(t, os.WriteFile(caFile, certificate, 0600))
	pair, err := tls.X509KeyPair(certificate, []byte(privateKey))
	require.NoError(t, err)
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	served := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "github.com" && r.Host != "api.github.com" {
			http.Error(w, "authority refused", 403)
			return
		}
		request, err := http.NewRequestWithContext(r.Context(), r.Method, fake.URL+r.URL.RequestURI(), r.Body)
		if err != nil {
			http.Error(w, "request failed", 502)
			return
		}
		request.Header = r.Header.Clone()
		response, err := transport.RoundTrip(request)
		if err != nil {
			http.Error(w, "fixture failed", 502)
			return
		}
		defer response.Body.Close()
		for key, values := range response.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	}))
	served.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	served.StartTLS()
	t.Cleanup(served.Close)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || (r.Host != "github.com:443" && r.Host != "api.github.com:443") {
			http.Error(w, "authority refused", 403)
			return
		}
		upstream, err := net.DialTimeout("tcp", served.Listener.Addr().String(), time.Second)
		if err != nil {
			http.Error(w, "fixture failed", 502)
			return
		}
		downstream, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		defer downstream.Close()
		defer upstream.Close()
		_ = downstream.SetDeadline(time.Now().Add(30 * time.Second))
		_ = upstream.SetDeadline(time.Now().Add(30 * time.Second))
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		done := make(chan struct{})
		go func() { _, _ = io.Copy(upstream, buffered); upstream.Close(); close(done) }()
		_, _ = io.Copy(downstream, upstream)
		downstream.Close()
		<-done
	}))
	t.Cleanup(proxy.Close)
	return proxy.URL, caFile
}

func TestCSEC02GitHubProxyUsesVerifiedTLSAndRefusesOtherAuthorities(t *testing.T) {
	proxy, ca := isolationGitHubProxy(t, t.TempDir())
	data, err := os.ReadFile(ca)
	require.NoError(t, err)
	roots := x509.NewCertPool()
	require.True(t, roots.AppendCertsFromPEM(data))
	proxyURL, err := url.Parse(proxy)
	require.NoError(t, err)
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, err := client.Get("https://api.github.com/users/isolation-owner")
	require.NoError(t, err)
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.Equal(t, 200, response.StatusCode)
	require.Contains(t, string(body), "isolation-owner")

	// Exercise the actual fixture surfaces consumed by the bundled claim,
	// including refusal controls. A TLS listener alone is not an OAuth fixture.
	post := func(path, form string, expected int) []byte {
		t.Helper()
		response, err := client.Post("https://github.com"+path, "application/x-www-form-urlencoded", strings.NewReader(form))
		require.NoError(t, err)
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, expected, response.StatusCode)
		return data
	}
	post("/app-manifests/wrong-code/conversions", "", 404)
	conversion := post("/app-manifests/manifest-code/conversions", "", 201)
	var app struct {
		ClientID string `json:"client_id"`
	}
	require.NoError(t, json.Unmarshal(conversion, &app))
	require.Equal(t, "client", app.ClientID)
	post("/login/oauth/access_token", "client_id=client&client_secret=wrong&code=owner-code&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fauth%2Fgithub%2Fcallback", 401)
	credentials := post("/login/oauth/access_token", "client_id=client&client_secret=secret&code=owner-code&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fauth%2Fgithub%2Fcallback", 200)
	var token struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(credentials, &token))
	require.NotEmpty(t, token.AccessToken)
	request, err := http.NewRequest("GET", "https://api.github.com/user", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	identity, err := client.Do(request)
	require.NoError(t, err)
	require.Equal(t, 200, identity.StatusCode)
	var user struct{ Login string }
	require.NoError(t, json.NewDecoder(identity.Body).Decode(&user))
	require.NoError(t, identity.Body.Close())
	require.Equal(t, "isolation-owner", user.Login)
	post("/login/oauth/access_token", "client_id=client&client_secret=secret&code=owner-code&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fauth%2Fgithub%2Fcallback", 401)
	_, err = client.Get("https://example.com/")
	require.ErrorContains(t, err, "Forbidden")
	untrusted := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer untrusted.CloseIdleConnections()
	_, err = (&http.Client{Transport: untrusted, Timeout: 5 * time.Second}).Get("https://api.github.com/users/isolation-owner")
	require.ErrorContains(t, err, "certificate")
}
