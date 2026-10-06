package compose

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

var pollingFixtureSequence atomic.Int64

type installPollingComposition struct {
	pool        *pgxpool.Pool
	q           *db.Queries
	sync        *githubSyncServices
	main        *services.GitHubMainPullService
	stack       *services.MythicalService
	credentials *services.GitHubAppCredentialStore
	upstream    *githubfake.Server
	router      http.Handler
	user        db.User
	repository  int64
	clock       atomic.Int64
	low         atomic.Bool
	resetAt     atomic.Int64
	pauseIssues atomic.Int32
	mu          sync.Mutex
	calls       []string
}

func newInstallPollingComposition(t *testing.T, ready bool) *installPollingComposition {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	f := &installPollingComposition{pool: pool, q: db.New(pool)}
	f.clock.Store(time.Now().Unix())
	now := func() time.Time { return time.Unix(f.clock.Load(), 0).UTC() }
	installation := int64(351502) + pollingFixtureSequence.Add(1)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	app := services.GitHubAppCredentials{ID: 3515, Slug: "polling-fixture", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "secret", WebhookSecret: "polling-hook", InstallationID: installation, PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	fake, err := githubfake.New(githubfake.Config{Now: now, AppID: app.ID, Slug: app.Slug, OwnerLogin: app.OwnerLogin, OwnerKind: app.OwnerKind, ClientID: app.ClientID, ClientSecret: app.ClientSecret, WebhookSecret: app.WebhookSecret, PrivateKeyPEM: app.PEM, ConversionCode: "manifest", Installations: []githubfake.Installation{{ID: installation, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}, {ID: 101, FullName: "acme/other"}}}, {ID: installation + 1000, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	f.upstream = fake
	f.resetAt.Store(f.clock.Load() + 300)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		f.mu.Unlock()
		reset := f.resetAt.Load()
		w.Header().Set("X-RateLimit-Limit", "10000")
		w.Header().Set("X-RateLimit-Remaining", "9000")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset, 10))
		w.Header().Set("X-RateLimit-Resource", "core")
		if f.low.Load() {
			w.Header().Set("X-RateLimit-Remaining", "1999")
		}
		if f.clock.Load() >= reset {
			w.Header().Set("X-RateLimit-Remaining", "9000")
			w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset+3600, 10))
		}
		if f.pauseIssues.Load() != 0 && r.URL.Path == "/repos/acme/app/issues" {
			w.Header().Set("Retry-After", "50")
			w.WriteHeader(int(f.pauseIssues.Load()))
			return
		}
		fake.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", server.URL)
	codec, err := webhook.NewSecretCodec("polling-key")
	require.NoError(t, err)
	budget := services.NewGitHubResponseBudgetTracker(now)
	f.credentials = services.NewGitHubAppCredentialStore(pool, codec, services.WithGitHubAppCredentialBudget(budget))
	require.NoError(t, f.credentials.Save(t.Context(), app))
	auth := services.NewAuthService(f.q, config.AuthConfig{SessionSecret: "polling-session"}, nil, nil)
	f.sync, err = composeGitHubSync(pool, f.credentials, auth, topology{}, budget, services.WithGitHubSyncedRepoNow(now))
	require.NoError(t, err)
	f.main = services.NewGitHubMainPullService(f.q, nil, nil, nil)
	f.main.UseInstallPolicy()
	f.stack = services.NewMythicalService(pool, nil)
	composeGitHubTodoPolling(f.stack, f.main, f.sync.synced, topology{})
	f.stack.SetOrchestration(services.NewMythicalGitHub(f.q, f.sync.connections, f.sync.userRepositories, f.sync.connections), nil, nil)
	composeGitHubInstallAuthority(f.sync.synced, f.credentials, ready)
	_, err = f.sync.synced.EnrollGitHubRepo(t.Context(), services.EnrollGitHubRepoInput{Owner: "acme", Repo: "app", InstallationID: installation, GitHubRepositoryID: 100, MetadataOnly: true})
	require.NoError(t, err)
	f.user, err = f.q.CreateUser(t.Context(), db.CreateUserParams{Username: "acme", LowerUsername: "acme"})
	require.NoError(t, err)
	repo, err := f.q.CreateRepo(t.Context(), db.CreateRepoParams{UserID: pgtype.Int8{Int64: f.user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	f.repository = repo.ID
	require.NoError(t, f.q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "github.repository", Value: json.RawMessage(fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID))}))
	_, err = pool.Exec(t.Context(), `UPDATE repositories SET mirror_destination='acme/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, f.user.ID)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'github','7','{"login":"acme"}')`, f.user.ID)
	require.NoError(t, err)
	_, err = f.q.RequestMythicalBootstrap(t.Context(), repo.ID, f.user.ID, 1, false)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	handler := &routes.GitHubWebhookHandler{Service: services.NewGitHubWebhookService(pool, f.credentials, services.WithGitHubWebhookSyncedRepos(f.sync.synced))}
	f.router = githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, handler, routerExtras{GitHubSync: f.main, Mythical: &routes.MythicalHandler{Service: f.stack}})
	return f
}

