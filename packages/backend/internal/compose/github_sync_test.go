package compose

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestGitHubRepositoryResponseRefreshPauseThroughComposition(t *testing.T) {
	ctx := t.Context()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	var reads, refreshes atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user/repos":
			reads.Add(1)
			w.WriteHeader(401)
		case "/login/oauth/access_token":
			refreshes.Add(1)
			require.NoError(t, r.ParseForm())
			require.Equal(t, "refresh", r.Form.Get("refresh_token"))
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(429)
			_, _ = w.Write([]byte(`{"error":"slow_down"}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer upstream.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", upstream.URL)
	budget := newGitHubBudget(topology{})
	codec, err := webhook.NewSecretCodec("refresh-test-key")
	require.NoError(t, err)
	store := services.NewGitHubAppCredentialStore(pool, codec, services.WithGitHubAppCredentialBudget(budget))
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	require.NoError(t, store.Save(ctx, services.GitHubAppCredentials{ID: 711, Slug: "refresh-test", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}))
	cfg := config.AuthConfig{SessionSecret: "refresh-session", GitHubOAuthBaseURL: upstream.URL}
	_, oauth, err := buildAuthProviders(cfg, store, budget)
	require.NoError(t, err)
	auth := services.NewAuthService(q, cfg, nil, oauth)
	assembled, err := composeGitHubSync(pool, store, auth, topology{}, budget)
	require.NoError(t, err)
	var rechecks atomic.Int32
	auth.Members = &services.Members{Pool: pool, Credentials: store, Minter: assembled.connections}
	main := services.NewGitHubMainPullService(q, nil, nil, nil)
	main.UseInstallPolicy()
	composeGitHubPermissionPolling(auth.Members, assembled.synced, main, func() { rechecks.Add(1) })
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "refresh-user", LowerUsername: "refresh-user"})
	require.NoError(t, err)
	access, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(cfg.SessionSecret), []byte("expired"))
	require.NoError(t, err)
	refresh, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey(cfg.SessionSecret), []byte("refresh"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,access_token_encrypted,refresh_token_encrypted) VALUES($1,'github','71',$2,$3)`, user.ID, access, refresh)
	require.NoError(t, err)
	var retryAt time.Time
	for attempt := range 2 {
		_, err = assembled.userRepositories.ListAuthenticatedUserGitHubRepos(ctx, user.ID, nil)
		var failure *pkgerrors.APIError
		require.ErrorAs(t, err, &failure)
		require.Equal(t, pkgerrors.CodeGitHubRateLimited, failure.Code)
		require.Equal(t, pkgerrors.ClassGitHub, failure.Class)
		require.NotNil(t, failure.RetryAt)
		if attempt == 0 {
			retryAt = *failure.RetryAt
		} else {
			require.WithinDuration(t, retryAt, *failure.RetryAt, time.Second, "local Retry-After is rounded to whole seconds")
		}
	}
	account, err := q.GetOAuthAccountByProviderUserID(ctx, db.GetOAuthAccountByProviderUserIDParams{Provider: "github", ProviderUserID: "71"})
	require.NoError(t, err)
	require.Equal(t, access, account.AccessTokenEncrypted)
	require.Equal(t, refresh, account.RefreshTokenEncrypted)
	require.EqualValues(t, 2, reads.Load())
	require.EqualValues(t, 1, refreshes.Load(), "shared budget blocks the second refresh before HTTP")
	require.EqualValues(t, 2, rechecks.Load(), "each user-token refusal hints the existing permission worker")
	require.NoError(t, auth.Members.PollPermissions(ctx), "missing install qualification keeps execution disabled")
}

func TestGitHubIdentityFailuresThroughComposition(t *testing.T) {
	for _, endpoint := range []string{"profile", "emails"} {
		t.Run(endpoint, func(t *testing.T) {
			for _, failure := range []string{"permission", "unavailable", "limited", "incomplete"} {
				t.Run(failure, func(t *testing.T) {
					pool, _ := postgresfixture.NewProductDatabase(t)
					q := db.New(pool)
					var beforeUsers, beforeAccounts, beforeTokens int
					require.NoError(t, pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM oauth_accounts), (SELECT count(*) FROM access_tokens)`).Scan(&beforeUsers, &beforeAccounts, &beforeTokens))
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						body := `{"id":71,"login":"member"}`
						if r.URL.Path == "/user/emails" {
							body = `[{"email":"member@example.test","verified":true,"primary":true}]`
						}
						if endpoint == "profile" || r.URL.Path == "/user/emails" {
							switch failure {
							case "permission":
								w.WriteHeader(403)
							case "unavailable":
								w.WriteHeader(503)
							case "limited":
								w.Header().Set("Retry-After", "60")
								w.WriteHeader(429)
							case "incomplete":
								w.Header().Set("Content-Length", strconv.Itoa(len(body)+10))
							}
						}
						_, _ = w.Write([]byte(body))
					}))
					defer server.Close()
					cfg := config.AuthConfig{SessionSecret: "identity-fixture", GitHubAPIBaseURL: server.URL}
					_, client, err := buildAuthProviders(cfg, &githubAppOAuthProviderFixture{id: "client", secret: "secret"}, newGitHubBudget(topology{}))
					require.NoError(t, err)
					auth := services.NewAuthService(q, cfg, nil, client)
					_, err = auth.ExchangeGitHubToken(t.Context(), "access", "", "", 0, nil)
					var apiErr *pkgerrors.APIError
					require.ErrorAs(t, err, &apiErr)
					want := pkgerrors.CodeGitHubUnavailable
					if failure == "permission" {
						want = pkgerrors.CodeGitHubPermission
					} else if failure == "limited" {
						want = pkgerrors.CodeGitHubRateLimited
						require.NotNil(t, apiErr.RetryAt)
						require.Equal(t, 60, apiErr.RetryAfter)
					}
					require.Equal(t, want, apiErr.Code)
					require.Equal(t, pkgerrors.ClassGitHub, apiErr.Class)
					var users, accounts, tokens int
					require.NoError(t, pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM oauth_accounts), (SELECT count(*) FROM access_tokens)`).Scan(&users, &accounts, &tokens))
					require.Equal(t, beforeUsers, users)
					require.Equal(t, beforeAccounts, accounts)
					require.Equal(t, beforeTokens, tokens)
				})
			}
		})
	}
}

