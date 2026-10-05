package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func manifestFixture(t *testing.T) (*githubfake.Server, GitHubAppCredentials) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	credentials := GitHubAppCredentials{ID: 42, Slug: "smithers-integration", OwnerLogin: "acme", OwnerKind: "org", ClientID: "Iv1.integration", ClientSecret: "client-secret-never-in-dump", WebhookSecret: "webhook-secret-never-in-dump", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	server, err := githubfake.New(githubfake.Config{AppID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin, OwnerKind: credentials.OwnerKind, PrivateKeyPEM: credentials.PEM, ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, WebhookSecret: credentials.WebhookSecret, ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}}, {ID: 92, Repositories: []githubfake.Repository{{ID: 101, FullName: "acme/other"}}}}})
	require.NoError(t, err)
	t.Cleanup(server.Close)
	return server, credentials
}

func TestGitHubAppCredentialsConversionSealedDumpRestartAndReplayPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	databaseURL := pool.Config().ConnString()
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	server, expected := manifestFixture(t)
	codec, err := webhook.NewSecretCodec("durable-install-sealing-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	service := NewGitHubAppManifestService(pool, store, server.URL, func() []string { return []string{"http://mini.local:4000"} })
	start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	require.NotEmpty(t, start.State)
	installURL, err := service.Convert(ctx, "manifest-code", start.State, start.State)
	require.NoError(t, err)
	require.Equal(t, "https://github.com/apps/smithers-integration/installations/new", installURL)
	actual, err := store.Load(ctx)
	require.NoError(t, err)
	require.Equal(t, expected, actual)

	var sealedPEM, sealedClient, sealedWebhook string
	require.NoError(t, pool.QueryRow(ctx, `SELECT pem_sealed, client_secret_sealed, webhook_secret_sealed FROM github_app`).Scan(&sealedPEM, &sealedClient, &sealedWebhook))
	for _, pair := range [][2]string{{sealedPEM, expected.PEM}, {sealedClient, expected.ClientSecret}, {sealedWebhook, expected.WebhookSecret}} {
		require.NotEqual(t, pair[1], pair[0])
		opened, err := codec.DecryptString(pair[0])
		require.NoError(t, err)
		require.Equal(t, pair[1], opened)
	}
	dump, err := exec.CommandContext(ctx, "pg_dump", "--no-owner", "--no-privileges", databaseURL).Output()
	require.NoError(t, err, "real pg_dump must run")
	for _, secret := range []string{"PRIVATE KEY", expected.PEM, expected.ClientSecret, expected.WebhookSecret} {
		require.NotContains(t, string(dump), secret)
	}
	t.Logf("pg_dump scanned %d bytes: no private key, client secret, or webhook secret", len(dump))

	// Close the old connection pool and reconstruct the store with the durable
	// database URL and install key, as a fresh backend process does.
	pool.Close()
	restartedPool, err := postgresfixture.Open(ctx, databaseURL, 0)
	require.NoError(t, err)
	t.Cleanup(restartedPool.Close)
	restartedCodec, err := webhook.NewSecretCodec("durable-install-sealing-key")
	require.NoError(t, err)
	restarted := NewGitHubAppCredentialStore(restartedPool, restartedCodec)
	reloaded, err := restarted.Load(ctx)
	require.NoError(t, err)
	require.Equal(t, expected, reloaded)
	service = NewGitHubAppManifestService(restartedPool, restarted, server.URL, nil)
	require.NoError(t, service.ResumeInstallation(ctx))
	reloaded, err = restarted.Load(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(91), reloaded.InstallationID)
	jwt := reloadedAppJWTFromProcess(t, databaseURL, "durable-install-sealing-key", expected.ID)
	req, err := http.NewRequest(http.MethodPost, server.URL+"/app/installations/91/access_tokens", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+jwt)
	response, err := server.Client().Do(req)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusCreated, response.StatusCode)
	var token struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&token))
	require.NotEmpty(t, token.Token)
	writes := len(server.Writes())
	_, err = service.Convert(ctx, "another-code", start.State, start.State)
	require.Error(t, err)
	_, err = service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.Error(t, err)
	require.Equal(t, writes, len(server.Writes()), "a replay must not contact GitHub")
	t.Logf("fresh OS process reloaded sealed credentials; minted installation token; replay refused without a GitHub write")
}

type credentialReloadResult struct {
	ID         int64  `json:"id"`
	JWT        string `json:"jwt"`
	HasOAuth   bool   `json:"has_oauth"`
	HasWebhook bool   `json:"has_webhook"`
}

// This is the entry point for a fresh test-binary process, outside TestMain's
// fixture creation. Credentials cross no environment or stdout boundary.
func TestCredentialReloadProcessHelper(t *testing.T) {
	if os.Getenv("SMITHERS_TEST_GH_RELOAD_CHILD") != "1" {
		return
	}
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	pool, err := postgresfixture.Open(ctx, os.Getenv("SMITHERS_TEST_GH_RELOAD_DATABASE_URL"), 1)
	require.NoError(t, err)
	defer pool.Close()
	codec, err := webhook.NewSecretCodec(os.Getenv("SMITHERS_TEST_GH_RELOAD_INSTALL_KEY"))
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	loaded, err := store.Load(ctx)
	require.NoError(t, err)
	jwt, err := store.AppJWT(ctx)
	require.NoError(t, err)
	pipe := os.NewFile(3, "credential-reload-result")
	require.NotNil(t, pipe)
	defer pipe.Close()
	require.NoError(t, json.NewEncoder(pipe).Encode(credentialReloadResult{ID: loaded.ID, JWT: jwt, HasOAuth: loaded.ClientID != "" && loaded.ClientSecret != "", HasWebhook: loaded.WebhookSecret != ""}))
}

