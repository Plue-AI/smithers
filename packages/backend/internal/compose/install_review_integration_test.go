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

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Production install router/auth with real PostgreSQL and GitHub fake. Missing
// integrations allocate nothing. The success/recovery portion uses explicitly
// test-only machine and delivery ports; it does not qualify a real microVM.
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
	// Findings already committed by the shared producer must survive reload.
	// This exercises the production reader, not a new review journal writer.
	chatStore, err := chat.NewStore(pool)
	require.NoError(t, err)
	mountChatPublic(router.(chi.Router), &chat.Runtime{Handler: &chat.Handler{Store: chatStore, ResolveBranch: conversationBranchResolver(services.NewWorkspaceService(q))}}, q, cfg)
	t.Run("shared conversation retains review findings", func(t *testing.T) {
		_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write') ON CONFLICT DO NOTHING`, repo.ID, owner.ID)
		require.NoError(t, err)
		scope := chat.Scope{RepositoryID: repo.ID, UserID: owner.ID, Owner: owner.Username}
		admitted, err := chatStore.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: "shared-review", Journal: chat.JournalRequest{Version: 1, LegID: "review", Token: strings.Repeat("a", 64)}, Request: json.RawMessage(`{"runId":"shared-review","conversationId":"main","sharedConversation":true,"messages":[{"role":"user","content":"/review #50"}]}`)})
		require.NoError(t, err)
		grant, err := chatStore.Claim(ctx, scope, admitted.TurnID, time.Minute)
		require.NoError(t, err)
		finding := json.RawMessage(`{"runId":"shared-review","type":"card","card":{"id":"review-50","kind":"change","title":"Review","payload":{"repo":"review-owner/app","changeId":"review-50","commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","facet":"findings","findings":[{"analyzer":"review","severity":"fix","path":"cache.ts","line":20,"summary":"Off by one"}]}}}`)
		_, err = chatStore.Commit(ctx, chat.CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{
			json.RawMessage(`{"runId":"shared-review","type":"tool_call","call_id":"private","name":"review","arguments":"private-tool-canary"}`),
			json.RawMessage(`{"runId":"shared-review","type":"card","card":{"kind":"confirm","payload":{"secret":"private-confirm-canary"}}}`),
			finding, json.RawMessage(`{"runId":"shared-review","type":"done","reason":"stop"}`),
		}})
		require.NoError(t, err)
		private, err := chatStore.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: "private-review", Journal: chat.JournalRequest{Version: 1, LegID: "review", Token: strings.Repeat("b", 64)}, Request: json.RawMessage(`{"runId":"private-review","conversationId":"main","sharedConversation":false,"messages":[{"role":"user","content":"private-review-canary"}]}`)})
		require.NoError(t, err)
		privateGrant, err := chatStore.Claim(ctx, scope, private.TurnID, time.Minute)
		require.NoError(t, err)
		_, err = chatStore.Commit(ctx, chat.CommitInput{TurnID: privateGrant.TurnID, Generation: privateGrant.Generation, Token: privateGrant.Token, Expected: privateGrant.Cursor, Frames: []json.RawMessage{json.RawMessage(strings.ReplaceAll(string(finding), "shared-review", "private-review")), json.RawMessage(`{"runId":"private-review","type":"done","reason":"stop"}`)}})
		require.NoError(t, err)
		for range 2 {
			req := httptest.NewRequest("GET", "http://localhost:4000/api/conversations/main", nil)
			req.RemoteAddr = "127.0.0.1:61000"
			req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var conversation chat.SharedConversation
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &conversation))
			require.Len(t, conversation.Entries, 1)
			require.Len(t, conversation.Entries[0].Frames, 2)
			require.JSONEq(t, string(finding), string(conversation.Entries[0].Frames[0]))
			require.NotContains(t, response.Body.String(), "private-tool-canary")
			require.NotContains(t, response.Body.String(), "private-confirm-canary")
			require.NotContains(t, response.Body.String(), "private-review-canary")
		}
	})
	for _, tc := range []struct {
		name, body, key string
		cookie          bool
		status          int
		code            string
	}{
		{"signed out", `{"number":50,"conversation":"main"}`, "review", false, 401, "unauthenticated"},
		{"missing key", `{"number":50,"conversation":"main"}`, "", true, 400, "invalid_review"},
		{"missing conversation", `{"number":50}`, "review", true, 400, "invalid_review"},
		{"invalid number", `{"number":0,"conversation":"main"}`, "review", true, 400, "invalid_review"},
		{"caller pin refused", `{"number":50,"conversation":"main","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, "review", true, 400, "invalid_review"},
		{"caller base refused", `{"number":50,"conversation":"main","base":"9999999999999999999999999999999999999999"}`, "review", true, 400, "invalid_review"},
		{"trailing JSON", `{"number":50,"conversation":"main"}{}`, "review", true, 400, "invalid_review"},
		{"no GitHub", `{"number":50,"conversation":"main"}`, "review", true, 503, "github_unavailable"},
		{"retry no GitHub", `{"number":50,"conversation":"main"}`, "review", true, 503, "github_unavailable"},
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
		req := httptest.NewRequest("POST", "http://localhost:4000/api/reviews", strings.NewReader(`{"number":50,"conversation":"main"}`))
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
	// No flow-load has settled, so no commit holds the built-in version yet.
	requestReview(503, "active_flow_unavailable")
	_, err = q.InsertFlowVersion(ctx, repo.ID, "review", "flows/review/flow.ts", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", strings.Repeat("c", 64), "loaded", "", []byte(`{}`))
	require.NoError(t, err)
	active, err := q.ActivateFlowVersion(ctx, repo.ID, "review", strings.Repeat("c", 64))
	require.NoError(t, err)
	require.True(t, active)
	// A settled flow-load names the commit that holds the built-in version.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	_, err = q.EnsureFlowLoad(ctx, repo.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE flow_loads SET loaded_commit=$2 WHERE repository_id=$1`, repo.ID, strings.Repeat("7", 40))
	require.NoError(t, err)
	// Legacy/incomplete Active rows must never select a built-in digest or
	// proceed toward execution. In particular Git's missing-object sentinel
	// is syntactically a SHA but cannot identify a pinned closure.
	for _, tc := range []struct {
		name   string
		source any
		status any
	}{
		{"missing source", nil, "loaded"},
		{"missing load status", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", nil},
		{"zero source", strings.Repeat("0", 40), "loaded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE workflow_definitions SET source_commit=$2,status=$3,is_active=true WHERE repository_id=$1 AND name='review' AND digest=$4`, repo.ID, tc.source, tc.status, strings.Repeat("c", 64))
			require.NoError(t, err)
			requestReview(503, "active_flow_unavailable")
		})
	}
	// An inactive or failed repository version leaves Active on the built-in
	// version, which admission pins at the settled flow-load commit.
	for _, tc := range []struct {
		name   string
		status string
	}{{"inactive loaded version", "loaded"}, {"failed version", "failed"}} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE workflow_definitions SET source_commit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',status=$2,is_active=false WHERE repository_id=$1 AND name='review' AND digest=$3`, repo.ID, tc.status, strings.Repeat("c", 64))
			require.NoError(t, err)
			requestReview(503, "review_delivery_unavailable")
		})
	}
	// Without a settled flow-load no commit holds the built-in version.
	_, err = pool.Exec(ctx, `DELETE FROM mythical_stacks WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	requestReview(503, "active_flow_unavailable")
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
	t.Run("ephemeral machine adapter and real delivery", func(t *testing.T) {
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.User = &githubfake.PullAuthor{ID: 4242, Login: "alice", Type: "User"} })
		exerciseReviewMachine(t, pool, service, chatStore, router, repo.ID, owner.ID)
		service.SetReviewBackground(nil)
	})
	t.Run("durable admission and worker recovery", func(t *testing.T) {
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.User = &githubfake.PullAuthor{ID: 4242, Login: "alice", Type: "User"} })
		machine := &reviewMachineFixture{runs: map[string]string{}}
		delivery := &reviewDeliveryFixture{real: reviewConversationDelivery{store: chatStore, resolve: conversationBranchResolver(services.NewWorkspaceService(q))}}
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
		body := `{"number":50,"conversation":"main"}`
		wrongRepository := call(`{"number":50,"repo":"other/app","conversation":"main"}`, "wrong-repository")
		require.Equal(t, 403, wrongRepository.Code, wrongRepository.Body.String())
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
		require.Equal(t, "main", delivery.conversation)
		require.JSONEq(t, `{"repo":"review-owner/app","changeId":"review-50","description":"Review","commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","currentSeq":null,"revisionCount":null,"revisions":[],"authorName":null,"timestamp":null,"repos":[],"diff":null,"checks":null,"findings":[{"analyzer":"review","severity":"fix","path":"cache.ts","line":20,"summary":"Off by one","raisedAtSeq":null}],"reviews":null,"threads":null,"conflicts":null,"stack":null,"changeset":null}`, string(delivery.change))
		delivery.mu.Unlock()
		// Delivery actually committed before its lost reply. Recovery must
		// publish one retained result, with no claimable model turn.
		req := httptest.NewRequest("GET", "http://localhost:4000/api/conversations/main", nil)
		req.RemoteAddr = "127.0.0.1:61000"
		req.AddCookie(&http.Cookie{Name: "session", Value: "review-cookie"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var conversation chat.SharedConversation
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &conversation))
		require.Len(t, conversation.Entries, 3)
		result := conversation.Entries[2]
		require.Equal(t, "/review #50", result.Prompt)
		require.Equal(t, chat.StateCompleted, result.State)
		require.Len(t, result.Frames, 3)
		require.Contains(t, string(result.Frames[1]), "https://github.com/review-owner/app/pull/50")
		require.Contains(t, string(result.Frames[0]), `"facet":"findings"`)
		require.Contains(t, string(result.Frames[0]), `"path":"cache.ts"`)
		require.Contains(t, string(result.Frames[0]), `"commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`)
		require.ErrorIs(t, chatStore.DeliverReview(ctx, chat.Scope{RepositoryID: repo.ID, UserID: owner.ID}, "main", selected.OperationID, selected.URL, 50, json.RawMessage(`{"findings":[]}`)), chat.ErrConflict)
		_, err = chatStore.Claim(ctx, chat.Scope{RepositoryID: repo.ID, UserID: owner.ID, Owner: "review-owner"}, result.ID, time.Minute)
		require.Error(t, err, "completed delivery is never claimable")
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
		// Delegated requests persist Confirm only; the person's session is the
		// sole credential that can atomically approve and admit a review job.
		token := "smithers_" + strings.Repeat("c", 40)
		tokenSum := sha256.Sum256([]byte(token))
		tokenHash := hex.EncodeToString(tokenSum[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "review-confirm", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		confirmCall := func(path, key, cookie string, delegated bool) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "http://localhost:4000"+path, strings.NewReader(body))
			req.RemoteAddr = "127.0.0.1:61000"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", "http://localhost:4000")
			req.Header.Set("Idempotency-Key", key)
			req.Header.Set("X-CSRF-Token", "review-csrf")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "review-csrf"})
			if delegated {
				req.Header.Set("Authorization", "Bearer "+token)
			} else {
				req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			}
			answer := httptest.NewRecorder()
			router.ServeHTTP(answer, req)
			return answer
		}
		requestConfirm := func(key string) services.ConfirmationReceipt {
			answer := confirmCall("/api/reviews", key, "", true)
			require.Equal(t, 202, answer.Code, answer.Body.String())
			var receipt services.ConfirmationReceipt
			require.NoError(t, json.Unmarshal(answer.Body.Bytes(), &receipt))
			require.Equal(t, "pending", receipt.State)
			return receipt
		}
		pending := requestConfirm("delegated-review")
		require.Equal(t, pending, requestConfirm("delegated-review"))
		var jobCount int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review' AND request_id <> 'adapter-review'`).Scan(&jobCount))
		require.Equal(t, 1, jobCount)
		require.Equal(t, 403, confirmCall("/api/confirmations/"+pending.ID+"/approve", "agent-review-press", "", true).Code)
		require.Equal(t, 403, confirmCall("/api/confirmations/"+pending.ID+"/approve", "other-review-press", "alice-review-cookie", false).Code)
		for range 2 {
			approved := confirmCall("/api/confirmations/"+pending.ID+"/approve", "person-review-press", "review-cookie", false)
			require.Equal(t, 200, approved.Code, approved.Body.String())
		}
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review' AND request_id <> 'adapter-review'`).Scan(&jobCount))
		require.Equal(t, 2, jobCount)
		var confirmedID string
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'effect'->>'review' FROM approvals WHERE id=$1`, pending.ID).Scan(&confirmedID))
		require.Equal(t, 200, readReview(confirmedID, "review-cookie").Code)
		// The live app-agent turn follows the same Confirm consumer as the CLI.
		cliToken := token
		turn := liveAppTurnCredentialFixture(t, pool, owner.ID)
		token = "smithers_" + strings.Repeat("e", 40)
		appTokenSum := sha256.Sum256([]byte(token))
		appTokenHash := hex.EncodeToString(appTokenSum[:])
		_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "app-review-confirm", TokenHash: appTokenHash, TokenLastEight: appTokenHash[len(appTokenHash)-8:], Scopes: "read:repository,write:repository,via:smithers,terminal-session:" + turn + "/1", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		appPending := requestConfirm("app-agent-review")
		require.Equal(t, 403, confirmCall("/api/confirmations/"+appPending.ID+"/approve", "app-agent-review-press", "", true).Code)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review' AND request_id <> 'adapter-review'`).Scan(&jobCount))
		require.Equal(t, 2, jobCount)
		appApproved := confirmCall("/api/confirmations/"+appPending.ID+"/approve", "person-app-review-press", "review-cookie", false)
		require.Equal(t, 200, appApproved.Code, appApproved.Body.String())
		token = cliToken
		// A changed PR head invalidates the selected confirmation snapshot.
		stale := requestConfirm("stale-review-confirm")
		upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Head.SHA = strings.Repeat("8", 40) })
		require.Equal(t, 409, confirmCall("/api/confirmations/"+stale.ID+"/approve", "stale-review-press", "review-cookie", false).Code)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review' AND request_id <> 'adapter-review'`).Scan(&jobCount))
		require.Equal(t, 3, jobCount)
		cancelled := requestConfirm("cancel-review-confirm")
		denied := confirmCall("/api/confirmations/"+cancelled.ID+"/deny", "person-cancel-review", "review-cookie", false)
		require.Equal(t, 200, denied.Code, denied.Body.String())
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.review' AND request_id <> 'adapter-review'`).Scan(&jobCount))
		require.Equal(t, 3, jobCount)
		machine.mu.Lock()
		require.Len(t, machine.runs, 1)
		machine.mu.Unlock()
		// Membership revocation also prevents reconnection to a private result.
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, member.ID)
		require.NoError(t, err)
		require.Equal(t, 403, call(body, "durable-member-review").Code)
		// An accepted but unstarted job rechecks the author's live membership.
		workerCtx, cancel = context.WithCancel(ctx)
		done = make(chan error, 1)
		go func() {
			done <- background.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-revoked", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond})
		}()
		require.Eventually(t, func() bool {
			op, e := store.Get(ctx, scope, confirmedID)
			return e == nil && op.State == jobs.StateFailed
		}, 5*time.Second, 10*time.Millisecond)
		cancel()
		require.NoError(t, <-done)
		machine.mu.Lock()
		require.Len(t, machine.runs, 1)
		machine.mu.Unlock()
		// A lost launch reply must not leak the allocated machine if membership
		// is revoked before the next recovery pass can learn its run ID.
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, member.ID)
		require.NoError(t, err)
		lostMachine := &reviewMachineFixture{runs: map[string]string{}, loseStart: true}
		lostBackground, err := services.NewReviewBackground(pool, service, lostMachine, &reviewDeliveryFixture{})
		require.NoError(t, err)
		service.SetReviewBackground(lostBackground)
		lostAnswer := call(body, "lost-launch-revoked")
		require.Equal(t, 202, lostAnswer.Code, lostAnswer.Body.String())
		var lostAdmission services.ReviewAdmission
		require.NoError(t, json.Unmarshal(lostAnswer.Body.Bytes(), &lostAdmission))
		retireGate := make(chan struct{})
		retireEntered := make(chan struct{}, 1)
		var retireRelease sync.Once
		releaseRetire := func() { retireRelease.Do(func() { close(retireGate) }) }
		t.Cleanup(releaseRetire)
		lostMachine.retireGateID, lostMachine.retireGate, lostMachine.retireEntered = lostAdmission.OperationID, retireGate, retireEntered
		lostMachine.retireFailID = lostAdmission.OperationID
		lostMachine.loseStartID = lostAdmission.OperationID
		lostMachine.onLost = func() error {
			_, e := pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, member.ID)
			return e
		}
		workerCtx, cancel = context.WithCancel(ctx)
		done = make(chan error, 1)
		go func() {
			done <- lostBackground.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-lost-revoked", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
		}()
		select {
		case <-retireEntered:
		case <-time.After(5 * time.Second):
			t.Fatal("uncertain launch never reached retirement")
		}
		pendingStatus := readReview(lostAdmission.OperationID, "review-cookie")
		require.Equal(t, 200, pendingStatus.Code, pendingStatus.Body.String())
		var retiring services.ReviewStatus
		require.NoError(t, json.Unmarshal(pendingStatus.Body.Bytes(), &retiring))
		require.Contains(t, []jobs.State{jobs.StateAccepted, jobs.StateDispatching, jobs.StateRunning, jobs.StateWaiting}, retiring.State)
		history := readReview(selected.OperationID, "review-cookie")
		require.Equal(t, 200, history.Code, history.Body.String())
		require.Contains(t, history.Body.String(), `"path":"cache.ts"`)
		releaseRetire()
		require.Eventually(t, func() bool {
			op, e := store.Get(ctx, scope, lostAdmission.OperationID)
			return e == nil && op.State == jobs.StateFailed
		}, 5*time.Second, 10*time.Millisecond)
		cancel()
		require.NoError(t, <-done)
		lostMachine.mu.Lock()
		require.Contains(t, lostMachine.runs, lostAdmission.OperationID)
		require.True(t, lostMachine.retiredOperations[lostAdmission.OperationID], "retire an uncertain launch before terminal refusal")
		require.GreaterOrEqual(t, lostMachine.retireAttempts[lostAdmission.OperationID], 2, "failed cleanup must remain retryable")
		lostMachine.mu.Unlock()
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, member.ID)
		require.NoError(t, err)
		service.SetReviewBackground(background)
		for _, revoked := range []struct {
			name, revoke, restore string
			user                  int64
		}{
			{"author", `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, member.ID},
			{"requester", `UPDATE users SET prohibit_login=true WHERE id=$1`, `UPDATE users SET prohibit_login=false WHERE id=$1`, owner.ID},
		} {
			t.Run("revocation after a persisted run/"+revoked.name, func(t *testing.T) {
				machine.mu.Lock()
				beforeRetired, beforeObserved, beforeRuns := machine.retired, machine.observed, len(machine.runs)
				machine.observeHook = func() error {
					_, err := pool.Exec(ctx, revoked.revoke, revoked.user)
					return err
				}
				machine.mu.Unlock()
				answer := call(body, "persisted-run-revoked-"+revoked.name)
				require.Equal(t, 202, answer.Code, answer.Body.String())
				var pending services.ReviewAdmission
				require.NoError(t, json.Unmarshal(answer.Body.Bytes(), &pending))
				workerCtx, cancel := context.WithCancel(ctx)
				done := make(chan error, 1)
				go func() {
					done <- background.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "review-running-recovery", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
				}()
				t.Cleanup(func() { cancel(); <-done })
				require.Eventually(t, func() bool {
					op, e := store.Get(ctx, scope, pending.OperationID)
					return e == nil && op.State == jobs.StateFailed
				}, 5*time.Second, 10*time.Millisecond)
				op, err := store.Get(ctx, scope, pending.OperationID)
				require.NoError(t, err)
				require.JSONEq(t, `{"class":"permission","code":"permission"}`, string(op.TerminalReceipt))
				machine.mu.Lock()
				runs, retired, observed := len(machine.runs), machine.retired, machine.observed
				machine.mu.Unlock()
				require.Equal(t, beforeRuns+1, runs)
				require.Equal(t, beforeRetired+1, retired)
				require.Equal(t, beforeObserved+1, observed, "revoked run is not observed again")
				delivery.mu.Lock()
				require.Equal(t, selected.OperationID, delivery.id, "revoked run never delivers findings")
				delivery.mu.Unlock()
				_, err = pool.Exec(ctx, revoked.restore, revoked.user)
				require.NoError(t, err)
			})
		}
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
	observed                   int
	observeHook                func() error
	mu                         sync.Mutex
	runs                       map[string]string
	selected                   services.ReviewAdmission
	refusal                    string
	loseStart                  bool
	loseStartID                string
	onLost                     func() error
	retiredOperations          map[string]bool
	retireAttempts             map[string]int
	retireGateID, retireFailID string
	retireGate                 <-chan struct{}
	retireEntered              chan<- struct{}
	retired                    int
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
	if m.loseStart && (m.loseStartID == "" || m.loseStartID == id) {
		m.loseStart = false
		if m.onLost != nil {
			if err := m.onLost(); err != nil {
				return "", err
			}
		}
		return "", fmt.Errorf("lost Start reply")
	}
	return m.runs[id], nil
}
func (m *reviewMachineFixture) Observe(context.Context, string, services.ReviewAdmission) (services.ReviewObservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observed++
	if m.observeHook != nil {
		hook := m.observeHook
		m.observeHook = nil
		if err := hook(); err != nil {
			return services.ReviewObservation{}, err
		}
		return services.ReviewObservation{State: jobs.StateRunning}, nil
	}

	return services.ReviewObservation{State: jobs.StateCompleted, Change: json.RawMessage(`{"repo":"review-owner/app","changeId":"review-50","description":"Review","commitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","currentSeq":null,"revisionCount":null,"revisions":[],"authorName":null,"timestamp":null,"repos":[],"diff":null,"checks":null,"findings":[{"analyzer":"review","severity":"fix","path":"cache.ts","line":20,"summary":"Off by one","raisedAtSeq":null}],"reviews":null,"threads":null,"conflicts":null,"stack":null,"changeset":null}`)}, nil
}
func (m *reviewMachineFixture) Retire(_ context.Context, id string, _ services.ReviewAdmission) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.retireAttempts == nil {
		m.retireAttempts = map[string]int{}
	}
	m.retireAttempts[id]++
	if m.retireGateID == id && m.retireGate != nil {
		select {
		case m.retireEntered <- struct{}{}:
		default:
		}
		<-m.retireGate
	}
	if m.retireFailID == id {
		m.retireFailID = ""
		return fmt.Errorf("retirement retry")
	}
	m.retired++
	if m.retiredOperations == nil {
		m.retiredOperations = map[string]bool{}
	}
	m.retiredOperations[id] = true
	return nil
}

type reviewDeliveryFixture struct {
	real             services.ReviewDelivery
	mu               sync.Mutex
	failOnce         bool
	id, conversation string
	change           json.RawMessage
}

func (d *reviewDeliveryFixture) Ready(ctx context.Context, a services.ReviewAdmission) error {
	if d.real != nil {
		return d.real.Ready(ctx, a)
	}
	return nil
}
func (d *reviewDeliveryFixture) Deliver(ctx context.Context, id string, a services.ReviewAdmission, change json.RawMessage) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.real != nil {
		if err := d.real.Deliver(ctx, id, a, change); err != nil {
			return err
		}
	}
	if d.failOnce {
		d.failOnce = false
		return fmt.Errorf("delivery unavailable")
	}
	d.id, d.conversation, d.change = id, a.Conversation, change
	return nil
}
