package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
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
	upstream.UpdatePull("review-owner/app", 50, func(p *githubfake.Pull) { p.Head.SHA = strings.Repeat("0", 40) })
	requestReview(503, "pr_head_unavailable")
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
}