func reloadedAppJWTFromProcess(t *testing.T, databaseURL, installKey string, appID int64) string {
	t.Helper()
	binary, err := os.Executable()
	require.NoError(t, err)
	reader, writer, err := os.Pipe()
	require.NoError(t, err)
	defer reader.Close()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "-test.run", "^TestCredentialReloadProcessHelper$")
	for _, entry := range os.Environ() {
		name := strings.SplitN(entry, "=", 2)[0]
		if name == "SMITHERS_TEST_DATABASE_URL" || name == "SMITHERS_REQUIRE_DATABASE_TESTS" || strings.HasPrefix(name, "SMITHERS_GITHUB_APP_") {
			continue
		}
		command.Env = append(command.Env, entry)
	}
	command.Env = append(command.Env, "SMITHERS_TEST_DATABASE_URL=", "SMITHERS_REQUIRE_DATABASE_TESTS=0", "SMITHERS_TEST_GH_RELOAD_CHILD=1", "SMITHERS_TEST_GH_RELOAD_DATABASE_URL="+databaseURL, "SMITHERS_TEST_GH_RELOAD_INSTALL_KEY="+installKey)
	command.ExtraFiles = []*os.File{writer}
	output, err := command.CombinedOutput()
	require.NoError(t, err, "fresh process failed: %s", output)
	require.NoError(t, writer.Close())
	var result credentialReloadResult
	require.NoError(t, json.NewDecoder(reader).Decode(&result))
	require.Equal(t, appID, result.ID)
	require.True(t, result.HasOAuth)
	require.True(t, result.HasWebhook)
	require.NotEmpty(t, result.JWT)
	require.NotContains(t, string(output), result.JWT, "child stdout must not contain credentials")
	t.Logf("separate OS process pid=%d loaded the sealed App and signed an App JWT through a private pipe", command.ProcessState.Pid())
	return result.JWT
}

func TestGitHubAppManifestRefusesForeignExpiredAndUsedStateWithoutExchangePostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	server, _ := manifestFixture(t)
	codec, err := webhook.NewSecretCodec("state-test-key")
	require.NoError(t, err)
	service := NewGitHubAppManifestService(pool, NewGitHubAppCredentialStore(pool, codec), server.URL, nil)
	for _, kind := range []string{"foreign", "unknown", "expired", "used"} {
		t.Run(kind, func(t *testing.T) {
			_, resetErr := pool.Exec(ctx, `DELETE FROM install_settings WHERE key='setup.step.app_manifest'`)
			require.NoError(t, resetErr)
			start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
			require.NoError(t, err)
			state, browser := start.State, start.State
			switch kind {
			case "foreign":
				browser = "another-browser"
			case "unknown":
				state, browser = strings.Repeat("c", 64), strings.Repeat("c", 64)
			case "expired":
				_, err = pool.Exec(ctx, `UPDATE github_app_manifest_states SET expires_at = now() - interval '1 second' WHERE digest = $1`, GitHubAppStateDigest(state))
			case "used":
				_, err = pool.Exec(ctx, `UPDATE github_app_manifest_states SET used_at = now() WHERE digest = $1`, GitHubAppStateDigest(state))
			}
			require.NoError(t, err)
			_, err = service.Convert(ctx, "manifest-code", state, browser)
			require.Error(t, err)
			require.Empty(t, server.Writes(), "state refusal must precede code exchange")
		})
	}
}

func TestGitHubAppCredentialSingletonConcurrentWritersPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	server, credentials := manifestFixture(t)
	_ = server
	codec, err := webhook.NewSecretCodec("singleton-test-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < cap(errors); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errors <- store.Save(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), credentials)
		}()
	}
	wg.Wait()
	close(errors)
	success := 0
	for err := range errors {
		if err == nil {
			success++
		} else {
			require.ErrorIs(t, err, ErrGitHubAppAlreadyConfigured)
		}
	}
	require.Equal(t, 1, success)
	loaded, err := store.Load(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
	require.NoError(t, err)
	require.Equal(t, credentials, loaded)
}

func TestGitHubAppManifestConversionWorksWithOneDatabaseConnectionPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	databaseURL := pool.Config().ConnString()
	pool.Close()
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	single, err := postgresfixture.Open(ctx, databaseURL, 1)
	require.NoError(t, err)
	t.Cleanup(single.Close)
	server, _ := manifestFixture(t)
	codec, err := webhook.NewSecretCodec("single-connection-key")
	require.NoError(t, err)
	service := NewGitHubAppManifestService(single, NewGitHubAppCredentialStore(single, codec), server.URL, nil)
	start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err = service.Convert(bounded, "manifest-code", start.State, start.State)
	require.NoError(t, err, "conversion must not hold the only connection while waiting for a second")
}

func TestGitHubAppManifestFailedAttemptCannotBindSuccessfulAppPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	server, _ := manifestFixture(t)
	codec, err := webhook.NewSecretCodec("failed-attempt-key")
	require.NoError(t, err)
	service := NewGitHubAppManifestService(pool, NewGitHubAppCredentialStore(pool, codec), server.URL, nil)
	failed, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "other"})
	require.NoError(t, err)
	_, err = service.Convert(ctx, "wrong-code", failed.State, failed.State)
	require.Error(t, err)
	_, err = service.Convert(ctx, "manifest-code", failed.State, failed.State)
	require.Error(t, err, "failed code exchange permanently consumes state")
	require.Len(t, server.Writes(), 1)
	successful, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	_, err = service.Convert(ctx, "manifest-code", successful.State, successful.State)
	require.NoError(t, err)
	writes := len(server.Writes())
	require.Error(t, service.ValidateCallbackOrigin(ctx, failed.State, "http://localhost:4000"), "failed attempt cannot choose the successful App repository")
	require.Equal(t, writes, len(server.Writes()))
	require.NoError(t, service.ResumeInstallation(ctx), "untrusted redirect cannot override server-derived repository installation")
	require.NoError(t, service.ResumeInstallation(ctx), "installation fallback must find selected repository")
}

