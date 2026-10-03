package compose

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// These tests drive the install's GitHub sign-in end to end: the real
// composition on a real listener, real PostgreSQL, and an httptest GitHub
// standing in for github.com (OAuth web flow, GET /user, the App's
// installation token and the collaborator permission read).

// signInGitHub is the fake GitHub. Each person is a login with a numeric id
// and a repository permission; "502" makes the permission read fail.
type signInGitHub struct {
	server *httptest.Server
	mu     sync.Mutex
	people map[string]signInPerson
	log    []string
}

type signInPerson struct {
	id         int64
	permission string
	roleName   string
}

const (
	signInRepoOwner      = "acme"
	signInRepoName       = "widgets"
	signInInstallationID = 4242
	signInInstallToken   = "ghs-install-token"
)

func newSignInGitHub(t *testing.T) *signInGitHub {
	t.Helper()
	g := &signInGitHub{people: map[string]signInPerson{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		login := strings.TrimPrefix(r.FormValue("code"), "code-")
		g.record("oauth exchange " + login)
		writeJSON(w, http.StatusOK, map[string]any{"access_token": "gho-" + login, "token_type": "bearer"})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		login := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer gho-")
		person, ok := g.person(login)
		g.record("user " + login)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": person.id, "login": login, "name": login})
	})
	mux.HandleFunc("GET /user/emails", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/installation", func(w http.ResponseWriter, r *http.Request) {
		g.record("installation " + r.PathValue("owner") + "/" + r.PathValue("repo"))
		if r.PathValue("owner") != signInRepoOwner || r.PathValue("repo") != signInRepoName {
			writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": signInInstallationID, "account": map[string]any{"login": signInRepoOwner, "type": "Organization"}})
	})
	mux.HandleFunc(fmt.Sprintf("POST /app/installations/%d/access_tokens", signInInstallationID), func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		g.record("installation token " + string(body))
		writeJSON(w, http.StatusCreated, map[string]any{"token": signInInstallToken, "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("GET /repos/{owner}/{repo}/collaborators/{login}/permission", func(w http.ResponseWriter, r *http.Request) {
		login := r.PathValue("login")
		g.record("permission " + login + " with " + r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") != "Bearer "+signInInstallToken {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
			return
		}
		person, ok := g.person(login)
		switch {
		case !ok || person.permission == "none":
			writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
		case person.permission == "502":
			writeJSON(w, http.StatusBadGateway, map[string]any{"message": "Server Error"})
		default:
			writeJSON(w, http.StatusOK, map[string]any{"permission": person.permission, "role_name": person.roleName})
		}
	})
	g.server = httptest.NewServer(mux)
	t.Cleanup(g.server.Close)
	return g
}

func (g *signInGitHub) set(login string, id int64, permission string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.people[login] = signInPerson{id: id, permission: permission, roleName: permission}
}

func (g *signInGitHub) person(login string) (signInPerson, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	person, ok := g.people[login]
	return person, ok
}

func (g *signInGitHub) record(line string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.log = append(g.log, line)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// signInInstall is one fresh install served on one listener.
type signInInstall struct {
	t          *testing.T
	origin     string
	listener   string
	pool       *pgxpool.Pool
	github     *signInGitHub
	setupToken string
	stdout     *lockedBuffer
	logs       *lockedBuffer
	bodies     *lockedBuffer
}

var setupURLLine = regexp.MustCompile(`(?m)^Setup URL: (\S+)/setup\?token=([A-Za-z0-9_-]+)$`)

// startSignInInstall boots a fresh install whose HTTP listener binds host,
// with the install's repository already recorded.
func startSignInInstall(t *testing.T, host string) *signInInstall {
	t.Helper()
	install := startSignInInstallWithoutRepository(t, host)
	install.recordRepository()
	return install
}

// recordRepository records the install's repository, as setup does once the
// owner installs the App on it (spec §16.2 step 4).
func (i *signInInstall) recordRepository() {
	i.t.Helper()
	require.NoError(i.t, services.PutInstallRepository(context.Background(), db.New(i.pool), signInRepoOwner, signInRepoName))
}

// startSignInInstallWithoutRepository boots a fresh install as the installer
// leaves it: no owner and no repository.
func startSignInInstallWithoutRepository(t *testing.T, host string) *signInInstall {
	t.Helper()
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	github := newSignInGitHub(t)

	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	require.NoError(t, err)
	origin := "http://" + listener.Addr().String()

	repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(repoHost.Close)
	appKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	appPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(appKey)})
	// The App setup preceding owner sign-in persists sealed credentials and
	// registered callbacks. Legacy credential environment variables no longer
	// configure an install (T-GH-12); exercise the production store.
	codec, err := webhook.NewSecretCodec("owner-signin-webhook-key")
	require.NoError(t, err)
	store := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, store.Save(context.Background(), services.GitHubAppCredentials{
		ID: 1234, Slug: "owner-signin", OwnerLogin: signInRepoOwner, OwnerKind: "org",
		PEM: string(appPEM), ClientID: "Iv1.owner-signin", ClientSecret: "owner-signin-client-secret",
		WebhookSecret: "owner-signin-webhook", InstallationID: signInInstallationID,
	}))
	require.NoError(t, store.SaveCallbackURLs(context.Background(), []string{origin + "/api/auth/github/callback"}))
	for name, value := range map[string]string{
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_PUBLIC_URL":                    origin,
		"SMITHERS_SERVER_ADDR":                   listener.Addr().String(),
		"SMITHERS_SERVER_ALLOWED_ORIGINS":        origin,
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT":       "10s",
		"SMITHERS_REPO_HOST_URL":                 repoHost.URL,
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "owner-signin-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "owner-signin-callback",
		"SMITHERS_AUTH_SESSION_SECRET":           "owner-signin-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "owner-signin-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "owner-signin-webhook-key",
		"SMITHERS_AUTH_COOKIE_SECURE":            "false",
		"SMITHERS_AUTH_GITHUB_REDIRECT_URL":      origin + "/api/auth/github/callback",
		"SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL":    github.server.URL,
		"SMITHERS_AUTH_GITHUB_API_BASE_URL":      github.server.URL,
		"SMITHERS_GITHUB_APP_API_BASE_URL":       github.server.URL,
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "false",
		"SMITHERS_OTEL_EXPORTER":                 "none",
		"SMITHERS_METRICS_TOKEN":                 "owner-signin-metrics",
		"SMITHERS_METRICS_ADDR":                  "",
	} {
		t.Setenv(name, value)
	}
	preserveSlog(t)

	install := &signInInstall{t: t, origin: origin, listener: host, pool: pool, github: github,
		stdout: &lockedBuffer{}, logs: &lockedBuffer{}, bodies: &lockedBuffer{}}
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan http.Handler, 1)
	finished := make(chan struct{})
	var runErr error
	remote := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repoHost.URL}, "owner-signin-repo")
	go func() {
		runErr = StartWithOptions(ctx, nil, install.stdout, install.logs, Options{Repository: remote},
			func(handler http.Handler) { ready <- handler })
		close(finished)
	}()
	var handler http.Handler
	select {
	case handler = <-ready:
	case <-finished:
		t.Fatalf("install stopped before ready: %v\n%s", runErr, install.logs.String())
	case <-time.After(60 * time.Second):
		t.Fatal("install did not become ready")
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = server.Shutdown(shutdown)
		cancel()
		select {
		case <-finished:
			require.NoError(t, runErr)
		case <-time.After(30 * time.Second):
			t.Error("install did not stop")
		}
	})

	match := setupURLLine.FindStringSubmatch(install.stdout.String())
	require.NotNil(t, match, "the install printed no setup URL: %q", install.stdout.String())
	require.Equal(t, origin, match[1])
	install.setupToken = match[2]
	return install
}

