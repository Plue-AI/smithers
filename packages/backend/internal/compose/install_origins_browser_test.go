package compose

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// C-INS-01 (T-INS-04, mvp.md M-28) on a composed install: the production
// composition serving its own listeners, real PostgreSQL, the built app
// (SMITHERS_WEB_ROOT, as the launcher serves it), the GitHub fake for sign-in,
// and Chromium driven by apps/app/e2e/real/install-origins.spec.ts. Opt-in:
//
//	SMITHERS_INSTALL_ORIGINS_BROWSER=1 go test ./internal/compose -run TestInstallOriginsBrowser -count=1 -timeout 15m
//
// The install serves loopback on its own port. The owner then sets Address in
// the product (PUT /api/install): the bind is this Mac's LAN address, and the
// origins are that address, this Mac's .local name and an HTTPS origin. The
// network listener is on 4000, the one port the Address contract accepts
// (TestInitialInstallAddressExplicitPort), so 4000 must be free on that
// address. The LAN connections come from this Mac to its own interface
// address, which the install sees as a non-loopback peer. The HTTPS origin is
// a TLS reverse proxy in this process that passes Host and forwards to the
// LAN listener, as the quickstart's Caddy does (§16.3.4); its certificate is
// httptest's, which the browser is told not to verify.
//
// Not qualified here, and left to the reference host (C-INS-01 Setup): a
// second Mac, a proxy certificate the browser trusts, WebKit, and the
// installed host's process tree (launcher, PostgreSQL, egress relay, model
// host, msb).

// installOriginsHost is what the spec reads from SMITHERS_JOURNEY_COMPOSED_HOST.
type installOriginsHost struct {
	Install string `json:"install"`
	Commit  string `json:"commit"`
	// PID is the process that owns every listener of this install.
	PID int `json:"pid"`
	// Loopback is the origin on the Mac. OwnerSet are the origins the owner
	// saves in Address, and Unset reaches the same listener but is never set.
	Loopback string   `json:"loopback"`
	OwnerSet []string `json:"ownerSet"`
	Unset    string   `json:"unset"`
	// Bind is the host the owner saves and Address this Mac's address on
	// that network; Resolve pins each name the browser opens to it.
	Bind    string            `json:"bind"`
	Address string            `json:"address"`
	Resolve map[string]string `json:"resolve"`
	// UntrustedTLS: the HTTPS origin's certificate is outside the browser's trust store.
	UntrustedTLS bool `json:"untrustedTLS"`
	Ports        struct {
		HTTP     int `json:"http"`
		Network  int `json:"network"`
		SSH      int `json:"ssh"`
		Postgres int `json:"postgres"`
	} `json:"ports"`
	SessionCookie string `json:"sessionCookie"`
	// Answer is what the app agent streams over the live channel.
	Answer   string `json:"answer"`
	Evidence string `json:"evidence"`
}

func TestInstallOriginsBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_INSTALL_ORIGINS_BROWSER") != "1" {
		t.Skip("set SMITHERS_INSTALL_ORIGINS_BROWSER=1 for the composed C-INS-01 browser check")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Minute)
	defer cancel()
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	app := filepath.Join(root, "apps/app")
	// The served bundle is this checkout's app, built here unless a built app
	// (a bundle's views/mainview) is named.
	web := os.Getenv("SMITHERS_INSTALL_ORIGINS_WEB_ROOT")
	if web == "" {
		web = filepath.Join(t.TempDir(), "web")
		build := exec.CommandContext(ctx, filepath.Join(app, "node_modules/.bin/vite"), "build", "--configLoader", "runner", "--outDir", web, "--emptyOutDir", "--logLevel", "error")
		build.Dir = app
		output, err := build.CombinedOutput()
		require.NoError(t, err, "build the app: %s", output)
	}
	require.FileExists(t, filepath.Join(web, "index.html"))

	// The address teammates reach this Mac at: the interface of its default
	// route, read without sending a packet.
	address := os.Getenv("SMITHERS_INSTALL_ORIGINS_LAN_ADDRESS")
	if address == "" {
		probe, err := net.Dial("udp4", "192.0.2.1:9")
		require.NoError(t, err, "this Mac needs a network interface for the LAN origin")
		address = probe.LocalAddr().(*net.UDPAddr).IP.String()
		require.NoError(t, probe.Close())
	}
	ip := net.ParseIP(address)
	require.True(t, ip != nil && ip.To4() != nil && !ip.IsLoopback(), "LAN address %q must be a non-loopback IPv4 address of this Mac", address)
	name := "smithers-mac.local"
	if local, err := exec.Command("/usr/sbin/scutil", "--get", "LocalHostName").Output(); err == nil && strings.TrimSpace(string(local)) != "" {
		name = strings.ToLower(strings.TrimSpace(string(local))) + ".local"
	}
	const network = 4000
	held, err := net.Listen("tcp4", net.JoinHostPort(address, strconv.Itoa(network)))
	require.NoError(t, err, "%s:%d must be free: the Address contract fixes the network port", address, network)
	require.NoError(t, held.Close())
	free := func() int {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		require.NoError(t, err)
		defer listener.Close()
		return listener.Addr().(*net.TCPAddr).Port
	}
	httpPort, sshPort := free(), free()
	loopback := fmt.Sprintf("http://localhost:%d", httpPort)
	control := fmt.Sprintf("http://127.0.0.1:%d", httpPort)
	const repository, unset, proxied = "will/canary", "unset-origin.test", "smithers-proxy.test"
	lan, named := fmt.Sprintf("http://%s:%d", address, network), fmt.Sprintf("http://%s:%d", name, network)
	upstream, err := url.Parse(lan)
	require.NoError(t, err)
	// NewSingleHostReverseProxy leaves the request's Host as the browser sent it.
	proxy := httptest.NewTLSServer(httputil.NewSingleHostReverseProxy(upstream))
	t.Cleanup(proxy.Close)
	secure := fmt.Sprintf("https://%s:%d", proxied, proxy.Listener.Addr().(*net.TCPAddr).Port)
	host := installOriginsHost{Install: "composed", Commit: stackJourneyCommit(root), PID: os.Getpid(), Loopback: loopback,
		OwnerSet: []string{lan, named, secure}, Unset: fmt.Sprintf("http://%s:%d", unset, network), Bind: address, Address: address,
		// mDNS answers this Mac's name on every interface; the browser uses the one the bind listens on.
		Resolve: map[string]string{name: address, unset: address, proxied: "127.0.0.1"}, UntrustedTLS: true,
		SessionCookie: "smithers_session", Answer: strings.Join(stackJourneyAnswer, "")}
	host.Ports.HTTP, host.Ports.Network, host.Ports.SSH = httpPort, network, sshPort

	_, _, pool := splitProcessDatabase(t)
	database := os.Getenv("SMITHERS_DATABASE_URL")
	require.NotEmpty(t, database)
	parsed, err := url.Parse(database)
	require.NoError(t, err)
	host.Ports.Postgres, err = strconv.Atoi(parsed.Port())
	require.NoError(t, err)

	// GitHub is the fake: the owner's account, the App installed on the
	// install's repository, and the App's callback URLs for every origin
	// (GitHub fixes them when the App is created, §16.3.3).
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	seed := githubfake.Config{AppID: 42, Slug: "install-origins", OwnerLogin: "will", OwnerKind: "user", ClientID: "origins-client",
		ClientSecret: "origins-secret", WebhookSecret: "origins-webhook", ConversionCode: "origins-manifest",
		PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})),
		Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: repository, Private: true}}}}}
	github, err := githubfake.New(seed)
	require.NoError(t, err)
	t.Cleanup(github.Close)
	callbacks := []string{}
	for _, origin := range append([]string{host.Loopback}, host.OwnerSet...) {
		callbacks = append(callbacks, origin+"/api/auth/github/callback")
	}
	manifest, err := json.Marshal(map[string]any{"redirect_url": host.Loopback + "/setup/github/callback", "callback_urls": callbacks,
		"default_permissions": map[string]string{"emails": "read", "contents": "write", "metadata": "read"}})
	require.NoError(t, err)
	created, err := http.PostForm(github.URL+"/settings/apps/new", url.Values{"manifest": {string(manifest)}})
	require.NoError(t, err)
	created.Body.Close()
	require.Equal(t, http.StatusOK, created.StatusCode)
	converted, err := http.Post(github.URL+"/app-manifests/"+seed.ConversionCode+"/conversions", "application/json", nil)
	require.NoError(t, err)
	converted.Body.Close()
	require.Equal(t, http.StatusCreated, converted.StatusCode)
	codec, err := webhook.NewSecretCodec(os.Getenv("SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY"))
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(ctx, services.GitHubAppCredentials{ID: seed.AppID, Slug: seed.Slug, OwnerLogin: seed.OwnerLogin, OwnerKind: seed.OwnerKind,
		ClientID: seed.ClientID, ClientSecret: seed.ClientSecret, WebhookSecret: seed.WebhookSecret, PEM: seed.PrivateKeyPEM}))
	require.NoError(t, credentials.SetInstallation(ctx, 91))
	require.NoError(t, credentials.SaveCallbackURLs(ctx, callbacks))

	// The owner, claimed and bound to the repository with an active stack.
	// Every session in this check comes from a GitHub sign-in in the browser.
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "will", LowerUsername: "will", DisplayName: "Will"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "canary", LowerName: "canary", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, statement := range []string{
		`UPDATE users SET is_active=true WHERE id=$1`,
		`INSERT INTO self_host_owners(user_id) VALUES($1)`,
		`INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos','7','{"login":"will"}')`,
	} {
		_, err = pool.Exec(ctx, statement, owner.ID)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state,landed_main) VALUES($1,$2,'active',$3)`, repo.ID, owner.ID, strings.Repeat("a", 40))
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"will","repository_name":"canary","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano))
	for _, setting := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: setting, Value: []byte(binding)}))
	}

	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
		t.Setenv("SMITHERS_FFI_LIBRARY_PATH", filepath.Join(root, "target/release/libsmithers_ffi.dylib"))
	}
	for variable, value := range map[string]string{
		"SMITHERS_SERVER_ADDR": fmt.Sprintf("127.0.0.1:%d", httpPort), "SMITHERS_PUBLIC_URL": loopback,
		// Loopback on this install's own port; configuration keeps both
		// spellings known whatever origins the owner saves.
		"SMITHERS_SERVER_ALLOWED_ORIGINS": loopback + "," + control,
		"SMITHERS_SSH_ADDR":               fmt.Sprintf("127.0.0.1:%d", sshPort), "SMITHERS_SSH_HOST_KEY_DIR": t.TempDir(),
		"SMITHERS_WEB_ROOT":                 web,
		"SMITHERS_AUTH_GITHUB_API_BASE_URL": github.URL, "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL": github.URL, "SMITHERS_GITHUB_APP_API_BASE_URL": github.URL,
	} {
		t.Setenv(variable, value)
	}
	host.Evidence = filepath.Join(root, ".artifacts/checks/C-INS-01/composed", time.Now().UTC().Format("20060102T150405Z"))
	require.NoError(t, os.MkdirAll(host.Evidence, 0o700))
	backendLog, err := os.Create(filepath.Join(host.Evidence, "backend.log"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = backendLog.Close() })

	// The install owns its listeners (RunWithOptions, as the shipped binary
	// runs), so the Address the owner saves opens real sockets.
	profile := microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}
	serving, stop := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() {
		finished <- RunWithOptions(serving, nil, backendLog, backendLog, Options{ChatHost: stackJourneyChatHost{interval: time.Second},
			Workspace: new(liveBrowserAdmissionRuntime), HostProfile: &profile, FlowHostProductAPIURL: control})
	}()
	t.Cleanup(func() {
		stop()
		select {
		case err := <-finished:
			require.NoError(t, err)
		case <-time.After(30 * time.Second):
			t.Error("the install did not stop")
		}
	})
	require.Eventually(t, func() bool {
		select {
		case err := <-finished:
			finished <- err
			t.Errorf("the install stopped before it was ready: %v", err)
			return true
		default:
		}
		response, err := http.Get(control + "/readyz")
		if err != nil {
			return false
		}
		response.Body.Close()
		return response.StatusCode == http.StatusOK
	}, 90*time.Second, 200*time.Millisecond, "the install did not become ready; see %s", backendLog.Name())
	if t.Failed() {
		t.FailNow()
	}

	descriptor, err := json.Marshal(host)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(host.Evidence, "install.json"), descriptor, 0o600))
	hostFile := filepath.Join(t.TempDir(), "install-origins-host.json")
	require.NoError(t, os.WriteFile(hostFile, descriptor, 0o600))
	playwright := exec.CommandContext(ctx, filepath.Join(app, "node_modules/.bin/playwright"), "test", "--config", "playwright.real.config.ts", "e2e/real/install-origins.spec.ts")
	playwright.Dir = app
	environment := slices.DeleteFunc(os.Environ(), func(variable string) bool {
		return strings.HasPrefix(variable, "SMITHERS_REAL_") || strings.HasPrefix(variable, "SMITHERS_JOURNEY") || strings.HasPrefix(variable, "CI=")
	})
	playwright.Env = append(environment, "SMITHERS_REAL_BASE_URL="+control, "SMITHERS_REAL_E2E_HOST=local", "SMITHERS_REAL_AUTH_KIND=owner-session",
		"SMITHERS_JOURNEY=install-origins.spec.ts", "SMITHERS_JOURNEY_COMPOSED_HOST="+hostFile, "SMITHERS_REAL_E2E_REVISION="+host.Commit,
		"SMITHERS_REAL_TEST_GREP=@real-scenario:"+regexp.QuoteMeta("journey-install-origins")+`(?:\s|$)`,
		"SMITHERS_REAL_E2E_REPORT="+filepath.Join(host.Evidence, "results.json"), "SMITHERS_REAL_E2E_ARTIFACTS="+filepath.Join(host.Evidence, "artifacts"))
	var output bytes.Buffer
	playwright.Stdout, playwright.Stderr = &output, &output
	err = playwright.Run()
	fmt.Print(output.String())
	require.NoError(t, err, "install-origins.spec.ts against the composed install; evidence %s", host.Evidence)

	// The owner's last Address, read from PostgreSQL beside the browser's
	// account: the HTTPS origin was removed, and the install never restarted.
	var bind string
	var origins []string
	for setting, target := range map[string]any{"bind": &bind, "public_origins": &origins} {
		row, err := q.GetInstallSetting(context.Background(), setting)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(row.Value, target))
	}
	require.Equal(t, net.JoinHostPort(host.Bind, strconv.Itoa(network)), bind)
	require.Equal(t, []string{lan, named}, origins)
	require.Equal(t, os.Getpid(), host.PID)
	t.Logf("install-origins.spec.ts passed against the composed install; evidence %s", host.Evidence)
}
