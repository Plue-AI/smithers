package compose

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/apiclient"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallSetupCookieBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	authority := &services.InstallSetupSessions{Pool: pool, TokenDigest: sha256.Sum256([]byte("printed-fixture-token"))}
	setup := &services.InstallSetupService{Pool: pool, Jobs: store}
	handler := &routes.GitHubAppSetupHandler{Sessions: authority, Owners: q, AllowedOrigins: []string{origin}, Setup: setup}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, handler)
	server.Start()
	defer server.Close()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exchange, err := client.Get(origin + "/setup?token=printed-fixture-token")
	require.NoError(t, err)
	exchange.Body.Close()
	require.Equal(t, 303, exchange.StatusCode)
	require.Equal(t, "/", exchange.Header.Get("Location"))
	require.NotContains(t, exchange.Header.Get("Location"), "token")
	for _, cookie := range exchange.Cookies() {
		if cookie.Name == "smithers_setup_session" {
			require.True(t, cookie.HttpOnly)
			require.Equal(t, "", cookie.Domain)
			require.Equal(t, "/", cookie.Path)
			require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
			require.False(t, cookie.Secure)
		}
	}
	api := &apiclient.Client{BaseURL: origin, HTTPClient: client}
	status, err := api.GetAPIInstall(ctx)
	require.NoError(t, err)
	require.Len(t, status.Steps, 7)
	require.Equal(t, "app_manifest", status.Steps[1].ID)
	request := func(path, body string, bearer bool) *http.Response {
		r, err := http.NewRequestWithContext(ctx, "POST", origin+path, strings.NewReader(body))
		require.NoError(t, err)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("Idempotency-Key", "setup-boundary")
		for _, cookie := range jar.Cookies(r.URL) {
			if cookie.Name == "__csrf" {
				r.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		c := client
		if bearer {
			r.Header.Set("Authorization", "Bearer printed-fixture-token")
			c = &http.Client{}
		}
		response, err := c.Do(r)
		require.NoError(t, err)
		return response
	}
	for _, test := range []struct {
		path, body string
		want       int
	}{{"/api/install/setup/address", `{}`, 400}, {"/api/install/setup/address", `{"bind":42,"origins":[]}`, 400}, {"/api/install/setup/address", `{"bind":"127.0.0.1:4000","origins":[],"unknown":true}`, 400}, {"/api/install/setup/app", `{"owner":"smithersai","kind":"org"}`, 400}, {"/api/install/setup/models", `{}`, 403}, {"/api/install/setup/github_app", `{}`, 404}, {"/api/install/setup/app_manifest", `{}`, 404}} {
		response := request(test.path, test.body, false)
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		require.Equal(t, test.want, response.StatusCode, string(body))
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation LIKE 'install.setup.%'`).Scan(&count))
	require.Zero(t, count)
	response := request("/api/install/setup/address", `{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`, true)
	response.Body.Close()
	require.Equal(t, 401, response.StatusCode)
	response = request("/api/install/setup/address", `{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`, false)
	var receipt jobs.RequestReceipt
	require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
	response.Body.Close()
	require.Equal(t, 202, response.StatusCode)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "boundary-worker", Capacity: 1, Lease: time.Second, Operations: []string{"install.setup.address"}}, setup.Handle)
	}()
	require.Eventually(t, func() bool {
		status, err := api.GetAPIInstall(ctx)
		return err == nil && status.Steps[0].State == "done"
	}, 5*time.Second, 20*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
}
