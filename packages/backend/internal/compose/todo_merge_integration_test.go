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
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
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
	issuer := &outboundProxyIssuer{}
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: mythical}, &routes.GitHubProxyHandler{Service: services.NewGitHubProxyService(issuer)})
	server.Start()
	t.Cleanup(server.Close)

	t.Run("shared TODO replay excludes private and other item facts", func(t *testing.T) {
		scope := jobs.Scope{TenantID: strconv.FormatInt(repo.ID, 10), PrincipalID: "todo:" + uuid.UUID(before.ID.Bytes).String()}
		var shared jobs.Event
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			var err error
			shared, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "todo.test", "working", json.RawMessage(`{"attempt":2,"actor":"Ben"}`))
			if err != nil {
				return err
			}
			for _, principal := range []string{"user:private", "todo:" + uuid.NewString()} {
				_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: scope.TenantID, PrincipalID: principal}, uuid.NewString(), "secret", "working", json.RawMessage(`{"secret":"hidden"}`))
				if err != nil {
					return err
				}
			}
			return nil
		})

		require.NoError(t, err)
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "rolled_back", "working", json.RawMessage(`{"private":"rollback"}`))
		require.NoError(t, err)
		require.NoError(t, tx.Rollback(ctx))
		read := func(suffix string) (*http.Response, []byte) {
			request, err := http.NewRequest(http.MethodGet, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10)+"/events"+suffix, nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			response.Body.Close()
			return response, raw
		}
		response, raw := read("")
		require.Equal(t, 200, response.StatusCode, string(raw))
		var page jobs.ReplayPage
		require.NoError(t, json.Unmarshal(raw, &page))
		require.Len(t, page.Events, 2)
		require.Equal(t, "todo.created", page.Events[0].Type)
		require.Equal(t, shared.EventID, page.Events[1].EventID)
		require.Greater(t, page.Events[1].Sequence, page.Events[0].Sequence)
		require.NotContains(t, string(raw), "hidden")
		response, raw = read("?cursor=" + strconv.FormatInt(page.Cursor, 10))
		require.Equal(t, 200, response.StatusCode, string(raw))
		require.NoError(t, json.Unmarshal(raw, &page))
		require.Empty(t, page.Events)
		response, _ = read("?cursor=-1")
		require.Equal(t, 400, response.StatusCode)
	})

	t.Run("attempt logs keep bytes and refuse unrelated digests", func(t *testing.T) {
		disk, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: origin, SigningKey: bytes.Repeat([]byte{0x42}, 32)})
		require.NoError(t, err)
		defer disk.Close()
		logs := &todoCountingLogStore{Store: disk}
		mythical.SetTodoLogStore(logs)
		payload := "literal check stdout\n"
		hash := sha256.Sum256([]byte(payload))
		digest := hex.EncodeToString(hash[:])
		require.NoError(t, blob.Put(ctx, logs, "repos/"+strconv.FormatInt(repo.ID, 10)+"/todo-logs/"+digest, "text/plain", strings.NewReader(payload)))
		oldChecks := before.Checks
		retained, _ := json.Marshal(map[string]any{"attempts": []any{map[string]any{"attempt": 1, "revision": "old", "items": []any{map[string]any{"kind": "check", "name": "build", "log_digest": digest}}}}})
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=2,checks=$2 WHERE id=$1`, before.ID, retained)
		require.NoError(t, err)
		defer func() {
			_, err := pool.Exec(ctx, `UPDATE mythical_items SET attempt=$2,checks=$3 WHERE id=$1`, before.ID, before.Attempt, oldChecks)
			require.NoError(t, err)
		}()
		for _, tc := range []struct {
			attempt, digest string
			status          int
		}{{"1", digest, 200}, {"2", digest, 404}, {"1", strings.Repeat("a", 64), 404}} {
			request, err := http.NewRequest(http.MethodGet, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10)+"/attempts/"+tc.attempt+"/logs/"+tc.digest, nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, tc.status, response.StatusCode, string(raw))
			require.Equal(t, int64(1), logs.reads.Load(), "unrelated digests and attempts never invoke blob retrieval")
			if tc.status == 200 {
				require.Equal(t, payload, string(raw))
				require.Equal(t, "nosniff", response.Header.Get("X-Content-Type-Options"))
			}
		}

		// The canonical snapshot still references its log when the current card
		// has no measured candidate. Rendering is not an authorization oracle.
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=1 WHERE id=$1`, before.ID)
		require.NoError(t, err)
		{
			request, err := http.NewRequest(http.MethodGet, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10)+"/attempts/1/logs/"+digest, nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode, string(raw))
			require.Equal(t, payload, string(raw))
			require.Equal(t, int64(2), logs.reads.Load())
		}
		response, err := http.Get(origin + "/api/todos/" + strconv.FormatInt(filed.Number, 10) + "/attempts/1/logs/" + digest)
		require.NoError(t, err)
		response.Body.Close()
		require.Equal(t, http.StatusUnauthorized, response.StatusCode)
		require.Equal(t, int64(2), logs.reads.Load(), "unauthenticated requests never retrieve blob bytes")
	})
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
				first = nil
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

	// Pre-approval uses the real composed person route and persists attribution;
	// credentials and members cannot grant or remove it, even with forged via.
	for _, operation := range []string{"preapprove", "unapprove"} {
		path := "/api/todos/" + strconv.FormatInt(filed.Number, 10) + "/preapproval"
		apply := func(set func(*http.Request)) func(*http.Request) {
			return func(r *http.Request) {
				set(r)
				if operation == "unapprove" {
					r.Method = http.MethodDelete
				}
			}
		}
		for _, credential := range []func(*http.Request){
			browser("member-browser-session", true, "member-approval"),
			func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+pat) },
		} {
			status, _ := post(path, apply(credential))
			require.Equal(t, http.StatusForbidden, status)
			unchanged(t)
		}
		status, response := post(path, apply(browser("owner-browser-session", true, operation)))
		require.Equal(t, http.StatusAccepted, status, response)
		var approval struct {
			Automerge   bool `json:"automerge"`
			Preapproval *struct {
				By   string `json:"by"`
				User int64  `json:"standing_user"`
			} `json:"preapproval"`
			Events []struct {
				Approved bool   `json:"approved"`
				User     int64  `json:"user"`
				Via      string `json:"via"`
			} `json:"preapproval_events"`
		}
		require.NoError(t, json.Unmarshal(item().Checks, &approval))
		require.Equal(t, operation == "preapprove", approval.Automerge)
		require.Equal(t, operation == "preapprove", approval.Preapproval != nil)
		if approval.Preapproval != nil {
			require.Equal(t, owner.ID, approval.Preapproval.User)
			require.Equal(t, "rehearsal-owner", approval.Preapproval.By)
		}
		require.Equal(t, owner.ID, approval.Events[len(approval.Events)-1].User)
		require.Equal(t, "session", approval.Events[len(approval.Events)-1].Via)
		require.Empty(t, item().PendingOp, "approval alone does not dispatch")
		before = item()
	}

	// The owner default is exercised through PUT /api/install and TODO creation
	// through POST /api/todos; no existing item is rewritten.
	putDefault := func(enabled bool, credential func(*http.Request)) int {
		request, err := http.NewRequest(http.MethodPut, origin+"/api/install", strings.NewReader(fmt.Sprintf(`{"new_todos_preapproved":%t}`, enabled)))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		credential(request)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		return response.StatusCode
	}
	for _, credential := range []func(*http.Request){browser("member-browser-session", true, "default-member"), func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+pat) }} {
		require.Equal(t, 403, putDefault(true, credential))
	}
	require.Equal(t, 200, putDefault(true, browser("owner-browser-session", true, "default-on")))
	create := func(title string, expectedApproval bool) db.MythicalItem {
		request, err := http.NewRequest(http.MethodPost, origin+"/api/todos", strings.NewReader(fmt.Sprintf(`{"title":%q,"prompt":"Do it","place":{"mode":"append"}}`, title)))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		browser("owner-browser-session", true, title)(request)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		var receipt struct {
			N int64 `json:"n"`
		}
		require.NoError(t, json.NewDecoder(response.Body).Decode(&receipt))
		require.Equal(t, 202, response.StatusCode)
		created, err := q.GetMythicalItemByNumber(ctx, repo.ID, receipt.N)
		require.NoError(t, err)
		var checks struct {
			Automerge   bool `json:"automerge"`
			Preapproval *struct {
				User int64 `json:"standing_user"`
			} `json:"preapproval"`
		}
		require.NoError(t, json.Unmarshal(created.Checks, &checks))
		require.Equal(t, expectedApproval, checks.Automerge)
		if expectedApproval {
			require.NotNil(t, checks.Preapproval)
			require.Equal(t, owner.ID, checks.Preapproval.User)
		} else {
			require.Nil(t, checks.Preapproval)
		}
		return created
	}
	inherited := create("Inherits approval", true)
	unchanged(t)
	require.Equal(t, 200, putDefault(false, browser("owner-browser-session", true, "default-off")))
	create("Human gated", false)
	afterDisable, err := q.GetMythicalItem(ctx, inherited.ID)
	require.NoError(t, err)
	require.Equal(t, inherited.Checks, afterDisable.Checks)
	unchanged(t)

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

	t.Run("Drop retains an uncertain body through the install door", func(t *testing.T) {
		// The earlier approval is definitively not sent. This fixture supplies
		// a separate outstanding body write; Drop must preserve its exact slot.
		slot := []byte(`{"kind":"body","target":"1","desired":"new-body","precondition":"old-body","state":"unknown"}`)
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET pending_op=$2, checks=checks-'land' WHERE id=$1`, before.ID, slot)
		require.NoError(t, err)
		control := func() int {
			r, err := http.NewRequest(http.MethodPost, origin+"/api/todos/"+strconv.FormatInt(filed.Number, 10), strings.NewReader(`{"op":"drop"}`))
			require.NoError(t, err)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", origin)
			browser("owner-browser-session", true, "drop-uncertain")(r)
			response, err := http.DefaultClient.Do(r)
			require.NoError(t, err)
			defer response.Body.Close()
			raw, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
			return response.StatusCode
		}
		control()
		dropped := item()
		require.Equal(t, "cancelled", dropped.State)
		require.JSONEq(t, string(slot), string(dropped.PendingOp))
		control()
		require.Equal(t, dropped.Version, item().Version, "replayed Drop creates no second effect")
	})
	t.Run("machine proxy mutations mint no token", func(t *testing.T) {
		seed := sha256.Sum256([]byte("outbound-machine-token"))
		machine := "smithers_" + hex.EncodeToString(seed[:])[:40]
		digest := sha256.Sum256([]byte(machine))
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "outbound-machine", TokenHash: hex.EncodeToString(digest[:]), TokenLastEight: hex.EncodeToString(digest[:])[56:], Scopes: "all,repo:" + strconv.FormatInt(repo.ID, 10), SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		writes := len(fake.Writes())
		var pendingBefore int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE pending_op IS NOT NULL`).Scan(&pendingBefore))
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
			for _, target := range []string{"pulls", "git/refs/heads/main", "check-runs"} {
				payload, _ := json.Marshal(map[string]any{"method": method, "path": "/repos/merge-owner/app/" + target, "body": map[string]string{"head": "hostile", "state": "closed"}})
				r, err := http.NewRequest(http.MethodPost, origin+"/api/repos/merge-owner/app/github-proxy", bytes.NewReader(payload))
				require.NoError(t, err)
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", origin)
				r.Header.Set("Authorization", "Bearer "+machine)
				response, err := http.DefaultClient.Do(r)
				require.NoError(t, err)
				raw, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				require.NoError(t, response.Body.Close())
				require.Equal(t, http.StatusForbidden, response.StatusCode, string(raw))
			}
		}
		require.Zero(t, issuer.calls)
		require.Len(t, fake.Writes(), writes)
		var pendingAfter int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE pending_op IS NOT NULL`).Scan(&pendingAfter))
		require.Equal(t, pendingBefore, pendingAfter)
	})

}

type outboundProxyIssuer struct{ calls int }

func (i *outboundProxyIssuer) CreateGitHubInstallationTokenForUserRepo(context.Context, int64, string, string, map[string]string) (services.GitHubInstallationToken, error) {
	i.calls++
	return services.GitHubInstallationToken{}, fmt.Errorf("unexpected token issuance")
}

// todoMergeComposeRouter is the production router with the mythical
// handler mounted, which mounts /api/todos in single-owner mode. The other
// handlers are unused by these requests.
func todoMergeComposeRouter(cfg *config.Config, q *db.Queries, pool *pgxpool.Pool, mythical *routes.MythicalHandler, proxy ...*routes.GitHubProxyHandler) http.Handler {
	var proxyHandler *routes.GitHubProxyHandler
	if len(proxy) > 0 {
		proxyHandler = proxy[0]
	}
	setup := &routes.GitHubAppSetupHandler{Setup: &services.InstallSetupService{Pool: pool}, Owners: q, Roster: q, Origins: func() []string { return cfg.Server.AllowedOrigins }}
	if service, ok := mythical.Service.(interface {
		SetTodoPreapprovalDefault(context.Context, int64, bool) error
	}); ok {
		setup.SetTodoPreapprovalDefault = service.SetTodoPreapprovalDefault
	}
	return buildRouterCompat(
		cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Mythical: mythical, GitHubAppSetup: setup}, proxyHandler,
	)
}

// Instrument only retrieval; storage and reads use the production filesystem adapter.
type todoCountingLogStore struct {
	blob.Store
	reads atomic.Int64
}

func (s *todoCountingLogStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	s.reads.Add(1)
	return s.Store.NewReader(ctx, key)
}
func (s *todoCountingLogStore) Put(ctx context.Context, key, kind string, reader io.Reader) error {
	return blob.Put(ctx, s.Store, key, kind, reader)
}