func TestGitHubAppCredentialOperatorKeyRotationPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	_, credentials := manifestFixture(t)
	old, err := webhook.NewSecretCodec("old-install-key")
	require.NoError(t, err)
	require.NoError(t, NewGitHubAppCredentialStore(pool, old).Save(ctx, credentials))
	rotating, err := webhook.NewSecretCodec("new-install-key", "old-install-key")
	require.NoError(t, err)
	counts, err := ResealOperatorKeySecrets(ctx, pool, rotating)
	require.NoError(t, err)
	matched := 0
	for _, count := range counts {
		if count.Store == "github_app.pem_sealed" || count.Store == "github_app.webhook_secret_sealed" || count.Store == "github_app.client_secret_sealed" {
			require.EqualValues(t, 1, count.Resealed)
			matched++
		}
	}
	require.Equal(t, 3, matched)
	current, err := webhook.NewSecretCodec("new-install-key")
	require.NoError(t, err)
	loaded, err := NewGitHubAppCredentialStore(pool, current).Load(ctx)
	require.NoError(t, err)
	require.Equal(t, credentials, loaded)
	_, err = NewGitHubAppCredentialStore(pool, old).Load(ctx)
	require.Error(t, err, "retired key must no longer decrypt credentials")
}

func TestGitHubAppManifestConcurrentConversionsExchangeOnlyOncePostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	server, _ := manifestFixture(t)
	codec, err := webhook.NewSecretCodec("concurrent-conversion-key")
	require.NoError(t, err)
	service := NewGitHubAppManifestService(pool, NewGitHubAppCredentialStore(pool, codec), server.URL, nil)
	start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	var attempts []GitHubAppManifestStart
	for i := 0; i < 8; i++ {
		attempts = append(attempts, start)
	}
	var wg sync.WaitGroup
	errors := make(chan error, len(attempts))
	for _, start := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			_, err := service.Convert(bounded, "manifest-code", start.State, start.State)
			errors <- err
		}()
	}
	wg.Wait()
	close(errors)
	successes := 0
	for err := range errors {
		if err == nil {
			successes++
		} else {
			var refusal *pkgerrors.APIError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, http.StatusConflict, refusal.Status, "competing conversion must be refused without a timeout or storage error")
		}
	}
	require.Equal(t, 1, successes)
	require.Len(t, server.Writes(), 1, "only one GitHub App may be created across concurrent backend calls")
}

func TestGitHubAppManifestInstallationPaginationPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	_, credentials := manifestFixture(t)
	installations := make([]githubfake.Installation, 101)
	for i := range installations {
		installations[i] = githubfake.Installation{ID: int64(i + 1), Account: githubfake.Account{Login: "another-owner"}}
	}
	repos := make([]githubfake.Repository, 101)
	for i := range repos {
		repos[i] = githubfake.Repository{ID: int64(i + 1), FullName: "acme/other"}
	}
	repos[100].FullName = "acme/app"
	installations[100] = githubfake.Installation{ID: 101, Account: githubfake.Account{Login: "acme"}, Repositories: repos}
	server, err := githubfake.New(githubfake.Config{AppID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin, OwnerKind: credentials.OwnerKind, PrivateKeyPEM: credentials.PEM, ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, WebhookSecret: credentials.WebhookSecret, ConversionCode: "code", Installations: installations})
	require.NoError(t, err)
	t.Cleanup(server.Close)
	codec, err := webhook.NewSecretCodec("pagination-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	service := NewGitHubAppManifestService(pool, store, server.URL, nil)
	start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	_, err = service.Convert(ctx, "code", start.State, start.State)
	require.NoError(t, err)
	require.NoError(t, service.ResumeInstallation(ctx))
	loaded, err := store.Load(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(101), loaded.InstallationID)
	require.Len(t, server.Writes(), 2, "installation and repository on second pages must be reached")
}

func TestGitHubAppManifestHTTPFailuresNeverLeakCredentialsOrFollowRedirects(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(200) }))
	defer target.Close()
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"github-rejection", 422, `{"message":"raw-sensitive-upstream-value"}`},
		{"malformed-response", 200, `raw-sensitive-upstream-value`},
		{"trailing-document", 200, `{}{"token":"must-not-be-accepted"}`},
		{"trailing-junk", 200, `{}raw-sensitive-upstream-value`},
		{"redirect", 307, `{"message":"raw-sensitive-upstream-value"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			service := NewGitHubAppManifestService(nil, nil, server.URL, nil)
			var output map[string]any
			err := service.request(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), http.MethodPost, "/app-manifests/code/conversions", "", &output)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "raw-sensitive-upstream-value")
		})
	}
	require.Zero(t, redirected.Load())
	canceled, cancel := context.WithCancel(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
	cancel()
	service := NewGitHubAppManifestService(nil, nil, target.URL, nil)
	var output any
	require.Error(t, service.request(canceled, http.MethodGet, "/app", "", &output))
}

func TestGitHubAppManifestHTTPBodyLimitAndInterruptedResponse(t *testing.T) {
	for _, tc := range []struct {
		name          string
		body          string
		contentLength string
		accepted      bool
	}{
		{"exact-limit", `{}` + strings.Repeat(" ", (4<<20)-2), "", true},
		{"over-limit", `{}` + strings.Repeat(" ", (4<<20)-1), "", false},
		{"interrupted", `{}`, "100", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.contentLength != "" {
					w.Header().Set("Content-Length", tc.contentLength)
				}
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			service := NewGitHubAppManifestService(nil, nil, server.URL, nil)
			var output any
			err := service.request(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), http.MethodGet, "/app", "", &output)
			if tc.accepted {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestGitHubAppManifestCanceledExchangeConsumesStateAndReleasesLockPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	fake, _ := manifestFixture(t)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	codec, err := webhook.NewSecretCodec("canceled-exchange-key")
	require.NoError(t, err)
	service := NewGitHubAppManifestService(pool, NewGitHubAppCredentialStore(pool, codec), server.URL, nil)
	start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	canceled, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := service.Convert(canceled, "code", start.State, start.State); done <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("conversion never reached HTTP boundary")
	}
	cancel()
	select {
	case err := <-done:
		require.Error(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("canceled exchange did not return")
	}
	var used bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT used_at IS NOT NULL FROM github_app_manifest_states WHERE digest = $1`, GitHubAppStateDigest(start.State)).Scan(&used))
	require.True(t, used)
	service.apiBaseURL = fake.URL
	_, err = service.Convert(ctx, "manifest-code", start.State, start.State)
	require.Error(t, err)
	require.Empty(t, fake.Writes())
	fresh, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	bounded, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	_, err = service.Convert(bounded, "manifest-code", fresh.State, fresh.State)
	require.NoError(t, err, "cancellation must release the database advisory lock")
}

