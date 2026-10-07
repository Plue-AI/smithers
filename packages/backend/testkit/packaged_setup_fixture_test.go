package testkit

// This subprocess fixture supplies only the external GitHub boundary. The
// installed launcher, private PostgreSQL, owner transaction and cookies are real.
import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestPackagedSetupGitHubFixture(t *testing.T) {
	root := os.Getenv("SMITHERS_PACKAGED_FIXTURE_ROOT")
	if root == "" {
		t.Skip("subprocess fixture requires its disposable root")
	}
	origin := os.Getenv("SMITHERS_PACKAGED_FIXTURE_ORIGIN")
	state := filepath.Join(root, "home", "Library", "Application Support", "Smithers")
	seed, err := githubfake.LocalSeed()
	require.NoError(t, err)
	fake, err := githubfake.New(seed)
	require.NoError(t, err)
	defer fake.Close()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "packaged setup fixture"}, DNSNames: []string{"github.com", "api.github.com"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	require.NoError(t, err)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	certPath := filepath.Join(root, "fixture-ca.pem")
	require.NoError(t, os.WriteFile(certPath, certPEM, 0600))
	pair, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	require.NoError(t, err)
	// All proxy traffic terminates locally. There is no dial to GitHub.
	secure := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target, _ := url.Parse(fake.URL + r.URL.RequestURI())
		r.URL = target
		r.RequestURI = ""
		response, err := http.DefaultTransport.RoundTrip(r)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		defer response.Body.Close()
		for name, values := range response.Header {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	}))
	secure.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	secure.StartTLS()
	defer secure.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || (r.Host != "github.com:443" && r.Host != "api.github.com:443") {
			w.WriteHeader(403)
			return
		}
		upstream, err := net.Dial("tcp", secure.Listener.Addr().String())
		if err != nil {
			w.WriteHeader(502)
			return
		}
		downstream, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		go func() { defer upstream.Close(); _, _ = io.Copy(upstream, buffered) }()
		_, _ = io.Copy(downstream, upstream)
		downstream.Close()
	}))
	defer proxy.Close()
	connect := func(ctx context.Context) (*pgxpool.Pool, error) {
		pid, err := os.ReadFile(filepath.Join(state, "postgres", "data", "postmaster.pid"))
		if err != nil {
			return nil, err
		}
		lines := strings.Split(string(pid), "\n")
		if len(lines) < 4 {
			return nil, fmt.Errorf("invalid owned postmaster record")
		}
		password, err := os.ReadFile(filepath.Join(state, "postgres", "password"))
		if err != nil {
			return nil, err
		}
		u := url.URL{Scheme: "postgres", User: url.UserPassword("smithers", string(password)), Host: net.JoinHostPort("127.0.0.1", strings.TrimSpace(lines[3])), Path: "/postgres", RawQuery: "sslmode=disable"}
		return pgxpool.New(ctx, u.String())
	}
	jar, _ := cookiejar.New(nil)
	ownerClient := &http.Client{Jar: jar, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		operation := func() (any, error) {
			pool, err := connect(ctx)
			if err != nil {
				return nil, err
			}
			defer pool.Close()
			if r.URL.Path == "/persistence" {
				return packagedSetupPersistence(ctx, pool)
			}
			if r.URL.Path == "/status" {
				var owners, sessions int
				var digest string
				if err = pool.QueryRow(ctx, `SELECT count(*) FROM self_host_owners`).Scan(&owners); err != nil {
					return nil, err
				}
				if err = pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key LIKE 'setup.session.%'`).Scan(&sessions); err != nil {
					return nil, err
				}
				if err = pool.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='setup.token'`).Scan(&digest); err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return nil, err
				}
				return map[string]any{"owners": owners, "sessions": sessions, "digest": digest}, nil
			}
			if r.URL.Path == "/owner" {
				install, err := ownerClient.Get(origin + "/api/install")
				if err != nil {
					return nil, err
				}
				install.Body.Close()
				status, err := ownerClient.Get(origin + "/api/status")
				if err != nil {
					return nil, err
				}
				body, err := io.ReadAll(status.Body)
				status.Body.Close()
				if err != nil {
					return nil, err
				}
				return map[string]any{"install": install.StatusCode, "status": status.StatusCode, "provisional": strings.Contains(string(body), `"owner_unverified"`)}, nil
			}
			if r.URL.Path != "/claim" || r.Method != "POST" {
				return nil, fmt.Errorf("unsupported fixture request")
			}
			values := map[string]string{}
			bytes, err := os.ReadFile(filepath.Join(state, "config", "secrets.json"))
			if err != nil {
				return nil, err
			}
			if err = json.Unmarshal(bytes, &values); err != nil {
				return nil, err
			}
			codec, err := webhook.NewSecretCodec(values["SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"])
			if err != nil {
				return nil, err
			}
			// Register the App at the external fixture; never write an owner/session.
			response, err := http.PostForm(fake.URL+"/settings/apps/new", url.Values{"manifest": {`{"redirect_url":"` + origin + `/setup/github/callback","callback_urls":["` + origin + `/api/auth/github/callback"],"default_permissions":{"emails":"read","contents":"write","metadata":"read"}}`}})
			if err != nil {
				return nil, err
			}
			response.Body.Close()
			response, err = http.Post(fake.URL+"/app-manifests/"+seed.ConversionCode+"/conversions", "application/json", nil)
			if err != nil {
				return nil, err
			}
			response.Body.Close()
			store := services.NewGitHubAppCredentialStore(pool, codec)
			if err = store.Save(ctx, services.GitHubAppCredentials{ID: seed.AppID, Slug: seed.Slug, OwnerLogin: seed.OwnerLogin, OwnerKind: seed.OwnerKind, ClientID: seed.ClientID, ClientSecret: seed.ClientSecret, WebhookSecret: seed.WebhookSecret, PEM: seed.PrivateKeyPEM}); err != nil {
				return nil, err
			}
			if err = store.SaveCallbackURLs(ctx, []string{origin + "/api/auth/github/callback"}); err != nil {
				return nil, err
			}
			client := ownerClient
			var input struct{ Token string }
			if err = json.NewDecoder(r.Body).Decode(&input); err != nil {
				return nil, err
			}
			get := func(path string, status int) (*http.Response, error) {
				res, e := client.Get(origin + path)
				if e != nil {
					return nil, e
				}
				if res.StatusCode != status {
					res.Body.Close()
					return nil, fmt.Errorf("owner HTTP boundary returned %d; expected %d", res.StatusCode, status)
				}
				return res, nil
			}
			response, err = get("/setup?token="+url.QueryEscape(input.Token), 303)
			if err != nil {
				return nil, err
			}
			credentials := []string{}
			for _, cookie := range response.Cookies() {
				if cookie.Value != "" {
					credentials = append(credentials, cookie.Value)
				}
			}
			response.Body.Close()
			response, err = get("/api/auth/github", 302)
			if err != nil {
				return nil, err
			}
			location := response.Header.Get("Location")
			response.Body.Close()
			target, err := url.Parse(location)
			if err != nil {
				return nil, err
			}
			// Only the browser's GitHub hop goes directly to the external fake.
			response, err = http.Get(fake.URL + target.RequestURI())
			if err != nil {
				return nil, err
			}
			page, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				return nil, err
			}
			href := strings.Split(string(page), `href="`)
			if len(href) < 2 {
				return nil, fmt.Errorf("GitHub fake did not offer callback")
			}
			callback, err := url.Parse(strings.ReplaceAll(strings.Split(href[1], `"`)[0], "&amp;", "&"))
			if err != nil {
				return nil, err
			}
			response, err = get(callback.RequestURI(), 302)
			if err != nil {
				return nil, err
			}
			for _, cookie := range response.Cookies() {
				if cookie.Value != "" {
					credentials = append(credentials, cookie.Value)
				}
			}
			response.Body.Close()
			return map[string]any{"claimed": true, "credentials": credentials}, nil
		}
		body, err := operation()
		if err != nil {
			w.WriteHeader(500)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "packaged fixture operation failed"})
			fmt.Fprintln(os.Stderr, "packaged fixture failed at", r.URL.Path)
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer control.Close()
	if os.Getenv("SMITHERS_PACKAGED_FIXTURE_SMOKE") == "1" {
		roots := x509.NewCertPool()
		require.True(t, roots.AppendCertsFromPEM(certPEM))
		proxyURL, err := url.Parse(proxy.URL)
		require.NoError(t, err)
		transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
		response, err := client.Get("https://api.github.com/users/" + seed.OwnerLogin)
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode)
		response.Body.Close()
		response, err = client.Get("http://outside.invalid/")
		require.NoError(t, err)
		require.Equal(t, 403, response.StatusCode)
		response.Body.Close()
		response, err = http.Get(control.URL + "/status")
		require.NoError(t, err)
		require.Equal(t, 500, response.StatusCode)
		response.Body.Close()
		return
	}
	ready, _ := json.Marshal(map[string]string{"control": control.URL, "proxy": proxy.URL, "cert": certPath})
	require.NoError(t, os.WriteFile(filepath.Join(root, "fixture-ready.json"), ready, 0600))
	fmt.Println("PACKAGED_FIXTURE=" + string(ready))
	// go test does not forward its stdin to the test binary. Keep the external
	// fixture alive until the launcher harness writes its completion marker.
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(root, "fixture-stop")); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("packaged fixture completion marker timed out")
}

