package compose

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// ownerTokenDecrypter stands in for the sealed OAuth token store only: the
// owner sign-in suite proves sealing; every GitHub answer comes from the fake.
type ownerTokenDecrypter struct{}

func (ownerTokenDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	return "ghu_githubfake_owner", nil
}

// noPolicy is a repository with no committed factory policy: the empty
// policy, which names every GitHub maintainer.
type noPolicy struct{}

func (noPolicy) GetBookmark(context.Context, string, string, string) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: http.StatusNotFound, Code: "bookmark_not_found"}
}

func (noPolicy) GetFileAtChange(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

func (noPolicy) GetFileAtCommit(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: http.StatusNotFound}
}

// The merge route through the composed router (authentication, the
// single-owner boundary, CSRF, the API's content rules) with the merge
// service composed as the install composes it (EnableTodoPublication), real
// PostgreSQL and the GitHub fake: only the owner's browser session with its
// CSRF token and an Idempotency-Key reaches an approval; every other
// credential is refused before any TODO is read, and none records an
// approval, a fence or a GitHub merge.
func TestTodoMergeComposedRouteBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	app := services.GitHubAppCredentials{ID: 42, Slug: "smithers-install", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client",
		ClientSecret: "secret", WebhookSecret: "webhook", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{OAuthCode: "owner-code", AppID: app.ID, Slug: app.Slug, OwnerLogin: app.OwnerLogin, OwnerKind: app.OwnerKind,
		ClientID: app.ClientID, ClientSecret: app.ClientSecret, WebhookSecret: app.WebhookSecret, PrivateKeyPEM: app.PEM, ConversionCode: "manifest-code",
		Installations: []githubfake.Installation{{ID: 9301, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", fake.URL)
	for _, call := range []struct{ path, form string }{
		{"/app-manifests/manifest-code/conversions", ""},
		{"/login/oauth/access_token", url.Values{"code": {"owner-code"}, "client_id": {"client"}, "client_secret": {"secret"}, "redirect_uri": {"http://smithers.test/callback"}}.Encode()},
	} {
		response, err := fake.Client().Post(fake.URL+call.path, "application/x-www-form-urlencoded", strings.NewReader(call.form))
		require.NoError(t, err)
		require.Less(t, response.StatusCode, 300, call.path)
		require.NoError(t, response.Body.Close())
	}

	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "merge-owner", LowerUsername: "merge-owner", DisplayName: "Merge owner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "merge-member", LowerUsername: "merge-member", DisplayName: "Merge member"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, sql := range []struct {
		text string
		args []any
	}{
		{`UPDATE users SET is_active = true WHERE id IN ($1, $2)`, []any{owner.ID, member.ID}},
		{`INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, []any{owner.ID}},
		{`INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id,profile_data) VALUES (1,$1,'github','7','{"login":"rehearsal-owner"}')`, []any{owner.ID}},
		{`UPDATE repositories SET mirror_destination = 'rehearsal-owner/app' WHERE id = $1`, []any{repo.ID}},
	} {
		_, err := pool.Exec(ctx, sql.text, sql.args...)
		require.NoError(t, err, sql.text)
	}
	// Setup bound the repository and verified the owner's access to it.
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"merge-owner","repository_name":"app","repository_id":100}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access",
		Value: []byte(`{"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","owner_login":"merge-owner","repository_name":"app","repository_id":100}`)}))
	session := func(user db.User, raw string) string {
		digest := sha256.Sum256([]byte(raw))
		_, err := pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ($1,$2,$3,NOW() + interval '1 hour')`,
			hex.EncodeToString(digest[:]), user.ID, user.Username)
		require.NoError(t, err)
		return hex.EncodeToString(digest[:])
	}
	ownerSession := session(owner, "owner-browser-session")
	session(member, "member-browser-session")
	patSeed := sha256.Sum256([]byte("owner-personal-token"))
	pat := "smithers_" + hex.EncodeToString(patSeed[:])[:40]
	patHash := sha256.Sum256([]byte(pat))
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "cli", TokenHash: hex.EncodeToString(patHash[:]),
		TokenLastEight: hex.EncodeToString(patHash[:])[56:], Scopes: "all", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)

	// The install composition (compose/main.go): orchestration, the App's
	// TODO writes with every guard, MergeDecision and the merge transport.
	codec, err := webhook.NewSecretCodec("merge-route-sealing-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(ctx, app))
	userRepos := services.NewGitHubUserReposService(q, ownerTokenDecrypter{})
	connections := services.NewRepoConnectionService(pool, credentials)
	connections.SetGitHubRepoAccessVerifier(userRepos)
	_, err = connections.ConnectRepo(ctx, owner.ID, "rehearsal-owner", "app", "MIT")
	require.NoError(t, err)
	require.NoError(t, connections.ReconcileGitHubAppInstallations(ctx))
	mythical := services.NewMythicalService(pool, nil)
	mythical.SetOrchestration(services.NewMythicalGitHub(q, connections, userRepos, connections), nil, nil)
	mythical.SetPolicyReader(noPolicy{})
	mythical.EnableTodoPublication(credentials, connections, services.NewBudgetTracker())
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 100, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state = 'active' WHERE repository_id = $1`, repo.ID)
	require.NoError(t, err)

	// A TODO in review: filed by the owner, its pull request open on GitHub.
	// The run that would put it there is T-STK-01's and dark, so only its
	// end state is written here.
	filed, err := mythical.FileTodo(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: ownerSession}), repo.ID, owner.ID,
		services.MythicalTodoInput{Title: "Wave", Prompt: "Wave hello", Request: "file-wave"})
	require.NoError(t, err)
	token, err := connections.CreateGitHubInstallationTokenForRepositoryOwner(ctx, owner.ID, 0, "rehearsal-owner", "app", map[string]string{"pull_requests": "write"})
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPost, fake.URL+"/repos/rehearsal-owner/app/pulls", strings.NewReader(`{"title":"Wave","head":"smithers/wave","base":"main"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response, err := fake.Client().Do(request)
	require.NoError(t, err)
	var pull githubfake.Pull
	require.NoError(t, json.NewDecoder(response.Body).Decode(&pull))
	require.NoError(t, response.Body.Close())
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state = 'proposed', pr_number = $2, pr_url = $3, pr_state = 'open', pr_head = $4, candidate_verified = true
		WHERE repository_id = $1 AND number = $5`, repo.ID, pull.Number, pull.HTMLURL, pull.Head.SHA, filed.Number)
	require.NoError(t, err)
	item := func() db.MythicalItem {
		row, err := q.GetMythicalItemByNumber(ctx, repo.ID, filed.Number)
		require.NoError(t, err)
		return row
	}
	before := item()

	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: mythical})
	server.Start()
	t.Cleanup(server.Close)

	itemID := uuid.UUID(before.ID.Bytes).String()
	numbered := func(target string) string { return "/api/todos/" + target + "/merge" }
	repository := func(target string) string { return "/api/repos/merge-owner/app/mythical/items/" + target + "/merge" }
	elsewhere := func(target string) string {
		return "/api/repos/merge-owner/no-such-repo/mythical/items/" + target + "/merge"
	}
	doors := []struct {
		name string
		path func(string) string
		// valid, unknown and malformed name the TODO, none and nothing;
		// encoded holds an encoded slash, routed as one segment.
		valid, unknown, malformed, encoded string
	}{
		{"numbered", numbered, strconv.FormatInt(filed.Number, 10), "999", "abc", "1%2F2"},
		{"repository", repository, itemID, uuid.NewString(), "not-a-uuid", "a%2Fb"},
		{"unknown repository", elsewhere, itemID, uuid.NewString(), "not-a-uuid", "a%2Fb"},
	}
	post := func(path string, set func(*http.Request)) (int, map[string]any) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"reviewed_head_sha": pull.Head.SHA})
		r, err := http.NewRequest(http.MethodPost, origin+path, bytes.NewReader(body))
		require.NoError(t, err)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		set(r)
		response, err := http.DefaultClient.Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(raw, &envelope), string(raw))
		return response.StatusCode, envelope
	}
	browser := func(raw string, csrf bool, key string) func(*http.Request) {
		return func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: raw})
			if csrf {
				r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf-token"})
				r.Header.Set("X-CSRF-Token", "csrf-token")
			}
			if key != "" {
				r.Header.Set("Idempotency-Key", key)
			}
		}
	}
	unchanged := func(t *testing.T) {
		t.Helper()
		refused := item()
		require.Equal(t, before.Version, refused.Version, "a refusal writes nothing")
		require.Empty(t, refused.PendingOp)
	}

	// Every credential but the owner's browser session is refused the same
	// way through both doors, whatever the target names, before any
	// repository or TODO is read.
	for _, tc := range []struct {
		name     string
		set      func(*http.Request)
		status   int
		envelope map[string]any
	}{
		{"no credential", func(r *http.Request) { r.Header.Set("Idempotency-Key", "anonymous") }, 401,
			map[string]any{"code": "unauthenticated", "class": "permission", "message": "Sign in to merge"}},
		{"the owner's personal access token", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+pat)
			r.Header.Set("Idempotency-Key", "token")
		}, 403, map[string]any{"code": "permission", "class": "permission", "message": "Merge requires an owner or maintainer browser session"}},
		{"an agent action riding the owner's session", func(r *http.Request) {
			browser("owner-browser-session", true, "via-agent")(r)
			r.Header.Set("Smithers-Via", "smithers")
		}, 403, map[string]any{"code": "never", "class": "never", "message": "Only a person can do this"}},
		{"the owner's session without its CSRF token", browser("owner-browser-session", false, "no-csrf"), 403, nil},
		{"another member's session", browser("member-browser-session", true, "member"), 403, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var first map[string]any
			for _, door := range doors {
				for _, target := range []string{door.valid, door.unknown, door.malformed, door.encoded} {
					status, envelope := post(door.path(target), tc.set)
					require.Equal(t, tc.status, status, "%s %s: %v", door.name, target, envelope)
					if tc.envelope != nil {
						require.Equal(t, tc.envelope, envelope, "%s %s", door.name, target)
					}
					if first == nil {
						first = envelope
					}
					require.Equal(t, first, envelope, "%s %s: the same refusal through every door", door.name, target)
				}
			}
			unchanged(t)
		})
	}

	// The owner's session: the same refusals of the TODO it names.
	for _, tc := range []struct {
		name    string
		target  func(valid, unknown, malformed string) string
		key     string
		status  int
		code    string
		message map[string]string
	}{
		{"no Idempotency-Key", func(v, _, _ string) string { return v }, "", 400, "idempotency_key_required", nil},
		{"an unknown TODO", func(_, u, _ string) string { return u }, "unknown", 404, "todo_not_found", nil},
		{"a malformed target", func(_, _, m string) string { return m }, "malformed", 400, "invalid_todo",
			map[string]string{"numbered": "Invalid TODO number", "repository": "Invalid TODO id"}},
	} {
		t.Run("owner session, "+tc.name, func(t *testing.T) {
			for _, door := range doors[:2] {
				status, envelope := post(door.path(tc.target(door.valid, door.unknown, door.malformed)), browser("owner-browser-session", true, tc.key))
				require.Equal(t, tc.status, status, "%s: %v", door.name, envelope)
				require.Equal(t, tc.code, envelope["code"], door.name)
				if tc.message != nil {
					require.Equal(t, tc.message[door.name], envelope["message"], door.name)
				}
			}
			status, _ := post(elsewhere(itemID), browser("owner-browser-session", true, "elsewhere"))
			require.Equal(t, http.StatusNotFound, status, "an unknown repository")
			unchanged(t)
		})
	}

	status, envelope := post(numbered(strconv.FormatInt(filed.Number, 10)), browser("owner-browser-session", true, "owner-press"))
	require.Equal(t, http.StatusAccepted, status, envelope)
	require.Equal(t, map[string]any{"state": "accepted"}, envelope)
	approved := item()
	var checks struct {
		Land struct {
			Session, Head string
			Account       int64
		} `json:"land"`
	}
	require.NoError(t, json.Unmarshal(approved.Checks, &checks))
	require.Equal(t, ownerSession, checks.Land.Session, "the approval is the presenting session's own")
	require.Equal(t, pull.Head.SHA, checks.Land.Head)
	require.Equal(t, int64(7), checks.Land.Account)
	require.JSONEq(t, `{"kind":"merge","target":"`+strconv.FormatInt(pull.Number, 10)+`","desired":"`+pull.Head.SHA+`","precondition":"open","state":"intended"}`, string(approved.PendingOp))

	for _, door := range doors[:2] {
		status, envelope = post(door.path(door.valid), browser("owner-browser-session", true, "owner-press"))
		require.Equal(t, http.StatusAccepted, status, "%s: %v", door.name, envelope)
		require.Equal(t, approved.Version, item().Version, "%s: the same request through either door is answered again, never recorded twice", door.name)
	}
	for _, write := range fake.Writes() {
		require.False(t, write.Method == http.MethodPut && strings.HasSuffix(write.Path, "/merge"), "the press never merges")
	}
}

// todoMergeComposeRouter is the production router with the mythical
// handler mounted, which mounts /api/todos in single-owner mode. The other
// handlers are unused by these requests.
func todoMergeComposeRouter(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool, mythical *routes.MythicalHandler) http.Handler {
	return buildRouterCompat(
		cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Mythical: mythical},
	)
}