// Use the same assembly as server startup, real sealed credentials/PostgreSQL,
// and independent HTTP logs. No budget internals or substitute clients are set.
func TestGitHubSharedBudgetComposition(t *testing.T) {
	for _, hosted := range []bool{false, true} {
		name := "install"
		if hosted {
			name = "hosted"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			pool, _ := postgresfixture.NewProductDatabase(t)
			q := db.New(pool)
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			require.NoError(t, err)
			installation := int64(71001)
			if hosted {
				installation++
			}
			credentials := services.GitHubAppCredentials{ID: 710, Slug: "budget-fixture", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "client-secret", WebhookSecret: "webhook-secret", PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})), InstallationID: installation}
			upstream, err := githubfake.New(githubfake.Config{AppID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin, OwnerKind: credentials.OwnerKind, ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, WebhookSecret: credentials.WebhookSecret, PrivateKeyPEM: credentials.PEM, ConversionCode: "code", OAuthCode: "oauth", Installations: []githubfake.Installation{{ID: installation, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}}}})
			require.NoError(t, err)
			t.Cleanup(upstream.Close)
			// Obtain a real fixture user credential, distinct from installation tokens.
			resp, err := http.Post(upstream.URL+"/app-manifests/code/conversions", "application/json", nil)
			require.NoError(t, err)
			require.Equal(t, 201, resp.StatusCode)
			require.NoError(t, resp.Body.Close())
			resp, err = http.PostForm(upstream.URL+"/login/oauth/access_token", url.Values{"code": {"oauth"}, "client_id": {"client"}, "client_secret": {"client-secret"}, "redirect_uri": {"http://localhost/callback"}})
			require.NoError(t, err)
			require.Equal(t, 200, resp.StatusCode)
			var token struct {
				AccessToken string `json:"access_token"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&token))
			require.NoError(t, resp.Body.Close())
			require.NotEmpty(t, token.AccessToken)

			var mode atomic.Int32 // 1 pauses issues, 2 exhausts core, 0 is ordinary headroom.
			var mu sync.Mutex
			var requests []string
			reset := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				requests = append(requests, r.Method+" "+r.URL.Path)
				mu.Unlock()
				w.Header().Set("X-RateLimit-Limit", "100")
				w.Header().Set("X-RateLimit-Remaining", "90")
				w.Header().Set("X-RateLimit-Reset", reset)
				w.Header().Set("X-RateLimit-Resource", "core")
				if mode.Load() == 1 && r.URL.Path == "/repos/acme/app/issues" {
					w.Header().Set("Retry-After", "60")
					w.WriteHeader(403)
					return
				}
				if mode.Load() == 2 {
					w.Header().Set("X-RateLimit-Remaining", "0")
				}
				upstream.Handler().ServeHTTP(w, r)
			}))
			t.Cleanup(server.Close)
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", server.URL)
			count := func() int { mu.Lock(); defer mu.Unlock(); return len(requests) }
			codec, err := webhook.NewSecretCodec("budget-install-key")
			require.NoError(t, err)
			budget := newGitHubBudget(topology{multitenant: hosted})
			store := services.NewGitHubAppCredentialStore(pool, codec, services.WithGitHubAppCredentialBudget(budget))
			require.NoError(t, store.Save(ctx, credentials))
			auth := services.NewAuthService(q, config.AuthConfig{SessionSecret: "session-key"}, nil, nil)
			assembled, err := composeGitHubSync(pool, store, auth, topology{multitenant: hosted}, budget)
			require.NoError(t, err)
			user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "budget-user", LowerUsername: "budget-user"})
			require.NoError(t, err)
			encrypted, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey("session-key"), []byte(token.AccessToken))
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id,access_token_encrypted) VALUES($1,'github','7',$2)`, user.ID, encrypted)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO github_app_installations(installation_id) VALUES($1)`, installation)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO github_app_installation_repositories(installation_id,github_repository_id) VALUES($1,100)`, installation)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO repo_connections(user_id,repo_owner,repo_name,repo_owner_lower,repo_name_lower,license_spdx_id,github_repository_id) VALUES($1,'acme','app','acme','app','MIT',100)`, user.ID)
			require.NoError(t, err)
			list := func() error { _, e := assembled.repositories.ListInstallationRepositories(ctx, user.ID, nil); return e }
			require.NoError(t, list())
			require.NoError(t, list())
			mu.Lock()
			require.Equal(t, []string{fmt.Sprintf("POST /app/installations/%d/access_tokens", installation), "GET /installation/repositories", "GET /installation/repositories"}, requests)
			mu.Unlock()
			if !hosted {
				require.Equal(t, 88, assembled.budget.Status(installation).Remaining)
			}
			row, err := assembled.synced.EnrollGitHubRepo(ctx, services.EnrollGitHubRepoInput{Owner: "acme", Repo: "app", InstallationID: installation, GitHubRepositoryID: 100, MetadataOnly: true})
			require.NoError(t, err)
			if !hosted {
				// Selecting header admission does not enable unqualified install workers.
				workerCtx, cancel := context.WithCancel(ctx)
				done := make(chan struct{})
				go func() { defer close(done); assembled.synced.StartReconciler(workerCtx) }()
				t.Cleanup(func() {
					cancel()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("worker did not stop")
					}
				})
				n := count()
				require.Eventually(t, func() bool {
					current, e := q.GetGitHubSyncedRepoByGitHubID(ctx, row.GithubRepositoryID)
					return e == nil && current.SyncError.Valid
				}, 5*time.Second, 10*time.Millisecond)
				require.Equal(t, n, count(), "missing providers still prohibit worker requests")
				cancel()
				<-done
			}
			fetch := assembled.userRepositories.SyncedRepoConditionalFetcherFactory(assembled.connections)(row)
			query := url.Values{"state": {"all"}, "sort": {"updated"}, "direction": {"desc"}, "per_page": {"50"}, "page": {"1"}}
			first, err := fetch(ctx, "pulls", query, "")
			require.NoError(t, err)
			require.NotEmpty(t, first.ETag)
			before := assembled.budget.Status(installation).Remaining
			same, err := fetch(ctx, "pulls", query, first.ETag)
			require.NoError(t, err)
			require.True(t, same.NotModified)
			if !hosted {
				require.Equal(t, before, assembled.budget.Status(installation).Remaining, "304 must not consume budget")
			}

			mode.Store(1)
			_, err = fetch(ctx, "issues", query, "")
			require.Error(t, err)
			n := count()
			_, err = fetch(ctx, "issues", query, "")
			require.Error(t, err)
			if !hosted {
				require.Equal(t, n, count(), "shared stream pause prevents another HTTP call")
			} else {
				require.Equal(t, n+1, count())
			}
			_, err = fetch(ctx, "pulls", query, "")
			require.NoError(t, err, "one stream's pause must not stop pulls")

			mode.Store(2)
			_, err = fetch(ctx, "pulls", query, "")
			require.NoError(t, err)
			n = count()
			listErr := list()
			_, mintErr := assembled.connections.CreateGitHubInstallationToken(ctx, installation, services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
			if !hosted {
				require.Error(t, listErr)
				require.Error(t, mintErr)
				require.Equal(t, n, count(), "repository-list and token-mint transports share exhausted headroom")
			} else {
				require.NoError(t, listErr)
				require.NoError(t, mintErr)
				require.Equal(t, n+2, count(), "hosted clients retain their policy")
			}

			// The user's credential remains independent from installation headroom,
			// but its list and direct repository readers share their own resource.
			mode.Store(0)
			_, err = assembled.userRepositories.ListAuthenticatedUserGitHubRepos(ctx, user.ID, url.Values{"visibility": {"private"}})
			require.NoError(t, err)
			_, err = assembled.userRepositories.VerifyUserCanPushToGitHubRepo(ctx, user.ID, "acme", "app")
			require.NoError(t, err)
			_, oauth, err := buildAuthProviders(config.AuthConfig{GitHubAPIBaseURL: server.URL}, store, assembled.budget)
			require.NoError(t, err)
			mode.Store(2)
			profile, err := oauth.FetchUser(ctx, token.AccessToken)
			require.NoError(t, err)
			require.EqualValues(t, 7, profile.ID)
			n = count()
			_, err = assembled.userRepositories.VerifyUserCanPushToGitHubRepo(ctx, user.ID, "acme", "app")
			if !hosted {
				require.Error(t, err)
				require.Equal(t, n, count())
			} else {
				require.NoError(t, err)
				require.Equal(t, n+1, count())
			}
			n = count()
			_, err = oauth.FetchEmails(ctx, token.AccessToken)
			if !hosted {
				require.Error(t, err)
				require.Equal(t, n, count(), "profile, email and repository reads share the user's budget")
			} else {
				require.NoError(t, err)
				require.Equal(t, n+1, count())
			}

		})
	}
}

func TestInstallSyncCompositionDoesNotActivatePartialStreamOwners(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	synced := services.NewGitHubSyncedRepoService(q)
	require.NoError(t, synced.ConfigureInstallSync(pool))
	main := services.NewGitHubMainPullService(q, nil, nil, nil)
	main.UseInstallPolicy()
	stack := services.NewMythicalService(pool, nil)
	composeGitHubTodoPolling(stack, main, synced, topology{})
	members := &services.Members{Pool: pool}
	wakes := 0
	composeGitHubPermissionPolling(members, synced, main, func() { wakes++ })
	require.NoError(t, members.PollPermissions(t.Context()), "unqualified permission worker stays disabled")
	require.Error(t, members.RetryStreams(t.Context()))
	require.Zero(t, wakes)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "dark-sync", LowerUsername: "dark-sync"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(t.Context(), db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE repositories SET mirror_destination='acme/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	main.Sweep(t.Context())
	require.Error(t, main.RetrySync(t.Context()))
	require.Error(t, main.PollOnce(t.Context()))
	_, err = main.SyncHealth(t.Context())
	require.Error(t, err)
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM github_main_pulls`).Scan(&count))
	require.Zero(t, count)
}