func TestGitHubAppManifestUnknownOwnerTypeIsRefusedPostgres(t *testing.T) {
	t.Parallel()
	pool := newGitHubAppTestPool(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	_, credentials := manifestFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": credentials.ID, "slug": credentials.Slug, "pem": credentials.PEM, "client_id": credentials.ClientID, "client_secret": credentials.ClientSecret, "webhook_secret": credentials.WebhookSecret, "owner": map[string]string{"login": "acme", "type": "Bot"}})
	}))
	defer server.Close()
	codec, err := webhook.NewSecretCodec("unknown-owner-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	service := NewGitHubAppManifestService(pool, store, server.URL, nil)
	start, err := service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "user", Repository: "app"})
	require.NoError(t, err)
	_, err = service.Convert(ctx, "code", start.State, start.State)
	require.Error(t, err, "an unrecognized GitHub owner type must not silently become user")
	_, err = store.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
}

func TestGitHubAppManifestMalformedAPIURLDoesNotLeakConversionCode(t *testing.T) {
	service := NewGitHubAppManifestService(nil, nil, "%malformed-url", nil)
	var output any
	err := service.request(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), http.MethodPost, "/app-manifests/secret-conversion-code/conversions", "", &output)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret-conversion-code")
	var failure *pkgerrors.APIError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, pkgerrors.CodeGitHubUnavailable, failure.Code)
}

type appManifestFixture struct {
	pool        *pgxpool.Pool
	github      *githubfake.Server
	credentials GitHubAppCredentials
	codec       *webhook.AESGCMSecretCodec
	store       *GitHubAppCredentialStore
	service     *GitHubAppManifestService
	start       GitHubAppManifestStart
}

func newAppManifestFixture(t *testing.T) appManifestFixture {
	t.Helper()
	f := appManifestFixture{pool: newGitHubAppTestPool(t)}
	f.github, f.credentials = manifestFixture(t)
	var err error
	f.codec, err = webhook.NewSecretCodec("manifest-boundary-key")
	require.NoError(t, err)
	f.store = NewGitHubAppCredentialStore(f.pool, f.codec)
	f.service = NewGitHubAppManifestService(f.pool, f.store, f.github.URL, nil)
	f.start, err = f.service.Begin(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	return f
}

func (f appManifestFixture) confirm(t *testing.T) {
	t.Helper()
	require.NoError(t, f.store.Save(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), f.credentials))
	_, err := f.pool.Exec(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), `UPDATE github_app_manifest_states SET used_at=now() WHERE digest=$1`, GitHubAppStateDigest(f.start.State))
	require.NoError(t, err)
	_, err = f.pool.Exec(context.Background(), `INSERT INTO install_settings(key,value) VALUES('github.repository','{"owner_login":"acme","owner_kind":"org","repository_name":"app"}') ON CONFLICT DO NOTHING`)
	require.NoError(t, err)
}

func TestGitHubAppManifestSetupBoundaryFailuresPostgres(t *testing.T) {
	t.Parallel()
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	for _, request := range []GitHubAppManifestRequest{
		{OwnerLogin: "acme", OwnerKind: "org", Repository: "../invalid"},
		{OwnerLogin: "../invalid", OwnerKind: "org", Repository: "app"},
		{OwnerLogin: "acme", OwnerKind: "org", Repository: "app", Origin: "http://foreign.example"},
	} {
		_, err := f.service.Begin(ctx, request)
		require.Error(t, err)
	}
	originalOrigins := f.service.origins
	f.service.origins = func() []string { return []string{"javascript:bad"} }
	_, err := f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.Error(t, err)
	f.service.origins = originalOrigins
	f.service.origins = func() []string { return []string{"http://mini.local:4000"} }
	_, resetErr := f.pool.Exec(ctx, `DELETE FROM install_settings WHERE key='setup.step.app_manifest'`)
	require.NoError(t, resetErr)
	lan, err := f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app", Origin: "http://mini.local:4000"})
	require.NoError(t, err)
	require.Equal(t, "http://mini.local:4000/setup/github/callback", lan.Manifest.RedirectURL)
	require.NoError(t, f.service.ValidateCallbackOrigin(WithGitHubAppSetupSession(ctx, strings.Repeat("s", 64), "http://mini.local:4000"), lan.State, "http://mini.local:4000"))
	f.service.store = NewGitHubAppCredentialStore(f.pool, nil)
	_, err = f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.Error(t, err)
	f.service.store = f.store
	_, err = f.pool.Exec(ctx, `DROP TABLE github_app_manifest_states`)
	require.NoError(t, err)
	_, err = f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.Error(t, err)
	require.Empty(t, f.github.Writes())
}

