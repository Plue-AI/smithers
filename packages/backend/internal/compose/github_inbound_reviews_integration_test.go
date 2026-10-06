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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This receiver is a packaged protocol fixture, not a repository-code runtime.
// The production dispatcher, its PostgreSQL intents and authorizer are real.
type reviewFixtureReceiver struct {
	flowruntime.Runtime
	mu       sync.Mutex
	messages map[string]flowruntime.Steer
}

func (r *reviewFixtureReceiver) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}, nil
}
func (r *reviewFixtureReceiver) Observe(_ context.Context, run, _ string, _ int) (flowruntime.Observation, error) {
	return flowruntime.Observation{Run: flowruntime.Run{RunID: run, FlowID: "todo", Status: "waiting"}, Events: []flowruntime.Event{}}, nil
}
func (r *reviewFixtureReceiver) Steer(_ context.Context, input flowruntime.Steer) (flowruntime.MutationResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tag := "Accepted"
	if _, applied := r.messages[input.MessageID]; applied {
		tag = "AlreadyApplied"
	}
	r.messages[input.MessageID] = input
	return flowruntime.MutationResult{Operation: "steer", ApplicationRequestID: input.ApplicationRequestID, Receipt: flowruntime.Receipt{Tag: tag, ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}

func TestGitHubCommentSteerThroughComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	credentials := services.GitHubAppCredentials{ID: 42, Slug: "review-install", OwnerLogin: "owner", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: "review-hook", InstallationID: 91, PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}
	upstream, err := githubfake.New(githubfake.Config{AppID: 42, Slug: credentials.Slug, OwnerLogin: "owner", OwnerKind: "user", ClientID: "client", ClientSecret: "secret", WebhookSecret: credentials.WebhookSecret, PrivateKeyPEM: credentials.PEM, Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "owner/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(upstream.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", upstream.URL)
	t.Setenv("SMITHERS_AUTH_GITHUB_API_BASE_URL", upstream.URL)
	codec, err := webhook.NewSecretCodec("review-install-key")
	require.NoError(t, err)
	source := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, source.Save(ctx, credentials))
	assembled, err := composeGitHubSync(pool, source, nil, topology{}, newGitHubBudget(topology{}))
	require.NoError(t, err)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE repositories SET mirror_destination='owner/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1);`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,7,'owner','admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "proposed", Checks: []byte(`{"todo":true,"branch":"smithers/review","run_launched":true,"run_attached":true,"flowSource":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,title='Review fixture',attempt=1,request_run_id='fixture-run',workspace_id='11111111-1111-4111-8111-111111111111',flow_digest=$3,pr_number=1,pr_state='open',pr_url='https://github.com/owner/app/pull/1' WHERE id=$1`, item.ID, owner.ID, strings.Repeat("a", 64))
	require.NoError(t, err)
	stack := services.NewMythicalService(pool, nil)
	main := services.NewGitHubMainPullService(q, nil, nil, nil)
	composeGitHubTodoPolling(stack, main, assembled.synced, topology{})
	composeGitHubInstallAuthority(assembled.synced, source, true)
	stack.EnableTodoPublication(source, assembled.connections, assembled.budget)
	stack.SetTodoFlow(func(context.Context, int64, string) (string, error) { return strings.Repeat("a", 64), nil })
	stack.EnableTodoSteering()
	receiver := &reviewFixtureReceiver{messages: map[string]flowruntime.Steer{}}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return receiver, nil }), SteerAuthorizer: stack, Projector: stack})
	require.NoError(t, err)
	stack.SetLauncher(dispatcher)
	_, err = assembled.synced.EnrollGitHubRepo(ctx, services.EnrollGitHubRepoInput{Owner: "owner", Repo: "app", InstallationID: 91, GitHubRepositoryID: 100, MetadataOnly: true})
	require.NoError(t, err)
	// Only the signed hint is admitted; its forged comment body cannot steer.
	hooks := services.NewGitHubWebhookService(pool, source, services.WithGitHubWebhookSyncedRepos(assembled.synced))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, &routes.GitHubWebhookHandler{Service: hooks}, routerExtras{Mythical: &routes.MythicalHandler{Service: stack}})
	issue := upstream.OpenIssue("owner/app", "owner", "PR conversation fixture", "")
	require.EqualValues(t, 1, issue)
	comment := upstream.CommentIssue("owner/app", issue, "owner", "Use the existing backoff helper")
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); assembled.synced.StartReconciler(workerCtx) }()
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_review_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='flow.runtime.steer' AND NEW.state='completed' THEN RAISE EXCEPTION 'crash after runtime acceptance'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_review_ack BEFORE UPDATE ON product_job_requests FOR EACH ROW EXECUTE FUNCTION refuse_review_ack()`)
	require.NoError(t, err)
	dispatchDone := make(chan error, 1)
	go func() {
		dispatchDone <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-fixture", Capacity: 1, Lease: 2 * time.Second, PollInterval: 10 * time.Millisecond, RetryDelay: 10 * time.Millisecond, MaxRetryDelay: 20 * time.Millisecond})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("sync worker did not stop")
		}
		select {
		case err := <-dispatchDone:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("dispatcher did not stop")
		}
	})
	hint := func() {
		payload := []byte(fmt.Sprintf(`{"action":"created","installation":{"id":91},"repository":{"id":100,"name":"app","owner":{"login":"owner"}},"issue":{"number":1,"pull_request":{}},"comment":{"id":%d,"body":"FORGED WEBHOOK BODY"}}`, comment))
		mac := hmac.New(sha256.New, []byte(credentials.WebhookSecret))
		_, _ = mac.Write(payload)
		request := httptest.NewRequest(http.MethodPost, "/webhooks/github", bytes.NewReader(payload))
		request.Header.Set("X-GitHub-Event", "issue_comment")
		request.Header.Set("X-GitHub-Delivery", uuid.NewString())
		request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, 200, response.Code, response.Body.String())
	}
	t0 := time.Now()
	hint()
	hint()
	require.Eventually(t, func() bool { receiver.mu.Lock(); defer receiver.mu.Unlock(); return len(receiver.messages) == 1 }, 15*time.Second, 20*time.Millisecond)
	require.Less(t, time.Since(t0), 60*time.Second)
	require.Eventually(t, func() bool {
		var count int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.operation='flow.runtime.steer' AND d.last_error LIKE '%crash after runtime acceptance%'`).Scan(&count)
		return err == nil && count > 0
	}, 5*time.Second, 10*time.Millisecond)
	var unacknowledged int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer' AND state='completed'`).Scan(&unacknowledged))
	require.Zero(t, unacknowledged)
	_, err = pool.Exec(ctx, `DROP TRIGGER refuse_review_ack ON product_job_requests`)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		var count int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer' AND state='completed'`).Scan(&count)
		return err == nil && count == 1
	}, 5*time.Second, 10*time.Millisecond)
	hint()

	request := httptest.NewRequest("GET", "/api/todos/1", nil).WithContext(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var card map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card))
	require.Equal(t, "working", card["state"])
	require.Contains(t, response.Body.String(), "Use the existing backoff helper")
	require.NotContains(t, response.Body.String(), "FORGED WEBHOOK BODY")
	receiver.mu.Lock()
	for _, message := range receiver.messages {
		require.Equal(t, "Use the existing backoff helper", message.Body)
		require.Equal(t, map[string]string{"person": "owner"}, message.Attribution)
	}
	receiver.mu.Unlock()
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.github_input'`).Scan(&count))
	require.Equal(t, 1, count)
}
