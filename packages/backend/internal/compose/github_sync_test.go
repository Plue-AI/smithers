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

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

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
			store := services.NewGitHubAppCredentialStore(pool, codec)
			require.NoError(t, store.Save(ctx, credentials))
			auth := services.NewAuthService(q, config.AuthConfig{SessionSecret: "session-key"}, nil, nil)
			assembled, err := composeGitHubSync(pool, store, auth, topology{multitenant: hosted})
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
			mode.Store(2)
			_, err = assembled.userRepositories.ListAuthenticatedUserGitHubRepos(ctx, user.ID, url.Values{"visibility": {"private"}})
			require.NoError(t, err)
			n = count()
			_, err = assembled.userRepositories.VerifyUserCanPushToGitHubRepo(ctx, user.ID, "acme", "app")
			if !hosted {
				require.Error(t, err)
				require.Equal(t, n, count())
			} else {
				require.NoError(t, err)
				require.Equal(t, n+1, count())
			}

		})
	}
}