func TestPackagedSetupGitHubFixtureProxy(t *testing.T) {
	t.Setenv("SMITHERS_PACKAGED_FIXTURE_ROOT", t.TempDir())
	t.Setenv("SMITHERS_PACKAGED_FIXTURE_SMOKE", "1")
	TestPackagedSetupGitHubFixture(t)
}

func TestPackagedSetupGitHubFixtureLifetime(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SMITHERS_PACKAGED_FIXTURE_ROOT", root)
	t.Setenv("SMITHERS_PACKAGED_FIXTURE_SMOKE", "")
	done := make(chan struct{})
	go func() { defer close(done); TestPackagedSetupGitHubFixture(t) }()
	stop := func() { _ = os.WriteFile(filepath.Join(root, "fixture-stop"), []byte("done\n"), 0600) }
	t.Cleanup(func() { stop(); <-done })
	readyPath := filepath.Join(root, "fixture-ready.json")
	require.Eventually(t, func() bool { _, err := os.Stat(readyPath); return err == nil }, 10*time.Second, 50*time.Millisecond)
	var ready struct {
		Control string `json:"control"`
	}
	raw, err := os.ReadFile(readyPath)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &ready))
	select {
	case <-done:
		t.Fatal("fixture exited before completion marker")
	default:
	}
	for _, path := range []string{"/status", "/persistence"} {
		response, err := http.Get(ready.Control + path)
		require.NoError(t, err)
		require.Equal(t, 500, response.StatusCode, "live external boundary reports absent private database")
		response.Body.Close()
	}
	stop()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("fixture did not stop")
	}
}

