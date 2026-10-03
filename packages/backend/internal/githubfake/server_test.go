package githubfake

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func fixture(t *testing.T) (*Server, Config, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	config := Config{AppID: 42, Slug: "smithers-test", OwnerLogin: "acme", OwnerKind: "org", ClientID: "Iv1.fake", ClientSecret: "client-secret-fixture", WebhookSecret: "webhook-secret-fixture", ConversionCode: "one-use-code", PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), Installations: []Installation{{ID: 91, Repositories: []Repository{{ID: 100, FullName: "acme/app"}}}}}
	server, err := New(config)
	require.NoError(t, err)
	t.Cleanup(server.Close)
	return server, config, key
}

func jwt(t *testing.T, key *rsa.PrivateKey, issuer int64, expires time.Time) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{"iss": strconv.FormatInt(issuer, 10), "iat": time.Now().Add(-time.Minute).Unix(), "exp": expires.Unix()})
	require.NoError(t, err)
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	require.NoError(t, err)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func request(t *testing.T, server *Server, method, path, authorization string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, server.URL+path, bytes.NewReader(body))
	require.NoError(t, err)
	if authorization != "" {
		req.Header.Set("Authorization", "Bearer "+authorization)
	}
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, data
}

func TestConversionIsSingleUseAndWriteLogCannotBeMutated(t *testing.T) {
	server, config, _ := fixture(t)
	status, data := request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, http.StatusCreated, status)
	var response map[string]any
	require.NoError(t, json.Unmarshal(data, &response))
	require.Equal(t, config.PrivateKeyPEM, response["pem"])
	require.Equal(t, config.ClientSecret, response["client_secret"])
	require.Equal(t, config.WebhookSecret, response["webhook_secret"])
	status, _ = request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, http.StatusNotFound, status)
	status, _ = request(t, server, "POST", "/app-manifests/foreign/conversions", "", nil)
	require.Equal(t, http.StatusNotFound, status)
	log := server.Writes()
	require.Len(t, log, 3)
	require.Equal(t, []int{201, 404, 404}, []int{log[0].Status, log[1].Status, log[2].Status})
	require.Equal(t, uint64(1), log[0].Sequence)
	log[0].Path = "/corrupted"
	require.Equal(t, "/app-manifests/one-use-code/conversions", server.Writes()[0].Path)
	for _, entry := range log {
		require.NotContains(t, string(entry.Body), config.PrivateKeyPEM)
	}
}

func TestJWTInstallationTokenAndRepositoryBoundaries(t *testing.T) {
	server, config, key := fixture(t)
	good := jwt(t, key, config.AppID, time.Now().Add(5*time.Minute))
	for _, token := range []string{"", "not-a-jwt", jwt(t, key, 999, time.Now().Add(5*time.Minute)), jwt(t, key, config.AppID, time.Now().Add(-time.Minute))} {
		status, _ := request(t, server, "GET", "/app", token, nil)
		require.Equal(t, http.StatusUnauthorized, status)
	}
	for _, path := range []string{"/app", "/app/installations", "/repos/acme/app/installation"} {
		status, data := request(t, server, "GET", path, good, nil)
		require.Equal(t, http.StatusOK, status, string(data))
	}
	status, _ := request(t, server, "GET", "/repos/acme/missing/installation", good, nil)
	require.Equal(t, http.StatusNotFound, status)
	status, _ = request(t, server, "POST", "/app/installations/999/access_tokens", good, nil)
	require.Equal(t, http.StatusNotFound, status)
	status, data := request(t, server, "POST", "/app/installations/91/access_tokens", good, []byte(`{"permissions":{"contents":"read"}}`))
	require.Equal(t, http.StatusCreated, status, string(data))
	var token struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	require.NoError(t, json.Unmarshal(data, &token))
	require.NotEmpty(t, token.Token)
	require.True(t, token.ExpiresAt.After(time.Now()))
	status, _ = request(t, server, "GET", "/installation/repositories", good, nil)
	require.Equal(t, http.StatusUnauthorized, status)
	status, data = request(t, server, "GET", "/installation/repositories", token.Token, nil)
	require.Equal(t, http.StatusOK, status)
	var inventory struct {
		TotalCount   int          `json:"total_count"`
		Repositories []Repository `json:"repositories"`
	}
	require.NoError(t, json.Unmarshal(data, &inventory))
	require.Equal(t, 1, inventory.TotalCount)
	require.Equal(t, "acme/app", inventory.Repositories[0].FullName)
	log := server.Writes()
	require.Len(t, log, 2)
	require.JSONEq(t, `{"permissions":{"contents":"read"}}`, string(log[1].Body))
	log[1].Body[0] = 'x'
	require.Equal(t, byte('{'), server.Writes()[1].Body[0])
}

