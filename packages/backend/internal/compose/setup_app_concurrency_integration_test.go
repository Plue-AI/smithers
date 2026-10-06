package compose

import (
	"bytes"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-SEC-04: two live setup browsers race through the composed HTTP door.
// Only the admitted browser creates an App, and completion survives reload.
func TestSetupBrowsersCreateOneGitHubAppPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	seed, err := githubfake.LocalSeed()
	require.NoError(t, err)
	fake, err := githubfake.New(seed)
	require.NoError(t, err)
	defer fake.Close()
	codec, err := webhook.NewSecretCodec("concurrent-setup-install-key")
	require.NoError(t, err)
	store := services.NewGitHubAppCredentialStore(pool, codec)
	setup := &services.InstallSetupSessions{Pool: pool}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	origins := middleware.FixedOrigins(origin)
	handler := &routes.GitHubAppSetupHandler{
		Service: services.NewGitHubAppManifestService(pool, store, fake.URL, origins),
		Store:   store, Owners: q, Sessions: setup, Origins: origins,
		Setup: &services.InstallSetupService{Pool: pool},
	}
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.step.address", Value: []byte(`{"status":"done"}`)}))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, handler)
	server.Start()
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var mint bytes.Buffer
	require.NoError(t, setup.Mint(t.Context(), []string{origin}, &mint))
	var line struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal(mint.Bytes(), &line))
	printed, err := url.Parse(line.URLs[0])
	require.NoError(t, err)
	browsers := make([][]*http.Cookie, 2)
	for i := range browsers {
		response, err := client.Get(origin + "/setup?token=" + url.QueryEscape(printed.Query().Get("token")))
		require.NoError(t, err)
		response.Body.Close()
		require.Equal(t, http.StatusSeeOther, response.StatusCode)
		browsers[i] = response.Cookies()
	}
	type outcome struct {
		status  int
		body    []byte
		cookies []*http.Cookie
		err     error
	}
	results := make([]outcome, 2)
	barrier := make(chan struct{})
	var wg sync.WaitGroup
	for i := range browsers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			request, err := http.NewRequest(http.MethodPost, origin+"/api/install/setup/app", strings.NewReader(`{"owner":"local-owner"}`))
			if err != nil {
				results[i].err = err
				return
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", origin)
			for _, cookie := range browsers[i] {
				request.AddCookie(cookie)
				if cookie.Name == middleware.CSRFCookieName {
					request.Header.Set("X-CSRF-Token", cookie.Value)
				}
			}
			<-barrier
			response, err := client.Do(request)
			if err != nil {
				results[i].err = err
				return
			}
			defer response.Body.Close()
			results[i].status = response.StatusCode
			results[i].cookies = response.Cookies()
			results[i].body, results[i].err = io.ReadAll(response.Body)
		}(i)
	}
	close(barrier)
	wg.Wait()
	winner := 0
	if results[0].status == http.StatusConflict {
		winner = 1
	}
	for _, result := range results {
		require.NoError(t, result.err)
	}
	require.Equal(t, http.StatusOK, results[winner].status, string(results[winner].body))
	require.Equal(t, http.StatusConflict, results[1-winner].status, string(results[1-winner].body))
	require.JSONEq(t, `{"code":"conflict","class":"conflict","message":"GitHub App setup is already running or complete"}`, string(results[1-winner].body))
	var attempt services.GitHubAppManifestStart
	require.NoError(t, json.Unmarshal(results[winner].body, &attempt))
	manifest, err := json.Marshal(attempt.Manifest)
	require.NoError(t, err)
	response, err := http.PostForm(fake.URL+"/settings/apps/new", url.Values{"manifest": {string(manifest)}, "state": {attempt.State}})
	require.NoError(t, err)
	page, err := io.ReadAll(response.Body)
	response.Body.Close()
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	target, err := url.Parse(html.UnescapeString(strings.Split(strings.Split(string(page), `href="`)[1], `"`)[0]))
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodGet, origin+target.RequestURI(), nil)
	require.NoError(t, err)
	for _, cookie := range append(browsers[winner], results[winner].cookies...) {
		request.AddCookie(cookie)
	}
	response, err = client.Do(request)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, http.StatusSeeOther, response.StatusCode)
	require.Len(t, fake.Writes(), 2, "one manifest creation and one conversion")
	for _, key := range []string{"setup.step.app_manifest", "setup.projection.app_manifest"} {
		var state string
		require.NoError(t, pool.QueryRow(t.Context(), "SELECT value->>'status' FROM install_settings WHERE key=$1", key).Scan(&state))
		require.Equal(t, "done", state)
	}
	// The second browser reloads the same durable completion.
	request, err = http.NewRequest(http.MethodGet, origin+"/api/install", nil)
	require.NoError(t, err)
	for _, cookie := range browsers[1-winner] {
		request.AddCookie(cookie)
	}
	response, err = client.Do(request)
	require.NoError(t, err)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.Contains(t, string(body), `"id":"app_manifest","state":"done"`)
	require.Len(t, fake.Writes(), 2)
}