// signInResult is one browser sign-in attempt.
type signInResult struct {
	login   string
	status  int
	body    string
	session *http.Cookie
	browser *http.Client
}

// browser is a cookie-keeping client that stops at every redirect.
func (i *signInInstall) browser() *http.Client {
	jar, err := cookiejar.New(nil)
	require.NoError(i.t, err)
	return &http.Client{Jar: jar, Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// start opens GET /api/auth/github, carrying token when it is not empty.
// It answers the GitHub state, or the refusal.
func (i *signInInstall) start(browser *http.Client, token string) (state string, refusal *signInResult) {
	i.t.Helper()
	target := i.origin + "/api/auth/github"
	if token != "" {
		target += "?setup_token=" + url.QueryEscape(token)
	}
	response, err := browser.Get(target)
	require.NoError(i.t, err)
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	i.bodies.Write(body)
	if response.StatusCode != http.StatusFound {
		return "", &signInResult{status: response.StatusCode, body: string(body), session: sessionCookie(response)}
	}
	location, err := url.Parse(response.Header.Get("Location"))
	require.NoError(i.t, err)
	require.Equal(i.t, i.github.server.URL+"/login/oauth/authorize", location.Scheme+"://"+location.Host+location.Path)
	return location.Query().Get("state"), nil
}

// finish returns from GitHub to the callback as login.
func (i *signInInstall) finish(browser *http.Client, login, state string) signInResult {
	i.t.Helper()
	response, err := browser.Get(i.origin + "/api/auth/github/callback?code=code-" + login + "&state=" + url.QueryEscape(state))
	require.NoError(i.t, err)
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	i.bodies.Write(body)
	return signInResult{login: login, status: response.StatusCode, body: string(body), session: sessionCookie(response), browser: browser}
}

// signIn runs one whole sign-in as login.
func (i *signInInstall) signIn(login, token string) signInResult {
	i.t.Helper()
	browser := i.browser()
	state, refusal := i.start(browser, token)
	result := signInResult{login: login, browser: browser}
	if refusal != nil {
		result.status, result.body, result.session = refusal.status, refusal.body, refusal.session
	} else {
		result = i.finish(browser, login, state)
	}
	evidence, _ := json.Marshal(map[string]any{"login": login, "listener": i.listener, "status": result.status,
		"body": result.body, "session_cookie": result.session != nil})
	i.t.Logf("signin %s", evidence)
	return result
}

func sessionCookie(response *http.Response) *http.Cookie {
	for _, cookie := range response.Cookies() {
		if cookie.Name == "smithers_session" && cookie.Value != "" && cookie.MaxAge >= 0 {
			return cookie
		}
	}
	return nil
}

func (i *signInInstall) owners() []string {
	i.t.Helper()
	rows, err := i.pool.Query(context.Background(), `SELECT login FROM members WHERE role = 'owner' ORDER BY id`)
	require.NoError(i.t, err)
	var logins []string
	for rows.Next() {
		var login string
		require.NoError(i.t, rows.Scan(&login))
		logins = append(logins, login)
	}
	require.NoError(i.t, rows.Err())
	return logins
}

func (i *signInInstall) memberCount() int {
	var count int
	require.NoError(i.t, i.pool.QueryRow(context.Background(), `SELECT count(*) FROM members`).Scan(&count))
	return count
}

func (i *signInInstall) setupTokenStored() bool {
	var count int
	require.NoError(i.t, i.pool.QueryRow(context.Background(), `SELECT count(*) FROM install_settings WHERE key = 'setup_token'`).Scan(&count))
	return count == 1
}

// whoAmI reads GET /api/user with the browser's session.
func (i *signInInstall) whoAmI(browser *http.Client) (int, string) {
	response, err := browser.Get(i.origin + "/api/user")
	require.NoError(i.t, err)
	defer response.Body.Close()
	var user struct {
		Username string `json:"username"`
	}
	_ = json.NewDecoder(response.Body).Decode(&user)
	return response.StatusCode, user.Username
}

// requireRefused checks a refusal: the typed envelope, no session cookie.
func requireRefused(t *testing.T, result signInResult, status int, code, message string) {
	t.Helper()
	require.Equal(t, status, result.status, result.body)
	var envelope struct {
		Code    string `json:"code"`
		Fault   string `json:"fault"`
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal([]byte(result.body), &envelope), result.body)
	require.Equal(t, code, envelope.Code, result.body)
	require.NotEmpty(t, envelope.Fault, result.body)
	require.Contains(t, envelope.Message, message)
	require.Nil(t, result.session, "a refusal must not set a session cookie")
}

// requireTokenSecret checks C-SEC-04: the setup token reaches no log line and
// no response body.
func (i *signInInstall) requireTokenSecret() {
	i.t.Helper()
	require.NotContains(i.t, i.logs.String(), i.setupToken, "the setup token reached the log")
	require.NotContains(i.t, i.bodies.String(), i.setupToken, "the setup token reached a response body")
}

// lanAddress is a non-loopback IPv4 address of this machine.
func lanAddress(t *testing.T) string {
	t.Helper()
	addresses, err := net.InterfaceAddrs()
	require.NoError(t, err)
	for _, address := range addresses {
		if network, ok := address.(*net.IPNet); ok && !network.IP.IsLoopback() && network.IP.To4() != nil && !network.IP.IsLinkLocalUnicast() {
			return network.IP.String()
		}
	}
	t.Skip("this machine has no non-loopback IPv4 address to bind a LAN listener")
	return ""
}

func TestOwnerSignInClaimsTheInstallWithTheSetupToken(t *testing.T) {
	for _, listener := range []struct{ name, host string }{{"loopback", "127.0.0.1"}, {"lan", ""}} {
		t.Run(listener.name, func(t *testing.T) {
			host := listener.host
			if host == "" {
				host = lanAddress(t)
			}
			install := startSignInInstall(t, host)
			install.github.set("own", 501, "admin")
			require.True(t, install.setupTokenStored())

			claimed := install.signIn("own", install.setupToken)
			require.Equal(t, http.StatusFound, claimed.status, claimed.body)
			require.NotNil(t, claimed.session, "the claim signs the owner in")
			require.Equal(t, []string{"own"}, install.owners())
			require.Equal(t, 1, install.memberCount())
			require.False(t, install.setupTokenStored(), "the claim deletes the setup token")
			var githubID int64
			var unixUID int32
			require.NoError(t, install.pool.QueryRow(context.Background(),
				`SELECT github_user_id, unix_uid FROM members WHERE role = 'owner'`).Scan(&githubID, &unixUID))
			require.Equal(t, int64(501), githubID)
			require.Equal(t, int32(20000), unixUID)
			status, username := install.whoAmI(claimed.browser)
			require.Equal(t, http.StatusOK, status)
			require.Equal(t, "own", username)

			// The owner signs in again later without the token.
			again := install.signIn("own", "")
			require.Equal(t, http.StatusFound, again.status, again.body)
			require.NotNil(t, again.session)
			require.Equal(t, []string{"own"}, install.owners())
			install.requireTokenSecret()
		})
	}
}

func TestOwnerSignInRefusesAClaimWithoutTheSetupToken(t *testing.T) {
	install := startSignInInstall(t, "127.0.0.1")
	install.github.set("dave", 504, "write")
	install.github.set("own", 501, "admin")

	requireRefused(t, install.signIn("dave", ""), http.StatusForbidden, "setup_token_invalid", "setup URL")
	requireRefused(t, install.signIn("own", "not-the-setup-token"), http.StatusForbidden, "setup_token_invalid", "setup URL")
	require.Empty(t, install.owners())
	require.Zero(t, install.memberCount())
	require.True(t, install.setupTokenStored(), "a refused claim leaves the token for the owner")
	for _, line := range install.github.log {
		require.NotContains(t, line, "permission", "a sign-in without the token is refused before asking GitHub")
	}

	// A token with one character changed is still wrong.
	flipped := []byte(install.setupToken)
	flipped[0] ^= 1
	requireRefused(t, install.signIn("own", string(flipped)), http.StatusForbidden, "setup_token_invalid", "setup URL")
	require.Zero(t, install.memberCount())
	install.requireTokenSecret()
}

func TestOwnerSignInConcurrentClaimsYieldOneOwner(t *testing.T) {
	install := startSignInInstall(t, "127.0.0.1")
	install.github.set("own", 501, "admin")
	install.github.set("eve", 505, "admin")

	first, second := install.browser(), install.browser()
	firstState, refusal := install.start(first, install.setupToken)
	require.Nil(t, refusal)
	secondState, refusal := install.start(second, install.setupToken)
	require.Nil(t, refusal)

	results := make([]signInResult, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); results[0] = install.finish(first, "own", firstState) }()
	go func() { defer wg.Done(); results[1] = install.finish(second, "eve", secondState) }()
	wg.Wait()

	var admitted, refused []signInResult
	for _, result := range results {
		if result.status == http.StatusFound {
			admitted = append(admitted, result)
		} else {
			refused = append(refused, result)
		}
	}
	require.Len(t, admitted, 1, "exactly one concurrent claim wins: %+v", results)
	require.Len(t, refused, 1, "exactly one concurrent claim loses: %+v", results)
	require.NotNil(t, admitted[0].session)
	require.Equal(t, http.StatusForbidden, refused[0].status, refused[0].body)
	require.Nil(t, refused[0].session)
	require.Equal(t, []string{admitted[0].login}, install.owners())
	require.Equal(t, 1, install.memberCount())
	require.False(t, install.setupTokenStored())
	install.requireTokenSecret()
}

func TestOwnerSignInTokenDiesAtTheClaim(t *testing.T) {
	install := startSignInInstall(t, "127.0.0.1")
	install.github.set("own", 501, "admin")
	install.github.set("eve", 505, "admin")

	require.Equal(t, http.StatusFound, install.signIn("own", install.setupToken).status)
	require.False(t, install.setupTokenStored(), "the claim deletes the digest row")

	// Replaying the token claims nothing: the install has its owner.
	requireRefused(t, install.signIn("eve", install.setupToken), http.StatusForbidden, "not_a_member", "not a member")
	require.Equal(t, []string{"own"}, install.owners())
	require.Equal(t, 1, install.memberCount())
	install.requireTokenSecret()
}

func TestOwnerSignInNeedsPushOnGitHub(t *testing.T) {
	install := startSignInInstall(t, "127.0.0.1")
	install.github.set("own", 501, "read")

	// Without push access the claim is refused and the token survives.
	readOnly := install.signIn("own", install.setupToken)
	requireRefused(t, readOnly, http.StatusForbidden, "needs_github_access", "needs access on GitHub")
	require.Contains(t, readOnly.body, `"fix":"https://github.com/acme/widgets/settings/access"`)
	require.Empty(t, install.owners())
	require.True(t, install.setupTokenStored())

	// maintain is push access: GitHub's role_name says so where the legacy
	// permission field reads write.
	install.github.mu.Lock()
	install.github.people["own"] = signInPerson{id: 501, permission: "write", roleName: "maintain"}
	install.github.mu.Unlock()
	require.Equal(t, http.StatusFound, install.signIn("own", install.setupToken).status)
	require.Equal(t, []string{"own"}, install.owners())

	// Losing push access later refuses the owner's next sign-in.
	install.github.set("own", 501, "read")
	requireRefused(t, install.signIn("own", ""), http.StatusForbidden, "needs_github_access", "needs access on GitHub")

	// A GitHub failure refuses too (fail closed), with the GitHub class.
	install.github.set("own", 501, "502")
	requireRefused(t, install.signIn("own", ""), http.StatusBadGateway, "github_unavailable", "bad gateway")
	require.Equal(t, []string{"own"}, install.owners())
	install.requireTokenSecret()
}

func TestOwnerSignInRefusesASecondGitHubUser(t *testing.T) {
	install := startSignInInstall(t, "127.0.0.1")
	install.github.set("own", 501, "admin")
	install.github.set("dave", 504, "write")
	require.Equal(t, http.StatusFound, install.signIn("own", install.setupToken).status)

	refused := install.signIn("dave", "")
	requireRefused(t, refused, http.StatusForbidden, "not_a_member", "not a member")
	require.Equal(t, []string{"own"}, install.owners())
	require.Equal(t, 1, install.memberCount())
	var daveUsers int
	require.NoError(t, install.pool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE lower_username = 'dave'`).Scan(&daveUsers))
	require.Zero(t, daveUsers, "a refused sign-in creates no account")
	install.requireTokenSecret()
}

// Setup claims the owner before the owner picks the repository (spec §16.2
// steps 4): the claim and the owner's later sign-ins need no repository, and
// push is checked from the moment one is recorded.
func TestOwnerSignInClaimsBeforeTheRepositoryIsChosen(t *testing.T) {
	install := startSignInInstallWithoutRepository(t, "127.0.0.1")
	install.github.set("own", 501, "read")
	install.github.set("dave", 504, "write")

	requireRefused(t, install.signIn("dave", ""), http.StatusForbidden, "setup_token_invalid", "setup URL")
	claimed := install.signIn("own", install.setupToken)
	require.Equal(t, http.StatusFound, claimed.status, claimed.body)
	require.NotNil(t, claimed.session)
	require.Equal(t, []string{"own"}, install.owners())
	require.False(t, install.setupTokenStored())
	again := install.signIn("own", "")
	require.Equal(t, http.StatusFound, again.status, again.body)
	requireRefused(t, install.signIn("dave", ""), http.StatusForbidden, "not_a_member", "not a member")
	for _, line := range install.github.log {
		require.NotContains(t, line, "permission", "no repository, so no push check")
	}

	install.recordRepository()
	requireRefused(t, install.signIn("own", ""), http.StatusForbidden, "needs_github_access", "needs access on GitHub")
	install.github.set("own", 501, "write")
	require.Equal(t, http.StatusFound, install.signIn("own", "").status)
	install.requireTokenSecret()
}

// The install boots without any bootstrap token, and the password owner
// routes are gone.
func TestInstallHasNoLocalPasswordRoutes(t *testing.T) {
	install := startSignInInstall(t, "127.0.0.1")
	client := install.browser()
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/auth/local/status"},
		{http.MethodPost, "/api/auth/local/bootstrap"},
		{http.MethodPost, "/api/auth/local/login"},
		{http.MethodPost, "/api/auth/local/token"},
		{http.MethodPost, "/api/auth/local/password"},
	} {
		request, err := http.NewRequest(route.method, install.origin+route.path,
			strings.NewReader(`{"username":"owner","password":"owner password","bootstrap_token":"x"}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		require.NoError(t, err)
		_ = response.Body.Close()
		require.Equal(t, http.StatusNotFound, response.StatusCode, "%s %s", route.method, route.path)
	}
	require.Zero(t, install.memberCount())
}
