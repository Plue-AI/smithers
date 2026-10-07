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
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type mergeFaultFixture struct {
	pool         *pgxpool.Pool
	q            *db.Queries
	fake         *githubfake.Server
	service      *services.MythicalService
	server       *httptest.Server
	repo, number int64
	head, host   string
	item         db.MythicalItem
}

func newMergeFaultFixture(t *testing.T) *mergeFaultFixture {
	t.Setenv("TMPDIR", t.TempDir())
	t.Setenv("GIT_AUTHOR_DATE", "1700000000 +0000")
	t.Setenv("GIT_COMMITTER_DATE", "1700000000 +0000")
	host := &pollingGitHost{dir: filepath.Join(t.TempDir(), "mirror.git")}
	require.NoError(t, host.git(t.Context(), nil, io.Discard, "init", "--bare", host.dir))
	var tree, main, head bytes.Buffer
	require.NoError(t, host.git(t.Context(), strings.NewReader(""), &tree, "mktree"))
	require.NoError(t, host.git(t.Context(), nil, &main, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Fixture main"))
	require.NoError(t, host.git(t.Context(), nil, &head, "commit-tree", strings.TrimSpace(tree.String()), "-p", strings.TrimSpace(main.String()), "-m", "Fixture TODO"))
	require.NoError(t, host.git(t.Context(), nil, io.Discard, "update-ref", "refs/heads/main", strings.TrimSpace(main.String())))
	require.NoError(t, host.git(t.Context(), nil, io.Discard, "update-ref", "refs/heads/smithers/wave", strings.TrimSpace(head.String())))
	gitRoot := t.TempDir()
	githubDir := filepath.Join(gitRoot, "rehearsal-owner", "app.git")
	require.NoError(t, os.MkdirAll(filepath.Dir(githubDir), 0700))
	out, err := exec.Command("git", "clone", "--bare", host.dir, githubDir).CombinedOutput()
	require.NoError(t, err, string(out))
	installation := int64(98300) + confirmationMergeInstallations.Add(1)
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	app := services.GitHubAppCredentials{ID: 42, Slug: "smithers-install", OwnerLogin: "rehearsal-owner", OwnerKind: "user", ClientID: "client",
		ClientSecret: "secret", WebhookSecret: "webhook", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{GitRoot: gitRoot, OAuthCode: "owner-code", AppID: app.ID, Slug: app.Slug, OwnerLogin: app.OwnerLogin, OwnerKind: app.OwnerKind,
		ClientID: app.ClientID, ClientSecret: app.ClientSecret, WebhookSecret: app.WebhookSecret, PrivateKeyPEM: app.PEM, ConversionCode: "manifest-code",
		Installations: []githubfake.Installation{{ID: installation, Repositories: []githubfake.Repository{{ID: 100, FullName: "rehearsal-owner/app"}}}}})
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
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"merge-owner","repository_name":"app","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access",
		Value: []byte(fmt.Sprintf(`{"last_access_check_at":%q,"owner_login":"merge-owner","repository_name":"app","repository_id":%d}`, time.Now().UTC().Format(time.RFC3339Nano), repo.ID))}))
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
	mythical := services.NewMythicalService(pool, host)
	mythical.SetOrchestration(services.NewMythicalGitHub(q, connections, userRepos, connections), nil, nil)
	mythical.SetPolicyReader(noPolicy{})
	mythical.EnableTodoPublication(credentials, connections, services.NewBudgetTracker())
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 100, false)
	require.NoError(t, err)
	err = mythical.PollOnce(ctx)
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
	require.Equal(t, "1911c6fd6a511a5bfab52e22c7234715b37f8225", pull.Head.SHA)
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

	return &mergeFaultFixture{pool: pool, q: q, fake: fake, service: mythical, server: server, repo: repo.ID, number: filed.Number, head: pull.Head.SHA, host: host.dir, item: before}
}

// The transaction adapter stops immediately before the production Land UPDATE.
// It adds no journal writes and is compiled only into the test executable.
type mergeFaultStore struct{ *pgxpool.Pool }
type mergeFaultTx struct{ pgx.Tx }