func (f *installPollingComposition) start(t *testing.T) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.sync.synced.StartReconciler(ctx) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Error("poller did not stop")
			}
		})
	}
	t.Cleanup(stop)
	return stop
}
func (f *installPollingComposition) count(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.calls {
		if call == path {
			count++
		}
	}
	return count
}
func (f *installPollingComposition) retry(t *testing.T) {
	t.Helper()
	request := httptest.NewRequest("POST", "/api/github/sync", nil)
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("X-CSRF-Token", "poll-csrf")
	request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "poll-csrf"})
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &f.user, SessionHash: "poll-session"}))
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	require.Equal(t, 202, response.Code, response.Body.String())
}
func (f *installPollingComposition) cached(t *testing.T, resource string) int {
	t.Helper()
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM github_synced_issues WHERE resource=$1`, resource).Scan(&count))
	return count
}

// This composition test qualifies the repository-wide streams and shared
// admission. Per-TODO check/review paging is independently exercised in services;
// main Git transport and reference-host freshness have separate receipts.
func TestInstallPollingCadencesAndBudget(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	for i := 0; i < 100; i++ {
		number := f.upstream.OpenIssue("acme/app", "acme", fmt.Sprint(i), "body")
		f.upstream.SetIssueUpdatedAt("acme/app", number, time.Unix(f.clock.Load()-99+int64(i), 0))
	}
	f.start(t)
	require.Eventually(t, func() bool { return f.cached(t, "issues") == 100 }, 10*time.Second, 20*time.Millisecond)
	for _, path := range []string{"pulls", "issues/events", "issues/comments", "pulls/comments"} {
		require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/"+path) == 1 }, 5*time.Second, 20*time.Millisecond)
	}
	base := f.clock.Load()
	f.clock.Store(base + 44)
	time.Sleep(1100 * time.Millisecond)
	require.Equal(t, 1, f.count("GET /repos/acme/app/pulls"))
	f.clock.Store(base + 45)
	require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/pulls") == 2 }, 5*time.Second, 20*time.Millisecond)
	require.Equal(t, 2, f.count("GET /repos/acme/app/issues"))
	require.Equal(t, 1, f.count("GET /repos/acme/app/issues/events"))
	f.low.Store(true)
	f.retry(t)
	require.Eventually(t, func() bool {
		return f.count("GET /repos/acme/app/pulls") >= 3 &&
			f.count("GET /repos/acme/app/issues") >= 3 &&
			f.count("GET /repos/acme/app/issues/events") >= 2 &&
			f.count("GET /repos/acme/app/pulls/comments") >= 3
	}, 5*time.Second, 20*time.Millisecond)
	issues := f.count("GET /repos/acme/app/issues")
	events := f.count("GET /repos/acme/app/issues/events")
	f.clock.Store(base + 120)
	time.Sleep(1100 * time.Millisecond)
	require.Equal(t, issues, f.count("GET /repos/acme/app/issues"))
	require.Equal(t, events, f.count("GET /repos/acme/app/issues/events"))
	f.clock.Store(base + 240)
	require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/issues") == issues+1 }, 5*time.Second, 20*time.Millisecond)
	require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/issues/events") == events+1 }, 5*time.Second, 20*time.Millisecond)
	f.clock.Store(base + 360)
	require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/issues") == issues+2 }, 5*time.Second, 20*time.Millisecond)
	var unchanged int
	for _, read := range f.upstream.Reads() {
		if read.Status == 304 {
			unchanged++
			require.NotEmpty(t, read.IfNoneMatch)
		}
	}
	require.Greater(t, unchanged, 5)
	f.pauseIssues.Store(429)
	f.retry(t)
	require.Eventually(t, func() bool {
		return !f.sync.budget.StreamRetryAt(351502+pollingFixtureSequence.Load(), "issues").IsZero()
	}, 5*time.Second, 20*time.Millisecond)
	before := f.count("GET /repos/acme/app/issues")
	pulls := f.count("GET /repos/acme/app/pulls")
	f.retry(t)
	require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/pulls") > pulls }, 5*time.Second, 20*time.Millisecond)
	require.Equal(t, before, f.count("GET /repos/acme/app/issues"))
}

func TestInstallWebhookFetchHint(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	f.start(t)
	require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/issues") == 1 }, 5*time.Second, 20*time.Millisecond)
	number := f.upstream.OpenIssue("acme/app", "acme", "Fetched title", "Fetched body")
	payload := []byte(`{"action":"edited","repository":{"id":100,"name":"app","owner":{"login":"acme"}},"issue":{"id":999,"number":1,"state":"open","title":"Forged webhook title"}}`)
	var lastBody string
	send := func(signed bool) int {
		request := httptest.NewRequest("POST", "/webhooks/github", bytes.NewReader(payload))
		request.Header.Set("X-GitHub-Event", "issues")
		request.Header.Set("X-GitHub-Delivery", uuid.NewString())
		if signed {
			mac := hmac.New(sha256.New, []byte("polling-hook"))
			_, _ = mac.Write(payload)
			request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		}
		response := httptest.NewRecorder()
		f.router.ServeHTTP(response, request)
		lastBody = response.Body.String()
		return response.Code
	}
	require.GreaterOrEqual(t, send(false), 400)
	time.Sleep(100 * time.Millisecond)
	require.Zero(t, f.cached(t, "issues"))
	start := time.Now()
	require.Equal(t, 200, send(true), lastBody)
	require.Eventually(t, func() bool { return f.cached(t, "issues") == 1 }, time.Second, 10*time.Millisecond)
	require.Less(t, time.Since(start), time.Second)
	var body []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT payload FROM github_synced_issues WHERE resource='issues' AND number=$1`, number).Scan(&body))
	require.Contains(t, string(body), "Fetched title")
	require.NotContains(t, string(body), "Forged")
}