// The observer reads the launcher's own database without changing its rows.
func packagedSetupPersistence(ctx context.Context, pool *pgxpool.Pool) (any, error) {
	var version int
	if err := pool.QueryRow(ctx, `SELECT current_setting('server_version_num')::integer`).Scan(&version); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT key, value::text FROM install_settings WHERE key LIKE 'setup.session.%' ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		sessions[key] = value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"version": version, "sessions": sessions}, nil
}

func TestPackagedSetupPersistenceObserverPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	empty, err := packagedSetupPersistence(ctx, pool)
	require.NoError(t, err)
	value := empty.(map[string]any)
	require.GreaterOrEqual(t, value["version"].(int), 180000)
	require.Less(t, value["version"].(int), 190000)
	require.Equal(t, map[string]string{}, value["sessions"])
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES
		('setup.session.first','{"expires_at":"2026-10-08T00:00:00Z"}'),
		('setup.session.second','{"expires_at":"2026-10-09T00:00:00Z"}'),
		('setup.token','"not-a-session"'),('setup.step.sign_in','{"state":"done"}')`)
	require.NoError(t, err)
	var before, after string
	const allRows = `SELECT jsonb_agg(to_jsonb(s) ORDER BY key)::text FROM install_settings s`
	require.NoError(t, pool.QueryRow(ctx, allRows).Scan(&before))
	snapshot, err := packagedSetupPersistence(ctx, pool)
	require.NoError(t, err)
	require.Equal(t, map[string]string{
		"setup.session.first":  `{"expires_at": "2026-10-08T00:00:00Z"}`,
		"setup.session.second": `{"expires_at": "2026-10-09T00:00:00Z"}`,
	}, snapshot.(map[string]any)["sessions"])
	require.NoError(t, pool.QueryRow(ctx, allRows).Scan(&after))
	require.Equal(t, before, after, "observer must preserve values and timestamps")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	failed, err := packagedSetupPersistence(cancelled, pool)
	require.Error(t, err)
	require.Nil(t, failed, "failed observations supply no passing snapshot")
}