func TestInvalidKeyIsRefused(t *testing.T) {
	_, err := New(Config{AppID: 1, PrivateKeyPEM: "bad-key"})
	require.Error(t, err)
}

func TestKeyFormatsAndConfigurationIsolation(t *testing.T) {
	_, config, key := fixture(t)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)
	config.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	server, err := New(config)
	require.NoError(t, err)
	t.Cleanup(server.Close)
	config.Installations[0].Repositories[0].FullName = "acme/changed"
	status, _ := request(t, server, "GET", "/repos/acme/app/installation", jwt(t, key, config.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 200, status)
	config.AppID = 0
	_, err = New(config)
	require.Error(t, err)
	config.AppID = 42
	config.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("invalid-der")}))
	_, err = New(config)
	require.Error(t, err)
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	der, err = x509.MarshalPKCS8PrivateKey(ecKey)
	require.NoError(t, err)
	config.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	_, err = New(config)
	require.Error(t, err)
}

func TestMalformedAndForgedJWTsAreRefused(t *testing.T) {
	server, config, key := fixture(t)
	good := jwt(t, key, config.AppID, time.Now().Add(time.Minute))
	parts := strings.Split(good, ".")
	encode := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, token := range []string{
		"%." + parts[1] + "." + parts[2], encode(`{"alg":"HS256"}`) + "." + parts[1] + "." + parts[2],
		encode(`bad-json`) + "." + parts[1] + "." + parts[2], parts[0] + ".%." + parts[2],
		parts[0] + "." + encode(`bad-json`) + "." + parts[2], parts[0] + "." + parts[1] + ".%",
		parts[0] + "." + parts[1] + "." + encode("wrong-signature"),
	} {
		status, _ := request(t, server, "GET", "/app", token, nil)
		require.Equal(t, http.StatusUnauthorized, status)
	}
	req, err := http.NewRequest("GET", server.URL+"/app", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", good)
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	status, _ := request(t, server, "GET", "/unknown", good, nil)
	require.Equal(t, http.StatusNotFound, status)
}

type unreadableBody struct{}

func (unreadableBody) Read([]byte) (int, error) { return 0, errors.New("body interrupted") }
func (unreadableBody) Close() error             { return nil }

func TestInterruptedWriteStillGetsPermanentReceipt(t *testing.T) {
	server, _, _ := fixture(t)
	req := httptest.NewRequest(http.MethodPost, "/app-manifests/one-use-code/conversions", nil)
	req.Body = unreadableBody{}
	response := httptest.NewRecorder()
	server.serveHTTP(response, req)
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Len(t, server.Writes(), 1)
	require.Equal(t, http.StatusBadRequest, server.Writes()[0].Status)
	status, _ := request(t, server, "POST", "/app-manifests/one-use-code/conversions", "", nil)
	require.Equal(t, http.StatusCreated, status, "unreadable request must not consume code")
}

func TestPaginationAndUserOwner(t *testing.T) {
	_, config, key := fixture(t)
	config.OwnerKind = "user"
	config.Installations = []Installation{}
	for i := 0; i < 101; i++ {
		config.Installations = append(config.Installations, Installation{ID: int64(i + 1), Account: Account{Login: "ada"}, Repositories: []Repository{{ID: int64(i + 1), FullName: "ada/app"}}})
	}
	server, err := New(config)
	require.NoError(t, err)
	t.Cleanup(server.Close)
	token := jwt(t, key, config.AppID, time.Now().Add(time.Minute))
	for _, tc := range []struct {
		query  string
		length int
	}{
		{"?per_page=100&page=1", 100}, {"?per_page=100&page=2", 1}, {"?per_page=100&page=3", 0},
		{"?per_page=101&page=0", 30}, {"?per_page=0&page=-1", 30},
	} {
		status, data := request(t, server, "GET", "/app/installations"+tc.query, token, nil)
		require.Equal(t, 200, status)
		var installations []Installation
		require.NoError(t, json.Unmarshal(data, &installations))
		require.Len(t, installations, tc.length)
	}
	status, data := request(t, server, "GET", "/app", token, nil)
	require.Equal(t, 200, status)
	var app struct {
		Owner struct {
			Type string `json:"type"`
		} `json:"owner"`
	}
	require.NoError(t, json.Unmarshal(data, &app))
	require.Equal(t, "User", app.Owner.Type)
}
