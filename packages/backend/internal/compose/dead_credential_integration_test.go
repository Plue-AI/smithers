package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// A dead credential is no existence oracle (spec §5.2.1; smithers-8a's
// ruling on #3559). Through the composed install router and real
// PostgreSQL, a request that carries a session cookie or bearer token the
// server no longer honours (unknown, expired, revoked, a suspended member's,
// a removed member's) gets 401 unauthenticated, byte-identical for a private
// repository, a missing repository and a missing owner. A request with no
// credential keeps the repository routes' 404 concealment. The refusal is
// decided in AuthLoader from the credential alone, before the router reaches
// LoadRepoContext, so the three columns run the same code and no repository
// query: there is no timing difference to measure by construction. A dead
// cookie does not break sign-in or public routes.
func TestDeadCredentialRepoRoutesComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
		require.NoError(t, err)
		return created
	}
	owner, writer, maintainer, keeper, outsider := user("owner"), user("writer"), user("maintainer"), user("admin"), user("outsider")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos','101','{}')`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-04T22:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
	}{{owner, "admin"}, {writer, "write"}, {maintainer, "admin"}, {keeper, "admin"}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,$3,$4,$5)`,
			repo.ID, row.user.ID, row.permission, rosterGitHubID(row.user.Username), row.user.Username)
		require.NoError(t, err)
	}
	github := &rosterGitHub{roles: map[string]string{"owner": "admin", "writer": "write", "maintainer": "maintain", "admin": "admin", "reader": "write"}}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}}

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionSecret = "fixture-secret"
	cfg.Auth.SessionCookieName = "session"
	svc := services.NewAuthService(q, cfg.Auth, nil, auth.NewGitHubClient(ownerOAuthCredentials{"client", "secret"}, "", provider.URL, provider.URL))
	svc.InstallSetup = &services.InstallSetupSessions{Pool: pool}
	svc.Members = members
	authHandler := &routes.AuthHandler{Service: svc, AuthConfig: cfg.Auth, InstallSetup: svc.InstallSetup}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	secrets := &routes.SecretHandler{Service: services.NewSecretService(q, nil)}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, authHandler, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, secrets, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}})
	server.Start()
	defer server.Close()

	session := func(u db.User, key string, expires time.Time) string {
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: expires})
		require.NoError(t, err)
		return key
	}
	token := func(u db.User, name string, expires time.Time) string {
		seed := sha256.Sum256([]byte(u.Username + "-" + name))
		raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
		hash := sha256.Sum256([]byte(raw))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: name, TokenHash: hex.EncodeToString(hash[:]),
			TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: "all", ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}})
		require.NoError(t, err)
		return raw
	}
	later, earlier := time.Now().Add(time.Hour), time.Now().Add(-time.Hour)
	type credential struct{ cookie, bearer string }
	ownerSession := credential{cookie: session(owner, "owner-cookie", later)}
	signedOut := credential{cookie: session(keeper, "signed-out-cookie", later)}
	revokedToken := credential{bearer: token(keeper, "revoked", later)}
	suspendedSession, suspendedToken := credential{cookie: session(writer, "writer-cookie", later)}, credential{bearer: token(writer, "pat", later)}
	removedSession, removedToken := credential{cookie: session(maintainer, "maintainer-cookie", later)}, credential{bearer: token(maintainer, "pat", later)}

	request := func(c credential, method, path, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, origin+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		if c.cookie != "" {
			req.Header.Set("X-CSRF-Token", "csrf-fixture")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
			req.AddCookie(&http.Cookie{Name: "session", Value: c.cookie})
		}
		if c.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+c.bearer)
		}
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Do(req)
		require.NoError(t, err)
		return res
	}
	// raw is the response as a client sees it, minus the headers that differ
	// per request by design (Date, the request id) and any named in skip.
	raw := func(res *http.Response, skip ...string) string {
		t.Helper()
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		var out bytes.Buffer
		fmt.Fprintf(&out, "%d\n", res.StatusCode)
		names := make([]string, 0, len(res.Header))
		for name := range res.Header {
			if name == "Date" || strings.EqualFold(name, "X-Request-Id") || slices.Contains(skip, name) {
				continue
			}
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			fmt.Fprintf(&out, "%s: %s\n", name, strings.Join(res.Header.Values(name), ", "))
		}
		out.WriteString("\n")
		out.Write(body)
		return out.String()
	}

	// The three ways a credential dies with its member: signed out (the row
	// is deleted, as logout does), a removed maintainer, a suspended member.
	_, err = pool.Exec(ctx, `DELETE FROM auth_sessions WHERE session_key=$1`, hex.EncodeToString(func() []byte { d := sha256.Sum256([]byte(signedOut.cookie)); return d[:] }()))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE user_id=$1 AND name='revoked'`, keeper.ID)
	require.NoError(t, err)
	res := request(ownerSession, "DELETE", "/api/members/maintainer", "")
	require.Equal(t, 204, res.StatusCode, raw(res))
	github.mu.Lock()
	github.roles["writer"] = "read"
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))

	columns := []struct{ name, path string }{
		{"existing private repo", "/api/repos/owner/app"},
		{"missing repo", "/api/repos/owner/ghost"},
		{"missing owner", "/api/repos/nobody/ghost"},
	}
	routesUnder := []struct{ method, suffix, body string }{
		{"POST", "/secrets", `{"name":"PROBE","value":"v"}`},
		{"GET", "", ""},
	}
	dead := []struct {
		name string
		who  credential
	}{
		{"unknown cookie", credential{cookie: "never-issued-cookie"}},
		{"expired cookie", credential{cookie: session(keeper, "expired-cookie", earlier)}},
		{"revoked cookie", signedOut},
		{"suspended member's cookie", suspendedSession},
		{"removed member's cookie", removedSession},
		{"unknown token", credential{bearer: "smithers_" + strings.Repeat("0", 40)}},
		{"expired token", credential{bearer: token(keeper, "expired", earlier)}},
		{"revoked token", revokedToken},
		{"suspended member's token", suspendedToken},
		{"removed member's token", removedToken},
	}
	const unauthenticated = `{"code":"unauthenticated","class":"permission","fault":"user","message":"Sign in again"}` + "\n"
	for _, tc := range dead {
		t.Run(tc.name, func(t *testing.T) {
			for _, route := range routesUnder {
				var first string
				for _, column := range columns {
					got := raw(request(tc.who, route.method, column.path+route.suffix, route.body))
					require.True(t, strings.HasPrefix(got, "401\n"), "%s %s%s:\n%s", route.method, column.path, route.suffix, got)
					require.True(t, strings.HasSuffix(got, "\n\n"+unauthenticated), got)
					if first == "" {
						first = got
						t.Logf("%s %s -> %q", route.method, column.path+route.suffix, got)
						continue
					}
					require.Equal(t, first, got, "%s: %s differs from %s", route.method, column.name, columns[0].name)
				}
			}
		})
	}

	// No credential keeps the 404 concealment, also identical per column but
	// for the anonymous rate-limit counter, which each request advances. (The
	// dead-credential rows above carry no counter: they are refused before
	// the rate limiter runs.)
	for _, route := range routesUnder {
		var first string
		for _, column := range columns {
			got := raw(request(credential{}, route.method, column.path+route.suffix, route.body), "X-Ratelimit-Remaining", "X-Ratelimit-Reset")
			require.True(t, strings.HasPrefix(got, "404\n"), got)
			require.Contains(t, got, `"code":"not_found"`)
			if first == "" {
				first = got
				continue
			}
			require.Equal(t, first, got, "no credential: %s", column.name)
		}
	}

	// Live credentials are not dead ones. A live non-member is refused by the
	// install's member boundary, also from the credential alone (403, same
	// per column); a live maintainer writes to the repository and finds no
	// missing one.
	outsiderSession := credential{cookie: session(outsider, "outsider-cookie", later)}
	var first string
	for _, column := range columns {
		got := raw(request(outsiderSession, "POST", column.path+"/secrets", `{"name":"PROBE","value":"v"}`))
		require.True(t, strings.HasPrefix(got, "403\n"), got)
		if first == "" {
			first = got
			continue
		}
		require.Equal(t, first, got, "live non-member: %s", column.name)
	}
	keeperSession := credential{cookie: session(keeper, "keeper-cookie", later)}
	res = request(keeperSession, "POST", "/api/repos/owner/app/secrets", `{"name":"PROBE","value":"v"}`)
	require.Equal(t, 201, res.StatusCode, raw(res))
	for _, column := range columns[1:] {
		got := raw(request(keeperSession, "POST", column.path+"/secrets", `{"name":"PROBE","value":"v"}`))
		require.True(t, strings.HasPrefix(got, "404\n"), got)
	}
	var stored int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_secrets`).Scan(&stored))
	require.Equal(t, 1, stored, "only the live maintainer wrote")

	// An authenticated, non-repository route refuses a dead cookie the same way.
	for _, tc := range dead {
		res := request(tc.who, "GET", "/api/user/orgs", "")
		got := raw(res)
		require.True(t, strings.HasPrefix(got, "401\n"), "%s: %s", tc.name, got)
		require.Contains(t, got, `"code":"unauthenticated"`, tc.name)
	}

	// Public routes answer a dead cookie exactly as they answer no cookie.
	stale := credential{cookie: "never-issued-cookie"}
	for _, path := range []string{"/health", "/api/health", "/api/meta/failure-codes"} {
		require.Equal(t, raw(request(credential{}, "GET", path, "")), raw(request(stale, "GET", path, "")), path)
	}

	// Sign-in works behind a dead cookie: the OAuth start and callback carry
	// it, the callback sets a fresh session, and that session is live.
	res = request(ownerSession, "POST", "/api/members", `{"login":"reader"}`)
	require.Equal(t, 204, res.StatusCode, raw(res))
	github.mu.Lock()
	github.login = "reader"
	github.mu.Unlock()
	start := request(stale, "GET", "/api/auth/github", "")
	start.Body.Close()
	require.Equal(t, 302, start.StatusCode)
	state := strings.Split(strings.Split(start.Header.Get("Location"), "state=")[1], "&")[0]
	callback, err := http.NewRequest("GET", origin+"/api/auth/github/callback?code=fixture-code&state="+state, nil)
	require.NoError(t, err)
	callback.AddCookie(&http.Cookie{Name: "session", Value: stale.cookie})
	for _, cookie := range start.Cookies() {
		callback.AddCookie(cookie)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	signedIn, err := client.Do(callback)
	require.NoError(t, err)
	fresh := ""
	for _, cookie := range signedIn.Cookies() {
		if cookie.Name == "session" && cookie.Value != "" {
			fresh = cookie.Value
		}
	}
	require.Equal(t, 302, signedIn.StatusCode, raw(signedIn))
	require.NotEmpty(t, fresh, "sign-in behind a dead cookie sets a fresh session")
	res = request(credential{cookie: fresh}, "GET", "/api/members", "")
	require.Equal(t, 200, res.StatusCode, raw(res))
	res.Body.Close()

	// Logout behind a dead cookie still clears it.
	res = request(stale, "POST", "/api/auth/logout", "")
	got := raw(res)
	require.Less(t, res.StatusCode, 400, got)
	require.Contains(t, got, "session=;")
}