func TestGitHubAppManifestCallbackOriginBindingPostgres(t *testing.T) {
	t.Parallel()
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	require.NoError(t, f.service.ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000"))
	for _, origin := range []string{"http://localhost:4001", "http://mini.local:4000", "", "https://localhost:4000"} {
		require.Error(t, f.service.ValidateCallbackOrigin(ctx, f.start.State, origin))
	}
	require.Error(t, f.service.ValidateCallbackOrigin(ctx, strings.Repeat("f", 64), "http://localhost:4000"))
	var unavailable *GitHubAppManifestService
	require.Error(t, unavailable.ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000"))
	require.Error(t, NewGitHubAppManifestService(nil, nil, "", nil).ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000"))
	f.pool.Close()
	require.Error(t, f.service.ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000"))
	require.Empty(t, f.github.Writes())
}

func TestGitHubAppManifestConversionEnforcesOwnerAndAcceptsUserAppPostgres(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"another-owner", "user"} {
		t.Run(kind, func(t *testing.T) {
			f := newAppManifestFixture(t)
			if kind == "another-owner" {
				_, resetErr := f.pool.Exec(context.Background(), `DELETE FROM install_settings WHERE key='setup.step.app_manifest'`)
				require.NoError(t, resetErr)
				start, err := f.service.Begin(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), GitHubAppManifestRequest{OwnerLogin: "another-owner", OwnerKind: "org", Repository: "app"})
				require.NoError(t, err)
				_, err = f.service.Convert(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), "manifest-code", start.State, start.State)
				require.Error(t, err)
				_, err = f.store.Load(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
				require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
			} else {
				server, err := githubfake.New(githubfake.Config{AppID: f.credentials.ID, Slug: f.credentials.Slug, OwnerLogin: "acme", OwnerKind: "user", PrivateKeyPEM: f.credentials.PEM, ClientID: f.credentials.ClientID, ClientSecret: f.credentials.ClientSecret, WebhookSecret: f.credentials.WebhookSecret, ConversionCode: "code"})
				require.NoError(t, err)
				defer server.Close()
				f.service.apiBaseURL = server.URL
				_, resetErr := f.pool.Exec(context.Background(), `DELETE FROM install_settings WHERE key='setup.step.app_manifest'`)
				require.NoError(t, resetErr)
				start, err := f.service.Begin(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "user", Repository: "app"})
				require.NoError(t, err)
				_, err = f.service.Convert(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), "code", start.State, start.State)
				require.NoError(t, err)
				loaded, err := f.store.Load(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
				require.NoError(t, err)
				require.Equal(t, "user", loaded.OwnerKind)
			}
		})
	}
}

func TestGitHubAppManifestConversionDatabaseFailuresPostgres(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"closed-pool", "bad-codec", "lock", "consume", "save", "callbacks", "delete", "commit", "reload", "unlock"} {
		t.Run(kind, func(t *testing.T) {
			f := newAppManifestFixture(t)
			ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
			if kind == "closed-pool" {
				f.pool.Close()
			} else if kind == "bad-codec" {
				f.service.store = NewGitHubAppCredentialStore(f.pool, nil)
			} else {
				if kind == "lock" || kind == "unlock" {
					function := "pg_advisory_lock"
					returns := "void"
					if kind == "unlock" {
						function = "pg_advisory_unlock"
						returns = "boolean"
					}
					_, err := f.pool.Exec(ctx, `CREATE FUNCTION public.`+function+`(bigint) RETURNS `+returns+` LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture lock unavailable'; END $$`)
					require.NoError(t, err)
					config := f.pool.Config()
					config.MaxConns = 1
					config.ConnConfig.RuntimeParams["search_path"] = "public,pg_catalog"
					pool, err := pgxpool.NewWithConfig(ctx, config)
					require.NoError(t, err)
					t.Cleanup(pool.Close)
					f.service.pool = pool
				} else {
					if kind == "reload" {
						_, err := f.pool.Exec(ctx, `CREATE FUNCTION manifest_db_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.pem_sealed='corrupted-after-insert'; RETURN NEW; END $$`)
						require.NoError(t, err)
					} else {
						_, err := f.pool.Exec(ctx, `CREATE FUNCTION manifest_db_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture database unavailable'; END $$`)
						require.NoError(t, err)
					}
					var trigger string
					switch kind {
					case "consume":
						trigger = `CREATE TRIGGER manifest_db_fault BEFORE UPDATE ON github_app_manifest_states FOR EACH ROW EXECUTE FUNCTION manifest_db_fault()`
					case "save", "reload":
						trigger = `CREATE TRIGGER manifest_db_fault BEFORE INSERT ON github_app FOR EACH ROW EXECUTE FUNCTION manifest_db_fault()`
					case "callbacks":
						trigger = `CREATE TRIGGER manifest_db_fault BEFORE INSERT ON install_settings FOR EACH ROW EXECUTE FUNCTION manifest_db_fault()`
					case "delete":
						trigger = `CREATE TRIGGER manifest_db_fault BEFORE DELETE ON github_app_manifest_states FOR EACH STATEMENT EXECUTE FUNCTION manifest_db_fault()`
					case "commit":
						trigger = `CREATE CONSTRAINT TRIGGER manifest_db_fault AFTER INSERT ON github_app DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION manifest_db_fault()`
					}
					_, err := f.pool.Exec(ctx, trigger)
					require.NoError(t, err)
				}
			}
			bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			installURL, err := f.service.Convert(bounded, "manifest-code", f.start.State, f.start.State)
			if kind == "unlock" {
				require.NoError(t, err)
				require.NotEmpty(t, installURL)
				var locks int
				require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`).Scan(&locks))
				require.Zero(t, locks, "a failed unlock must discard the connection and release its session lock")
			} else {
				require.Error(t, err)
				require.Empty(t, installURL)
			}
			if kind == "closed-pool" || kind == "bad-codec" || kind == "lock" || kind == "consume" {
				require.Empty(t, f.github.Writes())
			}
			if kind == "save" || kind == "callbacks" || kind == "delete" || kind == "commit" {
				_, err = f.store.Load(ctx)
				require.ErrorIs(t, err, ErrGitHubAppNotConfigured, "a failed transaction must not leave an App")
				var used bool
				require.NoError(t, f.pool.QueryRow(ctx, `SELECT used_at IS NOT NULL FROM github_app_manifest_states WHERE digest=$1`, GitHubAppStateDigest(f.start.State)).Scan(&used))
				require.True(t, used, "the remotely exchanged state remains consumed")
			}
		})
	}
}

func TestGitHubAppManifestCallbackSnapshotIsCreationTimeAndAtomicPostgres(t *testing.T) {
	t.Parallel()
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	f.service.origins = func() []string { return []string{"http://mini.local:4000"} }
	_, resetErr := f.pool.Exec(context.Background(), `DELETE FROM install_settings WHERE key='setup.step.app_manifest'`)
	require.NoError(t, resetErr)
	start, err := f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.NoError(t, err)
	f.service.origins = func() []string { return []string{"https://added-later.example"} }
	_, err = f.service.Convert(ctx, "manifest-code", start.State, start.State)
	require.NoError(t, err)
	callbacks, err := f.store.CallbackURLs(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{"http://mini.local:4000/api/auth/github/callback", "http://localhost:4000/api/auth/github/callback"}, callbacks, "C-GH-01 literal creation-time callbacks survive later origin changes")
	require.NotContains(t, callbacks, "https://added-later.example")
	var sealed bool
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT sealed FROM install_settings WHERE key='github.callback_urls'`).Scan(&sealed))
	require.False(t, sealed)
}

func TestGitHubAppManifestCorruptCallbackSnapshotNeverExchangesPostgres(t *testing.T) {
	t.Parallel()
	for _, snapshot := range []string{`[]`, `[42]`, `["https://example.invalid/callback?code=private"]`} {
		t.Run(snapshot, func(t *testing.T) {
			f := newAppManifestFixture(t)
			_, err := f.pool.Exec(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), `UPDATE github_app_manifest_states SET callback_urls=$1::jsonb WHERE digest=$2`, snapshot, GitHubAppStateDigest(f.start.State))
			require.NoError(t, err)
			_, err = f.service.Convert(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"), "manifest-code", f.start.State, f.start.State)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "example.invalid")
			require.NotContains(t, err.Error(), "private")
			require.Empty(t, f.github.Writes(), "corrupt persisted manifest data must not consume a remote code")
		})
	}
}

func TestGitHubAppManifestConnectionLostAfterExchangePostgres(t *testing.T) {
	t.Parallel()
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	disconnected := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := f.pool.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)
		disconnected <- err
		_ = json.NewEncoder(w).Encode(map[string]any{"id": f.credentials.ID, "slug": f.credentials.Slug, "pem": f.credentials.PEM, "client_id": f.credentials.ClientID, "client_secret": f.credentials.ClientSecret, "webhook_secret": f.credentials.WebhookSecret, "owner": map[string]string{"login": "acme", "type": "Organization"}})
	}))
	defer server.Close()
	f.service.apiBaseURL = server.URL
	_, err := f.service.Convert(ctx, "code", f.start.State, f.start.State)
	require.Error(t, err)
	require.NoError(t, <-disconnected)
	_, err = f.store.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	var used bool
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT used_at IS NOT NULL FROM github_app_manifest_states WHERE digest=$1`, GitHubAppStateDigest(f.start.State)).Scan(&used))
	require.True(t, used)
}

func TestGitHubAppManifestInstallationHTTPFailuresPostgres(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, path string
		status     int
		body       string
	}{
		{"installations", "/app/installations", 500, `{}`},
		{"token", "/app/installations/91/access_tokens", 500, `{}`},
		{"empty-token", "/app/installations/91/access_tokens", 201, `{"token":""}`},
		{"repositories", "/installation/repositories", 500, `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppManifestFixture(t)
			f.confirm(t)
			target, err := url.Parse(f.github.URL)
			require.NoError(t, err)
			proxy := httputil.NewSingleHostReverseProxy(target)
			proxy.ModifyResponse = func(response *http.Response) error {
				if response.Request.URL.Path == tc.path {
					response.Body.Close()
					response.Body = io.NopCloser(strings.NewReader(tc.body))
					response.StatusCode = tc.status
					response.ContentLength = int64(len(tc.body))
					response.Header.Del("Content-Length")
				}
				return nil
			}
			server := httptest.NewServer(proxy)
			defer server.Close()
			f.service.apiBaseURL = server.URL
			require.Error(t, f.service.ResumeInstallation(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")))
			loaded, err := f.store.Load(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
			require.NoError(t, err)
			require.Zero(t, loaded.InstallationID)
		})
	}
}

