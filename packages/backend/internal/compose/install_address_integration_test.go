package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// M-28, mvp.md §12 "reached from a second laptop": after the owner saves
// Network in setup step 0, a teammate's laptop resolves at the saved origin
// on the next request, through the composed router, with no restart. Only a
// loopback peer may name the host through X-Forwarded-Host (§17.6a).
func TestInstallAddressNetworkReachesTeammateOriginThroughRouterPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	digest := sha256.Sum256([]byte("printed-address-token"))
	value, _ := json.Marshal(hex.EncodeToString(digest[:]))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.token", Value: value}))
	var mu sync.Mutex
	var binds []string
	address := &services.InstallAddress{Configured: []string{origin}, Listen: func(bind string) error {
		mu.Lock()
		defer mu.Unlock()
		binds = append(binds, bind)
		return nil
	}}
	require.NoError(t, address.Load(ctx, q))
	setup := &services.InstallSetupService{Pool: pool, Jobs: store, Address: address}
	require.NoError(t, setup.Initialize(ctx))
	handler := &routes.GitHubAppSetupHandler{Sessions: &services.InstallSetupSessions{Pool: pool}, Owners: q, Origins: address.Origins, Setup: setup}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	router := githubAppSetupComposeRouter(cfg, pool, handler)
	server.Config.Handler = router
	server.Start()
	defer server.Close()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exchange, err := client.Get(origin + "/setup?token=printed-address-token")
	require.NoError(t, err)
	exchange.Body.Close()
	require.Equal(t, http.StatusSeeOther, exchange.StatusCode)
	base, err := url.Parse(origin)
	require.NoError(t, err)
	cookies := jar.Cookies(base)
	teammate := func(host, peer, forwarded string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/install", nil)
		r.RemoteAddr = peer
		if forwarded != "" {
			r.Header.Set("X-Forwarded-Host", forwarded)
		}
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	before := teammate("mini.local:4000", "192.0.2.10:51000", "")
	require.Equal(t, http.StatusMisdirectedRequest, before.Code, before.Body.String())

	r, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/api/install/setup/address", strings.NewReader(`{"bind":"0.0.0.0:4000","origins":["http://mini.local:4000"]}`))
	require.NoError(t, err)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	r.Header.Set("Idempotency-Key", "address-network")
	for _, cookie := range cookies {
		if cookie.Name == "__csrf" {
			r.Header.Set("X-CSRF-Token", cookie.Value)
		}
	}
	response, err := client.Do(r)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, http.StatusAccepted, response.StatusCode)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "address-worker", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, Operations: []string{"install.setup.address"}}, setup.Handle)
	}()
	require.Eventually(t, func() bool {
		w := teammate("mini.local:4000", "192.0.2.10:51000", "")
		return w.Code == http.StatusOK && strings.Contains(w.Body.String(), `{"id":"address","state":"done"}`)
	}, 5*time.Second, 20*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
	mu.Lock()
	require.Equal(t, []string{"0.0.0.0:4000"}, binds)
	mu.Unlock()

	after := teammate("mini.local:4000", "192.0.2.10:51000", "")
	var status struct {
		Address struct {
			Listen  string   `json:"listen"`
			Bind    string   `json:"bind"`
			Origins []string `json:"origins"`
		} `json:"address"`
	}
	require.NoError(t, json.Unmarshal(after.Body.Bytes(), &status))
	require.Equal(t, "network", status.Address.Listen)
	require.Equal(t, "0.0.0.0:4000", status.Address.Bind)
	require.Equal(t, []string{"http://mini.local:4000"}, status.Address.Origins)
	// §17.6a: a LAN peer cannot borrow the saved host through X-Forwarded-Host.
	require.Equal(t, http.StatusMisdirectedRequest, teammate("evil.example:4000", "192.0.2.10:51000", "mini.local:4000").Code)
	require.Equal(t, http.StatusOK, teammate("mini.local:4000", "192.0.2.10:51000", "evil.example").Code)
	// A proxy on this Mac may: its loopback peer names the saved host.
	require.Equal(t, http.StatusOK, teammate("127.0.0.1:4000", "127.0.0.1:51000", "mini.local:4000").Code)
}

// The install's sign-in resolves against the same live origins as setup.
func TestInstallSignInFollowsTheSavedAddress(t *testing.T) {
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.AllowedOrigins = []string{"http://127.0.0.1:4000"}
	saved := []string{"http://127.0.0.1:4000"}
	setup := &routes.GitHubAppSetupHandler{Origins: func() []string { return saved }}
	auth := &routes.AuthHandler{}
	buildRouterCompat(
		cfg, nil, nil,
		&routes.RepoHandler{}, auth, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{GitHubAppSetup: setup},
	)
	require.Equal(t, []string{"http://127.0.0.1:4000"}, auth.Origins())
	saved = append(saved, "http://mini.local:4000")
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://mini.local:4000"}, auth.Origins())

	static := &routes.AuthHandler{}
	buildRouterCompat(
		cfg, nil, nil,
		&routes.RepoHandler{}, static, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
	)
	require.Equal(t, []string{"http://127.0.0.1:4000"}, static.Origins())
}