func TestInstallPollingLandsDark(t *testing.T) {
	f := newInstallPollingComposition(t, false)
	f.start(t)
	time.Sleep(1100 * time.Millisecond)
	require.Zero(t, f.count("GET /repos/acme/app/issues"))
	require.Zero(t, f.cached(t, "issues"))
	require.Error(t, f.main.RetrySync(t.Context()))
	require.Error(t, f.main.PollOnce(t.Context()))
}

func TestInstallScopedTokenCache(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	installation := int64(351502) + pollingFixtureSequence.Load()
	for _, scope := range []services.GitHubTokenScope{{RepositoryIDs: []int64{100}, Permissions: map[string]string{"issues": "read"}}, {RepositoryIDs: []int64{100}, Permissions: map[string]string{"checks": "read"}}, {RepositoryIDs: []int64{101}, Permissions: map[string]string{"issues": "read"}}} {
		first, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation, scope)
		require.NoError(t, err)
		again, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation, scope)
		require.NoError(t, err)
		require.Equal(t, first.Token, again.Token)
	}
	require.Equal(t, 3, f.count("POST /app/installations/"+strconv.FormatInt(installation, 10)+"/access_tokens"))
	other, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation+1000, services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"issues": "read"}})
	require.NoError(t, err)
	require.Equal(t, installation+1000, other.InstallationID)
	require.Equal(t, 1, f.count("POST /app/installations/"+strconv.FormatInt(installation+1000, 10)+"/access_tokens"))

	scope := services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"issues": "read"}}
	before, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation, scope)
	require.NoError(t, err)
	f.clock.Add(55*60 - 1)
	cached, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation, scope)
	require.NoError(t, err)
	require.Equal(t, before.Token, cached.Token)
	require.Equal(t, 3, f.count("POST /app/installations/"+strconv.FormatInt(installation, 10)+"/access_tokens"))
	f.clock.Add(1)
	refreshed, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation, scope)
	require.NoError(t, err)
	require.NotEqual(t, before.Token, refreshed.Token)
	require.Equal(t, 4, f.count("POST /app/installations/"+strconv.FormatInt(installation, 10)+"/access_tokens"))
	require.Equal(t, time.Unix(f.clock.Load(), 0).UTC().Add(time.Hour), refreshed.ExpiresAt)
	for _, call := range f.upstream.Writes() {
		require.True(t, strings.HasSuffix(call.Path, "/access_tokens"))
	}
}

