package services

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

func TestGitHubBudgetAppPrincipalRotationIsolationAndExpiry(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	budget := NewGitHubResponseBudgetTracker()
	budget.now = func() time.Time { return now }
	var calls atomic.Int32
	var exhausted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "90")
		w.Header().Set("X-RateLimit-Reset", "2000")
		if exhausted.Load() {
			w.Header().Set("X-RateLimit-Remaining", "0")
			return
		}
		if r.URL.Path == "/app/installations" {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(429)
		}
	}))
	defer server.Close()
	client := budget.WrapClient(server.Client())
	send := func(path, token string) int {
		t.Helper()
		req, err := http.NewRequest("GET", server.URL+path, nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		require.NoError(t, err)
		require.NoError(t, resp.Body.Close())
		return resp.StatusCode
	}
	budget.registerAppToken("old-app-jwt", 42, time.Unix(1020, 0))
	require.Equal(t, 429, send("/app/installations", "old-app-jwt"))
	budget.registerAppToken("new-app-jwt", 42, time.Unix(1100, 0))
	require.Equal(t, 429, send("/app/installations", "new-app-jwt"))
	require.EqualValues(t, 1, calls.Load(), "rotation retains the App stream pause")
	require.Equal(t, 200, send("/repos/acme/app/installation", "new-app-jwt"), "other streams remain eligible")
	budget.registerAppToken("other-app-jwt", 43, time.Unix(1100, 0))
	require.Equal(t, 429, send("/app/installations", "other-app-jwt"))
	require.EqualValues(t, 3, calls.Load(), "another App has separate stream admission")
	exhausted.Store(true)
	require.Equal(t, 200, send("/repos/acme/app/installation", "new-app-jwt"))
	budget.registerAppToken("latest-app-jwt", 42, time.Unix(1150, 0))
	require.Equal(t, 429, send("/repos/acme/other/installation", "latest-app-jwt"))
	require.EqualValues(t, 4, calls.Load(), "resource exhaustion survives rotation across streams")
	budget.registerToken("installation-token", 42, time.Unix(1150, 0))
	require.Equal(t, 200, send("/repos/acme/other/installation", "installation-token"))
	require.Equal(t, 200, send("/repos/acme/other/installation", "unregistered-credential"))
	require.EqualValues(t, 6, calls.Load(), "App, installation and unregistered credentials never borrow identities")
	now = time.Unix(1020, 0).UTC()
	budget.registerAppToken("fresh-app-jwt", 42, time.Unix(1200, 0))
	budget.mu.Lock()
	_, oldExists := budget.tokenPrincipals[sha256.Sum256([]byte("Bearer old-app-jwt"))]
	budget.mu.Unlock()
	require.False(t, oldExists, "expired credential registrations are discarded")
	require.Equal(t, 429, send("/repos/acme/other/installation", "fresh-app-jwt"))
	require.EqualValues(t, 6, calls.Load(), "registration cleanup preserves resource history")
	now = time.Unix(2000, 0).UTC()
	budget.registerAppToken("after-reset", 42, time.Unix(2600, 0))
	exhausted.Store(false)
	require.Equal(t, 200, send("/repos/acme/other/installation", "after-reset"))
	require.EqualValues(t, 7, calls.Load())
}

// Real signed JWTs from one sealed store cross the user-repository, roster,
// setup-discovery and installation-reconcile clients. No client registers a
// principal based on parsing an incoming credential.
func TestGitHubBudgetSignedAppRotationSharesDiscoveryCallers(t *testing.T) {
	invalidateCachedInstallationToken(91)
	t.Cleanup(func() { invalidateCachedInstallationToken(91) })
	pool := newGitHubAppTestPool(t)
	upstream, credentials := manifestFixture(t)
	budget := NewGitHubResponseBudgetTracker()
	codec, err := webhook.NewSecretCodec("app-budget-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec, WithGitHubAppCredentialBudget(budget))
	require.NoError(t, store.Save(context.Background(), credentials))
	var calls atomic.Int32
	var mu sync.Mutex
	var observed string
	reset := time.Now().Add(time.Hour).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		mu.Lock()
		observed = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		mu.Unlock()
		w.Header().Set("X-RateLimit-Limit", "100")
		w.Header().Set("X-RateLimit-Remaining", "0")
		// Unix seconds, fixed across all calls in this fixture.
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset, 10))
		upstream.Handler().ServeHTTP(w, r)
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	client := NewGitHubUserReposService(db.New(pool), nil, WithGitHubUserReposCredentialStore(store), WithGitHubUserReposHTTPClient(budget.WrapClient(server.Client())))
	ctx := context.Background()
	installation, found, err := client.lookupRepoInstallation(ctx, "acme", "app")
	require.NoError(t, err)
	require.True(t, found)
	require.EqualValues(t, 91, installation.ID)
	mu.Lock()
	first := observed
	mu.Unlock()
	require.Eventually(t, func() bool { next, e := store.AppJWT(ctx); return e == nil && next != first }, 2*time.Second, 20*time.Millisecond, "the sealed source must produce a genuinely renewed JWT")
	_, _, err = client.lookupRepoInstallation(ctx, "acme", "app")
	require.Error(t, err)
	connection := NewRepoConnectionService(pool, store)
	connection.SetGitHubBudgetTracker(budget)
	members := &Members{Pool: pool, Credentials: store, Minter: connection, Budget: budget}
	_, err = members.installationAccess(ctx, memberRepository{Owner: "acme", Name: "app", ID: 1})
	require.Error(t, err)
	require.Error(t, connection.ReconcileGitHubAppInstallations(ctx))
	require.NoError(t, db.New(pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"acme","owner_kind":"org","repository_name":"app"}`)}))
	setup := NewGitHubAppManifestService(pool, store, server.URL, nil, WithGitHubAppManifestBudget(budget))
	require.Error(t, setup.ResumeInstallation(ctx))
	require.EqualValues(t, 1, calls.Load(), "all discovery clients retain the signed App's exhausted budget")
	// Installation-token minting remains a separate budget principal.
	_, err = connection.CreateGitHubInstallationToken(ctx, 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"metadata": "read"}})
	require.NoError(t, err)
	require.EqualValues(t, 2, calls.Load())
}