func TestGitHubAppManifestInstallationPaginationBudgetsPostgres(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"installations", "repositories"} {
		t.Run(kind, func(t *testing.T) {
			f := newAppManifestFixture(t)
			f.confirm(t)
			installations := []githubfake.Installation{{ID: 91}}
			if kind == "installations" {
				installations = make([]githubfake.Installation, 10000)
				for i := range installations {
					installations[i] = githubfake.Installation{ID: int64(i + 1)}
				}
			} else {
				installations[0].Repositories = make([]githubfake.Repository, 10000)
				for i := range installations[0].Repositories {
					installations[0].Repositories[i] = githubfake.Repository{ID: int64(i + 1), FullName: "acme/other"}
				}
			}
			server, err := githubfake.New(githubfake.Config{AppID: f.credentials.ID, PrivateKeyPEM: f.credentials.PEM, OwnerLogin: "acme", Installations: installations})
			require.NoError(t, err)
			defer server.Close()
			f.service.apiBaseURL = server.URL
			err = f.service.ResumeInstallation(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
			require.Error(t, err)
			var failure *pkgerrors.APIError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, pkgerrors.CodeGitHubUnavailable, failure.Code)
			loaded, err := f.store.Load(WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000"))
			require.NoError(t, err)
			require.Zero(t, loaded.InstallationID)
		})
	}
}

