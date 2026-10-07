package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Production install composition and auth, real PostgreSQL; no stub review
// consumer or fabricated successful execution. Missing integrations allocate
// nothing and the old workspace invocation remains closed.
func TestInstallReviewHTTPAdmissionWithoutRuntime(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "review-owner", LowerUsername: "review-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"review-owner","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)}))
	sum := sha256.Sum256([]byte("review-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.EnableKeyAuth = true
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	service := services.NewMythicalService(pool, nil)
	router := buildRouterCompat(
		cfg, q, pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		routerExtras{Mythical: &routes.MythicalHandler{Service: service}},
	)
	for _, tc := range []struct {
		name, body, key string
		cookie          bool
		status          int
		code            string
	}{
		{"signed out", `{"number":50,"conversation":"ben"}`, "review", false, 401, "unauthenticated"},
		{"missing key", `{"number":50,"conversation":"ben"}`, "", true, 400, "invalid_review"},
		{"missing conversation", `{"number":50}`, "review", true, 400, "invalid_review"},
		{"invalid number", `{"number":0,"conversation":"ben"}`, "review", true, 400, "invalid_review"},
		{"caller pin refused", `{"number":50,"conversation":"ben","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, "review", true, 400, "invalid_review"},
		{"caller base refused", `{"number":50,"conversation":"ben","base":"9999999999999999999999999999999999999999"}`, "review", true, 400, "invalid_review"},
		{"trailing JSON", `{"number":50,"conversation":"ben"}{}`, "review", true, 400, "invalid_review"},
		{"no GitHub", `{"number":50,"conversation":"ben"}`, "review", true, 503, "github_unavailable"},
		{"retry no GitHub", `{"number":50,"conversation":"ben"}`, "review", true, 503, "github_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(tc.body))
			req.RemoteAddr = "127.0.0.1:61000"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://localhost:4000")
			req.Header.Set("Idempotency-Key", tc.key)
			if tc.cookie {
				req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
				req.Header.Set("X-CSRF-Token", "review-csrf")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), `"code":"`+tc.code+`"`)
		})
	}
	// Legacy setup stored a GitHub ID instead of the local ID. Every door
	// must use the same slug fallback, including the identity roster boundary.
	t.Run("legacy binding serves member todos and flows", func(t *testing.T) {
		member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "binding-member", LowerUsername: "binding-member", DisplayName: "Member"})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, member.ID)
		require.NoError(t, err)
		sum := sha256.Sum256([]byte("binding-member-cookie"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		legacy := fmt.Sprintf(`{"owner_login":"review-owner","repository_name":"app","repository_id":%d}`, repo.ID+9000000)
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(legacy)}))
		t.Cleanup(func() {
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
		})
		for _, path := range []string{"/api/todos", "/api/flows"} {
			req := httptest.NewRequest("GET", "http://localhost:4000"+path, nil)
			req.RemoteAddr = "127.0.0.1:61001"
			req.AddCookie(&http.Cookie{Name: "session", Value: "binding-member-cookie"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, 200, response.Code, path+": "+response.Body.String())
		}
		_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
		require.NoError(t, err)
		req := httptest.NewRequest("GET", "http://localhost:4000/api/todos", nil)
		req.RemoteAddr = "127.0.0.1:61001"
		req.AddCookie(&http.Cookie{Name: "session", Value: "binding-member-cookie"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		require.Equal(t, 403, response.Code, response.Body.String())
	})
	t.Run("key auth remains absent", func(t *testing.T) {
		for _, path := range []string{"/api/auth/key/nonce", "/api/auth/key/verify", "/api/auth/key/token"} {
			method := "POST"
			if strings.HasSuffix(path, "/nonce") {
				method = "GET"
			}
			req := httptest.NewRequest(method, "http://localhost:4000"+path, nil)
			req.RemoteAddr = "127.0.0.1:61002"
			req.Header.Set("Origin", "http://localhost:4000")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, 404, response.Code, response.Body.String())
		}
	})
	// Reuse this composed router with the production repository/token adapters,
	// real PostgreSQL and GitHub fake; no review-service fake bypasses HTTP.
	seed, err := githubfake.LocalSeedFor("review-owner")
	require.NoError(t, err)
	seed.OAuthCode = "review-owner-code"
	seed.Installations[0].ID = 93612
	seed.Installations[0].Repositories[0].FullName = "review-owner/app"
	upstream, err := githubfake.New(seed)
	require.NoError(t, err)
	t.Cleanup(upstream.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", upstream.URL)
	t.Setenv("SMITHERS_AUTH_GITHUB_API_BASE_URL", upstream.URL)
	response, err := upstream.Client().Post(upstream.URL+"/app-manifests/"+seed.ConversionCode+"/conversions", "application/json", nil)
	require.NoError(t, err)
	require.Equal(t, 201, response.StatusCode)
	require.NoError(t, response.Body.Close())
	response, err = upstream.Client().Post(upstream.URL+"/login/oauth/access_token", "application/x-www-form-urlencoded", strings.NewReader(url.Values{"code": {seed.OAuthCode}, "client_id": {seed.ClientID}, "client_secret": {seed.ClientSecret}, "redirect_uri": {"http://localhost:4000/callback"}}.Encode()))
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	require.NoError(t, response.Body.Close())
	codec, err := webhook.NewSecretCodec("review-read-fixture")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(ctx, services.GitHubAppCredentials{ID: seed.AppID, Slug: seed.Slug, OwnerLogin: seed.OwnerLogin, OwnerKind: seed.OwnerKind, ClientID: seed.ClientID, ClientSecret: seed.ClientSecret, WebhookSecret: seed.WebhookSecret, PEM: seed.PrivateKeyPEM}))
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id,profile_data) VALUES(1,$1,'github','7','{"login":"review-owner"}')`, owner.ID)
	require.NoError(t, err)
	connections := services.NewRepoConnectionService(pool, credentials)
	userRepos := services.NewGitHubUserReposService(q, ownerTokenDecrypter{})
	connections.SetGitHubRepoAccessVerifier(userRepos)
	_, err = connections.ConnectRepo(ctx, owner.ID, "review-owner", "app", "MIT")
	require.NoError(t, err)
	require.NoError(t, connections.ReconcileGitHubAppInstallations(ctx))
	service.SetOrchestration(services.NewMythicalGitHub(q, connections, userRepos, connections), nil, nil)
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) {
		p.Number, p.Repository, p.State = 50, "review-owner/app", "open"
		p.Head.SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		p.Base.SHA = "9999999999999999999999999999999999999999"
		p.User = &githubfake.PullAuthor{ID: 4242, Login: "alice", Type: "User"}
	})
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	writes := len(upstream.Writes())
	requestReview := func(status int, code string) {
		t.Helper()
		req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(`{"number":50,"conversation":"ben"}`))
		req.RemoteAddr = "127.0.0.1:61000"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://localhost:4000")
		req.Header.Set("Idempotency-Key", "review-member-pr")
		req.Header.Set("X-CSRF-Token", "review-csrf")
		req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
		answer := httptest.NewRecorder()
		router.ServeHTTP(answer, req)
		require.Equal(t, status, answer.Code, answer.Body.String())
		require.Contains(t, answer.Body.String(), `"class":"`+map[int]string{403: "permission", 503: "infra"}[status]+`"`)
		require.Contains(t, answer.Body.String(), `"code":"`+code+`"`)
	}
	requestReview(403, "permission") // Login alone is not membership.
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,4242,'alice','write')`, repo.ID, member.ID)
	require.NoError(t, err)
	requestReview(503, "active_flow_unavailable")
	_, err = q.InsertFlowVersion(ctx, repo.ID, "review", "flows/review/flow.ts", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", strings.Repeat("c", 64), "loaded", "", []byte(`{}`))
	require.NoError(t, err)
	active, err := q.ActivateFlowVersion(ctx, repo.ID, "review", strings.Repeat("c", 64))
	require.NoError(t, err)
	require.True(t, active)
	// Legacy/incomplete Active rows must never select a built-in digest or
	// proceed toward execution. In particular Git's missing-object sentinel
	// is syntactically a SHA but cannot identify a pinned closure.
	for _, tc := range []struct {
		name   string
		source any
		status any
		active bool
	}{
		{"missing source", nil, "loaded", true},
		{"missing load status", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", nil, true},
		{"zero source", strings.Repeat("0", 40), "loaded", true},
		{"inactive loaded version", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "loaded", false},
		{"failed version", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "failed", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE workflow_definitions SET source_commit=$2,status=$3,is_active=$4 WHERE repository_id=$1 AND name='review' AND digest=$5`, repo.ID, tc.source, tc.status, tc.active, strings.Repeat("c", 64))
			require.NoError(t, err)
			requestReview(503, "active_flow_unavailable")
		})
	}
	_, err = pool.Exec(ctx, `UPDATE workflow_definitions SET source_commit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',status='loaded',is_active=true WHERE repository_id=$1 AND name='review' AND digest=$2`, repo.ID, strings.Repeat("c", 64))
	require.NoError(t, err)
	requestReview(503, "review_delivery_unavailable")
	requestReview(503, "review_delivery_unavailable") // Refusal replay allocates nothing.
	for _, base := range []string{"", "main", strings.Repeat("0", 40), strings.Repeat("A", 40), strings.Repeat("9", 39), strings.Repeat("9", 41)} {
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Base.SHA = base })
		requestReview(503, "pr_base_unavailable")
	}
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Base.SHA = "9999999999999999999999999999999999999999" })
	requestReview(503, "review_delivery_unavailable")
	for _, head := range []string{"", "alice/cache", strings.Repeat("0", 40), strings.Repeat("A", 40), strings.Repeat("a", 39), strings.Repeat("a", 41)} {
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Head.SHA = head })
		requestReview(503, "pr_head_unavailable")
	}
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Head.SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
	requestReview(503, "review_delivery_unavailable")
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) {
		p.Head.SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		p.User.Type = "Bot"
	})
	requestReview(403, "permission")
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.User.Type = "User" })
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, member.ID)
	require.NoError(t, err)
	requestReview(403, "permission")
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, member.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, member.ID)
	require.NoError(t, err)
	requestReview(403, "permission")
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, member.ID)
	require.NoError(t, err)
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.User.ID = 4343 })
	requestReview(403, "permission") // The old login cannot grant a new ID access.
	// The install sign-in identity uses the historical workos key. A legacy
	// GitHub token row must not impersonate that identity, even with its login.
	_, err = pool.Exec(ctx, `UPDATE oauth_accounts SET provider_user_id='88' WHERE user_id=$1 AND provider='github'`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES(361200,$1,'workos','7')`, owner.ID)
	require.NoError(t, err)
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) {
		p.User = &githubfake.PullAuthor{ID: 7, Login: "review-owner", Type: "User"}
	})
	requestReview(503, "review_delivery_unavailable") // Owner identity passes membership.
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) {
		p.User = &githubfake.PullAuthor{ID: 88, Login: "review-owner", Type: "User"}
	})
	requestReview(403, "permission") // Legacy token identity is not the owner.
	_, err = pool.Exec(ctx, `DELETE FROM oauth_accounts WHERE user_id=$1 AND provider='workos'`, owner.ID)
	require.NoError(t, err)
	requestReview(403, "permission") // Missing sign-in identity fails closed.
	newWrites := upstream.Writes()[writes:]
	require.Len(t, newWrites, 1, "only a read-scoped token mint; no repository writes")
	require.Equal(t, "/app/installations/93612/access_tokens", newWrites[0].Path)
	require.JSONEq(t, `{"repository_ids":[1],"permissions":{"pull_requests":"read"}}`, string(newWrites[0].Body))
	var count int
	for _, table := range []string{"workspaces", "product_job_dispatches", "mythical_items", "mythical_stacks", "approvals"} {
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, table)
	}
	t.Run("durable admission and worker recovery", func(t *testing.T) {
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.User = &githubfake.PullAuthor{ID: 4242, Login: "alice", Type: "User"} })
		machine := &reviewMachineFixture{runs: map[string]string{}}
		delivery := &reviewDeliveryFixture{}
		background, err := services.NewReviewBackground(pool, service, machine, delivery)
		require.NoError(t, err)
		service.SetReviewBackground(background)
		call := func(body, key string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(body))
			req.RemoteAddr = "127.0.0.1:61000"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://localhost:4000")
			req.Header.Set("Idempotency-Key", key)
			req.Header.Set("X-CSRF-Token", "review-csrf")
			req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
			answer := httptest.NewRecorder()
			router.ServeHTTP(answer, req)
			return answer
		}
		body := `{"number":50,"conversation":"ben"}`
		// Every preflight refusal remains before acceptance and allocation.
		for _, code := range []string{"review_binding_unavailable", "review_source_unavailable", "review_digest_mismatch", "review_runtime_unavailable", "review_root_boundary_unavailable"} {
			machine.refusal = code
			answer := call(body, "gate-"+code)
			require.Equal(t, 503, answer.Code, answer.Body.String())
			require.Contains(t, answer.Body.String(), `"code":"`+code+`"`)
		}
		machine.refusal = ""
		answer := call(body, "durable-member-review")
		require.Equal(t, 202, answer.Code, answer.Body.String())
		var selected services.ReviewAdmission
		require.NoError(t, json.Unmarshal(answer.Body.Bytes(), &selected))
		require.NotEmpty(t, selected.OperationID)
		require.Equal(t, jobs.StateAccepted, selected.State)
		require.Equal(t, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", selected.Head)
		require.Equal(t, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", selected.Pin.SourceCommit)
		require.Equal(t, strings.Repeat("c", 64), selected.Pin.ExecutionDigest)
		require.Empty(t, machine.runs, "HTTP acceptance never calls a machine")
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Head.SHA = strings.Repeat("d", 40) })
		_, err = q.InsertFlowVersion(ctx, repo.ID, "review", "flows/review/flow.ts", strings.Repeat("e", 40), strings.Repeat("f", 64), "loaded", "", []byte(`{}`))
		require.NoError(t, err)
		_, err = q.ActivateFlowVersion(ctx, repo.ID, "review", strings.Repeat("f", 64))
		require.NoError(t, err)
		repeated := call(body, "durable-member-review")
		require.Equal(t, 202, repeated.Code, repeated.Body.String())
		var replay services.ReviewAdmission
		require.NoError(t, json.Unmarshal(repeated.Body.Bytes(), &replay))
		require.Equal(t, selected, replay)
		conflict := call(`{"number":50,"conversation":"another"}`, "durable-member-review")
		require.Equal(t, 409, conflict.Code, conflict.Body.String())
		require.Contains(t, conflict.Body.String(), `"code":"idempotency_mismatch"`)
		// Simulate a lost Start reply and a delivery failure. Both recovery passes
		// must keep the original head/pin and reconcile the same operation ID.
		machine.loseStart = true
		delivery.failOnce = true
		workerCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- background.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-recovery", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
		}()
		store, err := jobs.NewStore(pool)
		require.NoError(t, err)
		scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
		require.Eventually(t, func() bool {
			op, e := store.Get(ctx, scope, selected.OperationID)
			return e == nil && op.State == jobs.StateCompleted
		}, 5*time.Second, 10*time.Millisecond)
		cancel()
		require.NoError(t, <-done)
		machine.mu.Lock()
		require.Len(t, machine.runs, 1)
		require.Equal(t, selected.Head, machine.selected.Head)
		require.Equal(t, selected.Pin, machine.selected.Pin)
		require.GreaterOrEqual(t, machine.retired, 1)
		machine.mu.Unlock()
		delivery.mu.Lock()
		require.Equal(t, selected.OperationID, delivery.id)
		require.Equal(t, "ben", delivery.conversation)
		require.JSONEq(t, `{"findings":[{"path":"cache.ts","line":20,"severity":"fix","body":"Off by one"}]}`, string(delivery.change))
		delivery.mu.Unlock()
		// Read the persisted findings through the same install router.
		readReview := func(id, cookie string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("GET", "http://localhost:4000/api/reviews/"+id, nil)
			req.RemoteAddr = "127.0.0.1:61000"
			if cookie != "" {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			return response
		}
		require.Equal(t, 401, readReview(selected.OperationID, "").Code)
		status := readReview(selected.OperationID, "review-cookie")
		require.Equal(t, 200, status.Code, status.Body.String())
		require.Contains(t, status.Body.String(), `"state":"completed"`)
		require.Contains(t, status.Body.String(), `"path":"cache.ts"`)
		require.NotContains(t, status.Body.String(), "SessionHash")
		require.Equal(t, 404, readReview("00000000-0000-4000-8000-000000000001", "review-cookie").Code)
		_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(id,user_id,provider,provider_user_id) VALUES(361201,$1,'workos','4242')`, member.ID)
		require.NoError(t, err)
		memberSession := sha256.Sum256([]byte("alice-review-cookie"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(memberSession[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		require.Equal(t, 404, readReview(selected.OperationID, "alice-review-cookie").Code)
		// Membership revocation also prevents reconnection to a private result.
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, member.ID)
		require.NoError(t, err)
		require.Equal(t, 403, call(body, "durable-member-review").Code)
		for _, table := range []string{"workspaces", "mythical_items", "mythical_stacks"} {
			require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
			require.Zero(t, count, table)
		}
		require.Len(t, upstream.Writes()[writes:], 1, "review has no repository write authority")
	})

}