func TestInstallPollingRepositoryDataOnly(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	marker := filepath.Join(t.TempDir(), "executed")
	hostile := "$(touch " + marker + ")\n<script>fetch('/api/secrets')</script>"
	number := f.upstream.OpenIssue("acme/app", "acme", hostile, hostile)
	f.start(t)
	require.Eventually(t, func() bool { return f.cached(t, "issues") == 1 }, 5*time.Second, 20*time.Millisecond)
	var body []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT payload FROM github_synced_issues WHERE resource='issues' AND number=$1`, number).Scan(&body))
	var value struct{ Title, Body string }
	require.NoError(t, json.Unmarshal(body, &value))
	require.Equal(t, hostile, value.Body)
	require.Equal(t, hostile, value.Title)
	_, err := os.Stat(marker)
	require.True(t, os.IsNotExist(err))
	require.NotZero(t, os.Geteuid(), "install polling is admitted only on the installing user's runtime")
}

func TestInstallPullPaging(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	installation := int64(351502) + pollingFixtureSequence.Load()
	token, err := f.sync.connections.CreateGitHubInstallationToken(t.Context(), installation, services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	for i := 1; i <= 60; i++ {
		raw, _ := json.Marshal(map[string]string{"title": fmt.Sprint(i), "head": fmt.Sprintf("smithers/%d", i), "base": "main"})
		request, err := http.NewRequest("POST", f.upstream.URL+"/repos/acme/app/pulls", bytes.NewReader(raw))
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer "+token.Token)
		response, err := f.upstream.Client().Do(request)
		require.NoError(t, err)
		require.Equal(t, 201, response.StatusCode)
		require.NoError(t, response.Body.Close())
		f.upstream.UpdatePull("acme/app", int64(i), func(p *githubfake.Pull) { p.UpdatedAt = time.Unix(f.clock.Load()+int64(i), 0).UTC() })
	}
	f.start(t)
	require.Eventually(t, func() bool { return f.cached(t, "pulls") == 60 }, 10*time.Second, 20*time.Millisecond)
	// The changed old PR remains behind 59 newer rows. Equal-second overlap
	// cannot make a page-one validator stand in for the complete interval.
	f.upstream.UpdatePull("acme/app", 1, func(p *githubfake.Pull) {
		p.Title = "Changed behind page one"
		p.UpdatedAt = time.Unix(f.clock.Load()+60, 0).UTC()
	})
	// Keep 59 newer changed PRs ahead of it in the second read.
	for i := 2; i <= 60; i++ {
		f.upstream.UpdatePull("acme/app", int64(i), func(p *githubfake.Pull) { p.UpdatedAt = time.Unix(f.clock.Load()+60+int64(i), 0).UTC() })
	}
	f.retry(t)
	require.Eventually(t, func() bool {
		var title string
		err := f.pool.QueryRow(t.Context(), `SELECT payload->>'title' FROM github_synced_issues WHERE resource='pulls' AND number=1`).Scan(&title)
		return err == nil && title == "Changed behind page one"
	}, 10*time.Second, 20*time.Millisecond)
	var pageTwo bool
	for _, read := range f.upstream.Reads() {
		if strings.Contains(read.Path, "/pulls?") && strings.Contains(read.Path, "page=2") {
			pageTwo = true
		}
	}
	require.True(t, pageTwo)
}

func TestInstallIssueEventDeliveryRecovery(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	number := f.upstream.OpenIssue("acme/app", "acme", "Label creates a TODO", "Trusted issue")
	event := f.upstream.LabelIssue("acme/app", number, "acme", "todo")
	require.Positive(t, event)
	_, err := f.pool.Exec(t.Context(), `CREATE FUNCTION refuse_event_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.principal_id='issues/events' AND NEW.state='completed' THEN RAISE EXCEPTION 'crash before acknowledgement'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_event_ack BEFORE UPDATE ON product_job_requests FOR EACH ROW EXECUTE FUNCTION refuse_event_ack()`)
	require.NoError(t, err)
	stop := f.start(t)
	require.Eventually(t, func() bool {
		var count int
		err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_dispatches WHERE last_error LIKE '%crash before acknowledgement%'`).Scan(&count)
		return err == nil && count > 0
	}, 10*time.Second, 20*time.Millisecond)
	stop()
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND issue_number=$2`, f.repository, number).Scan(&count))
	require.Zero(t, count, "effects rolled back with the refused acknowledgement")
	var identity string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT request_id FROM product_job_requests WHERE principal_id='issues/events' AND (payload->>'event_id')::bigint=$1`, event).Scan(&identity))
	_, err = f.pool.Exec(t.Context(), `DROP TRIGGER refuse_event_ack ON product_job_requests`)
	require.NoError(t, err)
	// Recompose the real services on the same database and credentials. ETags
	// and timers are lost; the admitted event identity and cursor remain durable.
	assembled, err := composeGitHubSync(f.pool, f.credentials, nil, topology{}, newGitHubBudget(topology{}))
	require.NoError(t, err)
	stack := services.NewMythicalService(f.pool, nil)
	main := services.NewGitHubMainPullService(f.q, nil, nil, nil)
	main.UseInstallPolicy()
	composeGitHubTodoPolling(stack, main, assembled.synced, topology{})
	composeGitHubInstallAuthority(assembled.synced, f.credentials, true)
	stack.SetOrchestration(services.NewMythicalGitHub(f.q, assembled.connections, assembled.userRepositories, assembled.connections), nil, nil)
	f.sync = assembled
	f.start(t)
	require.Eventually(t, func() bool {
		var count int
		err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE principal_id='issues/events' AND request_id=$1 AND state='completed'`, identity).Scan(&count)
		return err == nil && count == 1
	}, 10*time.Second, 20*time.Millisecond)
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND issue_number=$2`, f.repository, number).Scan(&count))
	require.Equal(t, 1, count)
	todos := f.readTodos(t)
	require.Len(t, todos, 1)
	require.Equal(t, "Label creates a TODO", todos[0]["title"])
}