// T-GH-01 security exception (2026-10-02): state is a digest, TTL ten
// minutes, bound to the initiating session and origin; refusal precedes exchange.
func TestGitHubAppManifestSetupSessionSecurityPostgres(t *testing.T) {
	f := newAppManifestFixture(t)
	for _, refusal := range []string{"missing-session", "foreign-session", "foreign-origin", "expired-session", "missing-state", "used-state"} {
		t.Run(refusal, func(t *testing.T) {
			ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
			_, resetErr := f.pool.Exec(context.Background(), `DELETE FROM install_settings WHERE key='setup.step.app_manifest'`)
			require.NoError(t, resetErr)
			start, err := f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
			require.NoError(t, err)
			state := start.State
			switch refusal {
			case "missing-session":
				ctx = context.Background()
			case "foreign-session":
				ctx = WithGitHubAppSetupSession(ctx, strings.Repeat("x", 64), "http://localhost:4000")
			case "foreign-origin":
				ctx = WithGitHubAppSetupSession(ctx, strings.Repeat("s", 64), "http://mini.local:4000")
			case "expired-session":
				_, err := f.pool.Exec(ctx, "UPDATE github_app_manifest_states SET expires_at=now()-interval '1 second'")
				require.NoError(t, err)
			case "missing-state":
				state = ""
			case "used-state":
				_, err := f.pool.Exec(ctx, "UPDATE github_app_manifest_states SET used_at=now()")
				require.NoError(t, err)
			}
			_, err = f.service.Convert(ctx, "manifest-code", state, state)
			var typed *pkgerrors.APIError
			require.ErrorAs(t, err, &typed)
			require.Equal(t, http.StatusForbidden, typed.Status)
			require.Empty(t, f.github.Writes())
			_, err = f.store.Load(ctx)
			require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
		})
	}
}

func TestGitHubAppManifestOneStateConcurrentCallbacksPostgres(t *testing.T) {
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	var digest, session string
	var ttl float64
	require.NoError(t, f.pool.QueryRow(ctx, "SELECT digest, setup_session_digest, extract(epoch from (expires_at-now())) FROM github_app_manifest_states").Scan(&digest, &session, &ttl))
	require.NotEqual(t, f.start.State, digest)
	require.Equal(t, GitHubAppStateDigest(f.start.State), digest)
	require.Equal(t, GitHubAppStateDigest(strings.Repeat("s", 64)), session)
	require.InDelta(t, 600, ttl, 5) // Binding security exception: ten minutes.
	results := make(chan error, 2)
	gate := make(chan struct{})
	for i := 0; i < 2; i++ {
		go func() {
			<-gate
			_, err := f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
			results <- err
		}()
	}
	close(gate)
	success := 0
	for i := 0; i < 2; i++ {
		if <-results == nil {
			success++
		}
	}
	require.Equal(t, 1, success)
	require.Len(t, f.github.Writes(), 1)
}

func TestGitHubAppManifestDurableBeginCASAndAtomicCompletionPostgres(t *testing.T) {
	// Spec §16.2.1: one running begin and all-or-none local completion/projection.
	pool := newGitHubAppTestPool(t)
	server, _ := manifestFixture(t)
	codec, err := webhook.NewSecretCodec("atomic-cas-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	service := NewGitHubAppManifestService(pool, store, server.URL, nil)
	starts := make(chan GitHubAppManifestStart, 2)
	failures := make(chan error, 2)
	var wg sync.WaitGroup
	for _, session := range []string{strings.Repeat("a", 64), strings.Repeat("b", 64)} {
		wg.Add(1)
		go func(session string) {
			defer wg.Done()
			start, err := service.Begin(WithGitHubAppSetupSession(context.Background(), session, "http://localhost:4000"), GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
			if err != nil {
				failures <- err
			} else {
				starts <- start
			}
		}(session)
	}
	wg.Wait()
	require.Len(t, starts, 1)
	require.Len(t, failures, 1)
	require.Empty(t, server.Writes())
	start := <-starts
	var sessionDigest, status string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT setup_session_digest FROM github_app_manifest_states WHERE digest=$1`, GitHubAppStateDigest(start.State)).Scan(&sessionDigest))
	session := strings.Repeat("a", 64)
	if sessionDigest != GitHubAppStateDigest(session) {
		session = strings.Repeat("b", 64)
	}
	ctx := WithGitHubAppSetupSession(context.Background(), session, "http://localhost:4000")
	restarted := NewGitHubAppManifestService(pool, NewGitHubAppCredentialStore(pool, codec), server.URL, nil)
	_, err = restarted.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "app"})
	require.Error(t, err, "restart cannot re-admit running begin")
	// Real PostgreSQL trigger injects failure at the last local projection write.
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_app_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='setup.projection.app_manifest' THEN RAISE EXCEPTION 'projection write failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_app_projection BEFORE INSERT OR UPDATE ON install_settings FOR EACH ROW EXECUTE FUNCTION refuse_app_projection()`)
	require.NoError(t, err)
	_, err = service.Convert(ctx, "manifest-code", start.State, start.State)
	require.Error(t, err)
	require.Len(t, server.Writes(), 1)
	_, err = store.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key IN ('github.callback_urls','github.repository','setup.projection.app_manifest')`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'status' FROM install_settings WHERE key='setup.step.app_manifest'`).Scan(&status))
	require.Equal(t, "failed", status)
	_, err = service.Convert(ctx, "manifest-code", start.State, start.State)
	require.Error(t, err)
	require.Len(t, server.Writes(), 1, "local failure never replays remote conversion")
}

func TestGitHubAppManifestInvalidatedSessionWhileWaitingPostgres(t *testing.T) {
	// Security exception: durable authority must hold at consumption, after waits.
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	_, err := f.pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,'{"expires_at":"2099-01-01T00:00:00Z"}') ON CONFLICT DO NOTHING`, "setup.session."+GitHubAppStateDigest(strings.Repeat("s", 64)))
	require.NoError(t, err)
	require.NoError(t, f.service.ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000"))
	conn, err := f.pool.Acquire(ctx)
	require.NoError(t, err)
	defer conn.Release()
	_, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", gitHubAppConversionLock)
	require.NoError(t, err)
	result := make(chan error, 1)
	go func() { _, err := f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State); result <- err }()
	require.Eventually(t, func() bool {
		var n int
		err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted`).Scan(&n)
		return err == nil && n > 0
	}, 5*time.Second, 10*time.Millisecond)
	_, err = conn.Exec(ctx, "DELETE FROM install_settings WHERE key=$1", "setup.session."+GitHubAppStateDigest(strings.Repeat("s", 64)))
	require.NoError(t, err)
	_, err = conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", gitHubAppConversionLock)
	require.NoError(t, err)
	require.Error(t, <-result)
	require.Empty(t, f.github.Writes())
	_, err = f.store.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
}