func TestInstallMainRetryWithMissingCheckReviewOwners(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("polling-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, credentials.Save(t.Context(), services.GitHubAppCredentials{ID: 710, Slug: "polling", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "secret", WebhookSecret: "hook", InstallationID: 91, PEM: string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))}))
	assembled, err := composeGitHubSync(pool, credentials, nil, topology{}, newGitHubBudget(topology{}))
	require.NoError(t, err)
	main := services.NewGitHubMainPullService(q, nil, nil, nil)
	main.UseInstallPolicy()
	stack := services.NewMythicalService(pool, nil)
	composeGitHubTodoPolling(stack, main, assembled.synced, topology{})
	composeGitHubInstallAuthority(assembled.synced, credentials, true)
	_, err = assembled.synced.EnrollGitHubRepo(t.Context(), services.EnrollGitHubRepoInput{Owner: "acme", Repo: "app", InstallationID: 91, GitHubRepositoryID: 100, MetadataOnly: true})
	require.NoError(t, err)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "poll-owner", LowerUsername: "poll-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(t.Context(), db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE repositories SET mirror_destination='acme/app' WHERE id=$1`, repo.ID)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, routerExtras{GitHubSync: main})
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		request := httptest.NewRequest(method, "/api/github/sync", nil)
		request.Header.Set("X-CSRF-Token", "poll-csrf")
		request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "poll-csrf"})
		request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &user, SessionHash: "poll-session"}))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		expected := 200
		if method == http.MethodPost {
			expected = 202
		}
		require.Equal(t, expected, response.Code, response.Body.String())
		if method == http.MethodGet {
			require.Contains(t, response.Body.String(), `"state":"stale"`)
		}
	}
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM github_main_pulls WHERE repository_id=$1 AND requested_generation>synced_generation`, repo.ID).Scan(&count))
	require.Equal(t, 1, count)
	main.Sweep(t.Context())
	require.NoError(t, main.PollOnce(t.Context()), "missing owners cannot reject the independently admitted main worker")
}