func (s mergeFaultStore) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(ctx)
	return mergeFaultTx{tx}, err
}
func (tx mergeFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "UPDATE mythical_items") {
		for _, arg := range args {
			if raw, ok := arg.([]byte); ok {
				var checks map[string]json.RawMessage
				if json.Unmarshal(raw, &checks) == nil && checks["land"] != nil {
					faultprocess.Reached("merge-pre-land")
				}
			}
		}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

type mergeFaultTransport struct{ http.RoundTripper }

func (tr mergeFaultTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := tr.RoundTripper.RoundTrip(r)
	if r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/merge") && err == nil && response.StatusCode == 200 {
		// Consume the real fake-GitHub answer before stopping; the merge is committed.
		raw, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		response.Body = io.NopCloser(bytes.NewReader(raw))
		faultprocess.Reached("merge-post-call")
	}
	return response, err
}
func mergeFaultServer(t *testing.T, pool *pgxpool.Pool, service *services.MythicalService) *httptest.Server {
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	server.Config.Handler = todoMergeComposeRouter(cfg, db.New(pool), pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	return server
}
func mergeFaultPress(t *testing.T, origin string, number int64, head string) {
	r, err := http.NewRequest("POST", origin+fmt.Sprintf("/api/todos/%d/merge", number), strings.NewReader(fmt.Sprintf(`{"reviewed_head_sha":%q}`, head)))
	require.NoError(t, err)
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", "fault-person-merge")
	r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
	r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	r.Header.Set("X-CSRF-Token", "csrf")
	response, err := http.DefaultClient.Do(r)
	require.NoError(t, err)
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Less(t, response.StatusCode, 300, string(raw))
}
func mergeFaultService(t *testing.T, pool *pgxpool.Pool, host, point string) *services.MythicalService {
	codec, err := webhook.NewSecretCodec("merge-route-sealing-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	userRepos := services.NewGitHubUserReposService(db.New(pool), ownerTokenDecrypter{})
	connections := services.NewRepoConnectionService(pool, credentials)
	connections.SetGitHubRepoAccessVerifier(userRepos)
	var store services.MythicalStore = pool
	if point == "merge-pre-land" {
		store = mergeFaultStore{pool}
	}
	service := services.NewMythicalService(store, &pollingGitHost{dir: host})
	service.SetOrchestration(services.NewMythicalGitHub(db.New(pool), connections, userRepos, connections), nil, nil)
	service.SetPolicyReader(noPolicy{})
	service.EnableTodoPublication(credentials, connections, services.NewBudgetTracker())
	return service
}
func TestTodoMergeCrashChild(t *testing.T) {
	if os.Getenv(faultprocess.ChildEnv) != "todo-merge" {
		return
	}
	args := strings.Split(os.Getenv(faultprocess.ArgsEnv), "|")
	require.Len(t, args, 3)
	pool, err := postgresfixture.Open(t.Context(), os.Getenv(faultprocess.DBEnv), 0)
	require.NoError(t, err)
	defer pool.Close()
	point := os.Getenv(faultprocess.PointEnv)
	if point == "merge-post-call" {
		http.DefaultTransport = mergeFaultTransport{http.DefaultTransport}
	}
	service := mergeFaultService(t, pool, args[0], point)
	server := mergeFaultServer(t, pool, service)
	n, err := strconv.ParseInt(args[1], 10, 64)
	require.NoError(t, err)
	mergeFaultPress(t, server.URL, n, args[2])
	if point == "merge-post-land" {
		faultprocess.Reached(point)
	}
	// Same background stack loop as the install, never a direct outbound call.
	service.Start(t.Context())
}
func TestTodoMergeCrashThroughRoute(t *testing.T) {
	for _, point := range []string{"merge-pre-land", "merge-post-land", "merge-post-call"} {
		t.Run(point, func(t *testing.T) {
			t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", fmt.Sprintf("relmerge%d", os.Getpid()))
			f := newMergeFaultFixture(t)
			child := faultprocess.Start(t, "TestTodoMergeCrashChild", "todo-merge", point, f.pool.Config().ConnString(), f.host, strconv.FormatInt(f.number, 10), f.head)
			child.Await(t, faultprocess.Marker+point)
			child.Kill(t)
			require.Equal(t, 1, faultDatabaseCount(t, f.pool), "killed child must not orphan a suite database")
			fmt.Println(faultprocess.Marker + point)
			ctx := t.Context()
			before, err := f.q.GetMythicalItemByNumber(ctx, f.repo, f.number)
			require.NoError(t, err)
			var checks map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(before.Checks, &checks))
			if point == "merge-pre-land" {
				require.Nil(t, checks["land"])
				require.Empty(t, before.PendingOp)
			} else {
				require.NotNil(t, checks["land"])
				require.NotEmpty(t, before.PendingOp)
			}
			countMerges := func() int {
				n := 0
				for _, write := range f.fake.Writes() {
					if write.Method == "PUT" && strings.HasSuffix(write.Path, "/merge") {
						n++
					}
				}
				return n
			}
			if point == "merge-post-call" {
				require.Equal(t, 1, countMerges())
			} else {
				require.Zero(t, countMerges())
			}
			// Expire only the killed stack worker's fixture lease; fresh install resumes.
			_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=now()-interval '1 second',next_attempt_at=now(),requested_generation=requested_generation+1 WHERE repository_id=$1`, f.repo)
			require.NoError(t, err)
			restart := mergeFaultService(t, f.pool, f.host, "")
			server := mergeFaultServer(t, f.pool, restart)
			if point == "merge-pre-land" {
				mergeFaultPress(t, server.URL, f.number, f.head)
			}
			_, err = f.pool.Exec(ctx, `CREATE SEQUENCE fault_merge_attempts;
CREATE FUNCTION fault_refuse_merge_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='todo.github_operation_settled' THEN PERFORM nextval('fault_merge_attempts'); RAISE EXCEPTION 'fault merge fact refused'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fault_merge_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION fault_refuse_merge_fact()`)
			require.NoError(t, err)
			workerCtx, cancel := context.WithCancel(ctx)
			done := make(chan struct{})
			go func() { defer close(done); restart.Start(workerCtx) }()
			defer func() { cancel(); <-done }()
			require.Eventually(t, func() bool {
				var called bool
				err := f.pool.QueryRow(ctx, `SELECT is_called FROM fault_merge_attempts`).Scan(&called)
				return err == nil && called
			}, 20*time.Second, 100*time.Millisecond)
			unsettled, err := f.q.GetMythicalItemByNumber(ctx, f.repo, f.number)
			require.NoError(t, err)
			require.Equal(t, "proposed", unsettled.State, "failed fact rolls back merged state")
			require.NotEmpty(t, unsettled.PendingOp)
			_, err = f.pool.Exec(ctx, `DROP TRIGGER fault_merge_fact ON product_job_events; DROP FUNCTION fault_refuse_merge_fact(); DROP SEQUENCE fault_merge_attempts`)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at=now() WHERE repository_id=$1;`, f.repo)
			require.NoError(t, err)
			_, err = f.q.RequestMythicalStack(ctx, f.repo)
			require.NoError(t, err)
			require.Eventually(t, func() bool {
				row, err := f.q.GetMythicalItemByNumber(ctx, f.repo, f.number)
				return err == nil && row.State == "landed"
			}, 40*time.Second, 100*time.Millisecond)
			require.Equal(t, 1, countMerges(), "recovery must not repeat GitHub's merge")
			row, err := f.q.GetMythicalItemByNumber(ctx, f.repo, f.number)
			require.NoError(t, err)
			require.Empty(t, row.PendingOp)
			require.NoError(t, json.Unmarshal(row.Checks, &checks))
			var land struct{ Head string }
			require.NoError(t, json.Unmarshal(checks["land"], &land))
			require.Equal(t, "1911c6fd6a511a5bfab52e22c7234715b37f8225", land.Head)
			r, err := http.NewRequest("GET", server.URL+fmt.Sprintf("/api/todos/%d", f.number), nil)
			require.NoError(t, err)
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err := http.DefaultClient.Do(r)
			require.NoError(t, err)
			defer response.Body.Close()
			var card map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&card))
			require.Equal(t, 200, response.StatusCode)
			require.Equal(t, "merged", card["state"])
			r, err = http.NewRequest("GET", server.URL+fmt.Sprintf("/api/todos/%d/events", f.number), nil)
			require.NoError(t, err)
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: "owner-browser-session"})
			response, err = http.DefaultClient.Do(r)
			require.NoError(t, err)
			var replay jobs.ReplayPage
			require.NoError(t, json.NewDecoder(response.Body).Decode(&replay))
			response.Body.Close()
			require.Equal(t, 200, response.StatusCode)
			mergedEvents := 0
			for _, event := range replay.Events {
				if event.State == "merged" {
					mergedEvents++
					require.Equal(t, "todo.github_operation_settled", event.Type)
					var fact map[string]any
					require.NoError(t, json.Unmarshal(event.Data, &fact))
					require.Equal(t, "merged", fact["to"])
				}
			}
			require.Equal(t, 1, mergedEvents, "one committed merged transition survives replay")
			evidence := filepath.Join("../../../..", ".artifacts/checks/C-DUR-03", time.Now().UTC().Format("20060102T150405.000000000Z"), point)
			require.NoError(t, os.MkdirAll(evidence, 0700))
			raw, err := json.MarshalIndent(map[string]any{"point": point, "subject": fmt.Sprintf("todo:%d", f.number), "reviewed_head": f.head, "effects_seen": countMerges(), "state": card["state"], "checks": json.RawMessage(row.Checks), "github_writes": f.fake.Writes(), "events": replay.Events, "merged_transitions": mergedEvents, "identity": faultprocess.Identity(t), "steps_re_run": "not applicable: merge is outside the TODO run", "writes_acknowledged": 1, "writes_found": 1}, "", "  ")
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(evidence, "observations.json"), raw, 0600))
		})
	}
}

func faultDatabaseCount(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	namespace := os.Getenv("SMITHERS_TEST_DATABASE_NAMESPACE")
	require.NotEmpty(t, namespace)
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_database WHERE starts_with(datname,$1)`, "smithers_test_"+namespace+"_").Scan(&count))
	return count
}