func (f *installPollingComposition) readTodos(t *testing.T) []map[string]any {
	t.Helper()
	request := httptest.NewRequest("GET", "/api/todos", nil)
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &f.user, SessionHash: "poll-session"}))
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var todos []map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &todos))
	return todos
}

// Roster reads join the exact budget and clock used by the install poller.
// The HTTP roster proves that the fetched permission becomes person-facing state.
func TestInstallPollingPermissionsCadenceAndBudget(t *testing.T) {
	f := newInstallPollingComposition(t, true)
	ctx := t.Context()
	writer, err := f.q.CreateUser(ctx, db.CreateUserParams{Username: "writer", LowerUsername: "writer"})
	require.NoError(t, err)
	f.upstream.SetCollaborator(77, "writer", "write")
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,77,'writer','write')`, f.repository, writer.ID)
	require.NoError(t, err)
	members := &services.Members{Pool: f.pool, Credentials: f.credentials, Minter: f.sync.connections}
	wakes := 0
	composeGitHubPermissionPolling(members, f.sync.synced, f.main, func() { wakes++ })
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, f.pool, &routes.GitHubAppSetupHandler{}, nil, routerExtras{Members: &routes.MembersHandler{Service: members}})
	path := "GET /repos/acme/app/collaborators/writer/permission"
	base := f.clock.Load()
	f.resetAt.Store(base + 20000)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 1, f.count(path))
	f.clock.Store(base + 3599)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 1, f.count(path))
	f.clock.Store(base + 3600)
	f.low.Store(true)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 2, f.count(path))
	f.clock.Store(base + 10799)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 2, f.count(path), "low budget doubles only this slow stream")
	f.upstream.SetCollaborator(77, "writer", "read")
	f.clock.Store(base + 10800)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 3, f.count(path))
	request := httptest.NewRequest("GET", "/api/members", nil)
	request = request.WithContext(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &f.user, SessionHash: "poll-session"}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "writer")
	require.Contains(t, response.Body.String(), "suspended")
	// Reset ends the slowdown; Retry is an immediate hint without moving its deadline.
	f.clock.Store(base + 20000)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 4, f.count(path))
	f.clock.Add(3600)
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 5, f.count(path), "reset restores the hourly cadence")
	require.NoError(t, members.RetryStreams(ctx))
	require.Equal(t, 1, wakes)
	require.Equal(t, 5, f.count(path))
	require.NoError(t, members.PollPermissions(ctx))
	require.Equal(t, 6, f.count(path))
}

func TestInstallPollingMissingProvidersAndHostedBoundary(t *testing.T) {
	for _, missing := range []string{"credentials", "storage", "runtime", "permission"} {
		t.Run(missing, func(t *testing.T) {
			f := newInstallPollingComposition(t, false)
			var source services.GitHubAppCredentialSource = f.credentials
			pool := f.pool
			if missing == "credentials" {
				source = nil
			}
			if missing == "storage" {
				pool = nil
			}
			assembled, err := composeGitHubSync(pool, source, nil, topology{}, f.sync.budget)
			if missing == "storage" {
				require.ErrorContains(t, err, "PostgreSQL pool")
				require.Empty(t, f.calls)
				return
			}
			require.NoError(t, err)
			composeGitHubInstallAuthority(assembled.synced, source, missing != "runtime")
			if missing == "permission" {
				members := &services.Members{Pool: f.pool, Credentials: f.credentials}
				composeGitHubPermissionPolling(members, assembled.synced, f.main, func() { t.Error("missing minter cannot wake") })
				require.Error(t, members.PollPermissions(t.Context()))
				_, err := members.RequiredStreams(t.Context())
				require.Error(t, err)
			} else {
				f.sync = assembled
				f.start(t)
				time.Sleep(1100 * time.Millisecond)
				_, err := assembled.synced.RequiredStreams(t.Context())
				require.Error(t, err)
			}
			require.Empty(t, f.calls)
			require.Zero(t, f.cached(t, "issues"))
		})
	}
	t.Run("hosted retains payload ingestion", func(t *testing.T) {
		f := newInstallPollingComposition(t, false)
		hosted, err := composeGitHubSync(f.pool, f.credentials, nil, topology{multitenant: true}, newGitHubBudget(topology{multitenant: true}))
		require.NoError(t, err)
		require.NoError(t, hosted.synced.ApplyIssueEvent(t.Context(), "acme", "app", 100, "issues", "opened", json.RawMessage(`{"id":1,"number":1,"title":"Hosted issue","body":"Hosted body","state":"open","created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z"}`)))
		require.Equal(t, 1, f.cached(t, "issues"))
		require.Empty(t, f.calls)
	})
}

func TestInstallPollingSecondaryLimitIsolation(t *testing.T) {
	for _, status := range []int32{403, 429} {
		t.Run(strconv.Itoa(int(status)), func(t *testing.T) {
			f := newInstallPollingComposition(t, true)
			f.pauseIssues.Store(status)
			f.start(t)
			require.Eventually(t, func() bool {
				return f.count("GET /repos/acme/app/issues") == 1 && f.count("GET /repos/acme/app/pulls") == 1
			}, 5*time.Second, 10*time.Millisecond)
			f.retry(t)
			require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/pulls") == 2 }, 5*time.Second, 10*time.Millisecond)
			require.Equal(t, 1, f.count("GET /repos/acme/app/issues"))
			f.clock.Add(49)
			time.Sleep(1100 * time.Millisecond)
			require.Equal(t, 1, f.count("GET /repos/acme/app/issues"))
			f.pauseIssues.Store(0)
			f.clock.Add(1)
			require.Eventually(t, func() bool { return f.count("GET /repos/acme/app/issues") == 2 }, 5*time.Second, 10*time.Millisecond)
		})
	}
}