func TestGitHubAppManifestExpiryDuringConversionPostgres(t *testing.T) {
	// §16.2.1: lease takeover cannot replace an in-flight remote conversion.
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	entered, release := make(chan struct{}), make(chan struct{})
	target, err := url.Parse(f.github.URL)
	require.NoError(t, err)
	proxy := httputil.NewSingleHostReverseProxy(target)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; proxy.ServeHTTP(w, r) }))
	defer server.Close()
	f.service.apiBaseURL = server.URL
	converted := make(chan error, 1)
	go func() {
		_, err := f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
		converted <- err
	}()
	<-entered
	_, err = f.pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(now()-interval '1 second')) WHERE key='setup.step.app_manifest'`)
	require.NoError(t, err)
	waiting, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	_, err = f.service.Begin(waiting, GitHubAppManifestRequest{OwnerLogin: "acme", OwnerKind: "org", Repository: "other"})
	cancel()
	close(release)
	require.Error(t, err, "begin must wait for conversion instead of replacing its state")
	require.NoError(t, <-converted)
	var repository string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT value->>'repository_name' FROM install_settings WHERE key='github.repository'`).Scan(&repository))
	require.Equal(t, "app", repository)
}

// Service fixtures create real durable sessions, as production routes do.
func newGitHubAppTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := newProductTestPool(t)
	for _, letter := range []string{"s", "a", "b"} {
		_, err := pool.Exec(context.Background(), `INSERT INTO install_settings(key,value) VALUES($1,jsonb_build_object('expires_at',now()+interval '24 hours'))`, "setup.session."+GitHubAppStateDigest(strings.Repeat(letter, 64)))
		require.NoError(t, err)
	}
	return pool
}

func TestGitHubAppManifestReinstallationPostgres(t *testing.T) {
	// §12.1.3: a replacement GitHub installation must still contain our repository.
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	_, err := f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
	require.NoError(t, err)
	require.NoError(t, f.service.ResumeInstallation(ctx))
	replacement, err := githubfake.New(githubfake.Config{AppID: f.credentials.ID, PrivateKeyPEM: f.credentials.PEM, OwnerLogin: "acme", Installations: []githubfake.Installation{{ID: 193, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}}}})
	require.NoError(t, err)
	defer replacement.Close()
	f.service.apiBaseURL = replacement.URL
	require.NoError(t, f.service.ResumeInstallation(ctx))
	loaded, err := f.store.Load(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 193, loaded.InstallationID)
}

func TestGitHubAppManifestCompletionFencesActiveAttemptPostgres(t *testing.T) {
	// §16.2.1: an obsolete attempt may not commit credentials or a done projection.
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	target, err := url.Parse(f.github.URL)
	require.NoError(t, err)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(r *http.Response) error {
		_, err := f.pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{digest}','"replacement-digest"') WHERE key='setup.step.app_manifest'`)
		return err
	}
	server := httptest.NewServer(proxy)
	defer server.Close()
	f.service.apiBaseURL = server.URL
	_, err = f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
	require.Error(t, err)
	_, err = f.store.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
	var digest string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT value->>'digest' FROM install_settings WHERE key='setup.step.app_manifest'`).Scan(&digest))
	require.Equal(t, "replacement-digest", digest)
	var n int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key IN ('github.repository','github.callback_urls','setup.projection.app_manifest')`).Scan(&n))
	require.Zero(t, n)
	require.Len(t, f.github.Writes(), 1)
}

func TestGitHubAppManifestLapsedStepNeverConsumesOrConvertsPostgres(t *testing.T) {
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(t.Context(), strings.Repeat("s", 64), "http://localhost:4000")
	now := time.Now()
	f.service.Now = func() time.Time { return now }
	// Only the durable step lease lapses: even a still-live conversion state
	// cannot authorize an exchange after the attempt lost its lease.
	_, err := f.pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb($1::timestamptz)) WHERE key='setup.step.app_manifest'`, now)
	require.NoError(t, err)
	before, err := db.New(f.pool).GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	if f.service.ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000") == nil {
		t.Error("lapsed step accepted at callback boundary")
	}
	_, err = f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
	require.Error(t, err)
	require.Empty(t, f.github.Writes())
	after, err := db.New(f.pool).GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	require.JSONEq(t, string(before.Value), string(after.Value))
	attempt, err := db.New(f.pool).GetGithubAppManifestState(ctx, GitHubAppStateDigest(f.start.State))
	require.NoError(t, err)
	require.False(t, attempt.UsedAt.Valid)
	start, err := f.service.Begin(ctx, GitHubAppManifestRequest{OwnerLogin: "another-owner", OwnerKind: "org"})
	require.NoError(t, err)
	require.NotEqual(t, f.start.State, start.State)
	replacement, err := db.New(f.pool).GetGithubAppManifestState(ctx, GitHubAppStateDigest(start.State))
	require.NoError(t, err)
	require.Equal(t, "another-owner", replacement.OwnerLogin)
	// The old state's own TTL is still live, but it no longer owns the step.
	require.Error(t, f.service.ValidateCallbackOrigin(ctx, f.start.State, "http://localhost:4000"))
	before, err = db.New(f.pool).GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	_, err = f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
	require.Error(t, err)
	require.Empty(t, f.github.Writes())
	after, err = db.New(f.pool).GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	require.JSONEq(t, string(before.Value), string(after.Value))
	_, err = f.store.Load(ctx)
	require.ErrorIs(t, err, ErrGitHubAppNotConfigured)
}
