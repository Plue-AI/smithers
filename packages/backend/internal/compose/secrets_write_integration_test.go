package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Repository secrets writes through the composed install router, real
// PostgreSQL and the roster's GitHub fake (spec §5.2 row "Members, roles,
// secrets write"; §5.2.1): the owner's and a maintainer's browser sessions
// add, replace and delete secrets; a member's session is refused with
// permission; an otherwise-eligible delegated credential is refused with
// never; a run credential, a delegated member and an outsider keep their
// refusals; a removed or suspended member's session is dead (401). No
// refusal writes a row.
func TestSecretsWriteComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name, DisplayName: name})
		require.NoError(t, err)
		return created
	}
	owner, maintainer, writer, outsider := user("owner"), user("maintainer"), user("writer"), user("outsider")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-04T22:00:00Z"}`)}))
	for _, row := range []struct {
		user       db.User
		permission string
		githubID   int64
	}{{owner, "admin", 101}, {writer, "write", 102}, {maintainer, "admin", 103}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,$3,$4,$5)`,
			repo.ID, row.user.ID, row.permission, row.githubID, row.user.Username)
		require.NoError(t, err)
	}
	github := &rosterGitHub{roles: map[string]string{"owner": "admin", "writer": "write", "maintainer": "maintain"}}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}}

	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	secrets := &routes.SecretHandler{Service: services.NewSecretService(q, nil)}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, secrets, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Members: &routes.MembersHandler{Service: members}})
	server.Start()
	defer server.Close()

	session := func(u db.User) string {
		key := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	token := func(u db.User, name, scopes string, systemIssued bool) string {
		seed := sha256.Sum256([]byte(u.Username + "-" + name))
		raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
		hash := sha256.Sum256([]byte(raw))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: name, TokenHash: hex.EncodeToString(hash[:]),
			TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}, SystemIssued: systemIssued})
		require.NoError(t, err)
		return raw
	}
	type credential struct{ cookie, bearer string }
	ownerSession, maintainerSession, writerSession, outsiderSession := credential{cookie: session(owner)}, credential{cookie: session(maintainer)}, credential{cookie: session(writer)}, credential{cookie: session(outsider)}
	delegated := func(u db.User) credential {
		return credential{bearer: token(u, "cli", "write:repository,via:cli", true)}
	}
	run := credential{bearer: token(maintainer, "run", "write:repository", true)}
	ownerPAT := credential{bearer: token(owner, "pat", "all", false)}

	call := func(c credential, method, path, body string) (int, map[string]any) {
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
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		envelope := map[string]any{}
		if len(raw) > 0 {
			require.NoError(t, json.Unmarshal(raw, &envelope), string(raw))
		}
		return res.StatusCode, envelope
	}
	request := func(c credential, method, path, body string) (int, map[string]any) {
		t.Helper()
		return call(c, method, "/api/repos/owner/app"+path, body)
	}
	stored := func() []string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT name FROM repository_secrets WHERE repository_id=$1 ORDER BY name`, repo.ID)
		require.NoError(t, err)
		names, err := pgx.CollectRows(rows, pgx.RowTo[string])
		require.NoError(t, err)
		return names
	}

	// The owner's and a maintainer's sessions add, replace and delete.
	for _, tc := range []struct {
		who  credential
		name string
	}{{ownerSession, "OWNER_KEY"}, {maintainerSession, "MAINTAINER_KEY"}} {
		before := len(stored())
		status, body := request(tc.who, "POST", "/secrets", `{"name":"`+tc.name+`","value":"v1"}`)
		require.Equal(t, 201, status, body)
		require.Equal(t, tc.name, body["name"])
		require.Len(t, stored(), before+1, "one row")
		status, body = request(tc.who, "POST", "/secrets", `{"name":"`+tc.name+`","value":"v2"}`)
		require.Equal(t, 201, status, body)
		require.Len(t, stored(), before+1, "a replace writes no second row")
		status, body = request(tc.who, "PATCH", "/secrets/"+tc.name, `{"main_only":true}`)
		require.Equal(t, 200, status, body)
		require.Equal(t, true, body["main_only"], body)
	}
	require.Equal(t, []string{"MAINTAINER_KEY", "OWNER_KEY"}, stored())
	status, body := request(maintainerSession, "DELETE", "/secrets/MAINTAINER_KEY", "")
	require.Equal(t, 204, status, body)
	require.Equal(t, []string{"OWNER_KEY"}, stored())
	status, body = request(ownerSession, "POST", "/secrets", `{"name":"SPARE","value":"v"}`)
	require.Equal(t, 201, status, body)
	status, body = request(ownerSession, "DELETE", "/secrets/SPARE", "")
	require.Equal(t, 204, status, body)
	require.Equal(t, []string{"OWNER_KEY"}, stored())

	permission := map[string]any{"class": "permission", "code": "permission", "message": "Only a maintainer can do this"}
	never := map[string]any{"class": "never", "code": "never", "message": "Only a person can do this"}
	for _, tc := range []struct {
		name     string
		who      credential
		status   int
		envelope map[string]any
		code     string
	}{
		{"a member's session", writerSession, 403, permission, ""},
		{"the owner's delegated credential", delegated(owner), 403, never, ""},
		{"a maintainer's delegated credential", delegated(maintainer), 403, never, ""},
		{"the owner's personal access token", ownerPAT, 403, never, ""},
		{"a member's delegated credential", delegated(writer), 403, permission, ""},
		{"a maintainer's run credential", run, 403, nil, "permission"},
		{"an outsider's session", outsiderSession, 403, nil, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, call := range []struct{ method, path, body string }{
				{"POST", "/secrets", `{"name":"REFUSED","value":"v"}`},
				{"POST", "/secrets", `{"name":"OWNER_KEY","value":"overwritten"}`},
				{"PATCH", "/secrets/OWNER_KEY", `{"main_only":false}`},
				{"DELETE", "/secrets/OWNER_KEY", ""},
			} {
				status, body := request(tc.who, call.method, call.path, call.body)
				require.Equal(t, tc.status, status, "%s %s: %v", call.method, call.path, body)
				if tc.envelope != nil {
					require.Equal(t, tc.envelope, body, "%s %s", call.method, call.path)
				} else {
					require.Equal(t, tc.code, body["code"], "%s %s: %v", call.method, call.path, body)
				}
				require.Equal(t, []string{"OWNER_KEY"}, stored(), "a refusal writes nothing")
			}
		})
	}
	var value []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT value_encrypted FROM repository_secrets WHERE repository_id=$1 AND name='OWNER_KEY'`, repo.ID).Scan(&value))
	require.Equal(t, "v2", string(value), "no refusal replaced the value")

	// Org secrets are not an install route: a maintainer's session still
	// finds none there.
	req, err := http.NewRequest("POST", origin+"/api/orgs/acme/secrets", strings.NewReader(`{"name":"ORG","value":"v"}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", "csrf-fixture")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
	req.AddCookie(&http.Cookie{Name: "session", Value: maintainerSession.cookie})
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	require.Equal(t, 404, res.StatusCode, string(raw))
	var orgRows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM organization_secrets`).Scan(&orgRows))
	require.Zero(t, orgRows)

	// A removed maintainer and a suspended member hold dead sessions: a
	// secrets write carrying one is refused as unauthenticated (spec §5.2.1),
	// decided from the credential before the repository is resolved.
	// Nothing is written.
	status, body = call(ownerSession, "DELETE", "/api/members/maintainer", "")
	require.Equal(t, 204, status, body)
	github.mu.Lock()
	github.roles["writer"] = "read"
	github.mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	for _, who := range []credential{maintainerSession, writerSession} {
		status, body = call(who, "GET", "/api/members", "")
		require.Equal(t, 401, status, body)
		for _, write := range []struct{ method, path, body string }{
			{"POST", "/secrets", `{"name":"DEAD","value":"v"}`},
			{"PATCH", "/secrets/OWNER_KEY", `{"main_only":false}`},
			{"DELETE", "/secrets/OWNER_KEY", ""},
		} {
			status, body = request(who, write.method, write.path, write.body)
			require.Equal(t, 401, status, "%s %s: %v", write.method, write.path, body)
			require.Equal(t, "unauthenticated", body["code"], body)
		}
	}
	require.Equal(t, []string{"OWNER_KEY"}, stored())
}