// Test-only machine and delivery contracts. This is boundary/recovery evidence,
// not C-J10-09 reference-host microVM qualification.
type reviewMachineFixture struct {
	mu        sync.Mutex
	runs      map[string]string
	selected  services.ReviewAdmission
	refusal   string
	loseStart bool
	retired   int
}

func (*reviewMachineFixture) Isolation() workspace.IsolationLevel {
	return workspace.IsolationSandboxed
}
func (m *reviewMachineFixture) Prepare(context.Context, services.ReviewAdmission) error {
	if m.refusal != "" {
		return &services.TodoControlError{Status: 503, Class: "infra", Code: m.refusal, Message: "Review unavailable"}
	}
	return nil
}
func (m *reviewMachineFixture) Start(_ context.Context, id string, a services.ReviewAdmission) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.selected = a
	if m.runs[id] == "" {
		m.runs[id] = "review-run"
	}
	if m.loseStart {
		m.loseStart = false
		return "", fmt.Errorf("lost Start reply")
	}
	return m.runs[id], nil
}
func (*reviewMachineFixture) Observe(context.Context, string, services.ReviewAdmission) (services.ReviewObservation, error) {
	return services.ReviewObservation{State: jobs.StateCompleted, Change: json.RawMessage(`{"findings":[{"path":"cache.ts","line":20,"severity":"fix","body":"Off by one"}]}`)}, nil
}
func (m *reviewMachineFixture) Retire(context.Context, string, services.ReviewAdmission) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.retired++
	return nil
}

type reviewDeliveryFixture struct {
	mu               sync.Mutex
	failOnce         bool
	id, conversation string
	change           json.RawMessage
}

func (*reviewDeliveryFixture) Ready(context.Context, services.ReviewAdmission) error { return nil }
func (d *reviewDeliveryFixture) Deliver(_ context.Context, id string, a services.ReviewAdmission, change json.RawMessage) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.failOnce {
		d.failOnce = false
		return fmt.Errorf("delivery unavailable")
	}
	d.id, d.conversation, d.change = id, a.Conversation, change
	return nil
}
