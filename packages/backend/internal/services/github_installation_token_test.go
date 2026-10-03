package services

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// §12.1.3 (T-GH-01): one installation-token minter. Every token names its
// repositories and permissions, and tokens are cached per scope.

func newScopedTokenMinter(t *testing.T) (*RepoConnectionService, *githubfake.Server) {
	t.Helper()
	server, credentials := manifestFixture(t)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	invalidateCachedInstallationToken(91)
	t.Cleanup(func() { invalidateCachedInstallationToken(91) })
	return NewRepoConnectionService(nil, &callerCredentialFixture{credentials: credentials}), server
}

func TestInstallationTokenScopeReachesGitHubVerbatim(t *testing.T) {
	svc, server := newScopedTokenMinter(t)
	token, err := svc.CreateGitHubInstallationToken(context.Background(), 91, GitHubTokenScope{
		RepositoryIDs: []int64{100},
		Permissions:   map[string]string{"contents": "read", "pull_requests": "write"},
	})
	require.NoError(t, err)
	require.EqualValues(t, 91, token.InstallationID)
	writes := server.Writes()
	require.Len(t, writes, 1)
	require.Equal(t, "/app/installations/91/access_tokens", writes[0].Path)
	require.JSONEq(t, `{"repository_ids":[100],"permissions":{"contents":"read","pull_requests":"write"}}`, string(writes[0].Body))
}

func TestInstallationTokenCacheIsPerScope(t *testing.T) {
	svc, server := newScopedTokenMinter(t)
	ctx := context.Background()
	mint := func(scope GitHubTokenScope) string {
		token, err := svc.CreateGitHubInstallationToken(ctx, 91, scope)
		require.NoError(t, err)
		return token.Token
	}
	read := mint(GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
	write := mint(GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "write"}})
	wider := mint(GitHubTokenScope{RepositoryIDs: []int64{101, 100}, Permissions: map[string]string{"contents": "read"}})
	require.NotEqual(t, read, write, "a permission set never reuses another's token")
	require.NotEqual(t, read, wider, "a repository set never reuses another's token")
	require.Equal(t, read, mint(GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}}))
	require.Equal(t, wider, mint(GitHubTokenScope{RepositoryIDs: []int64{100, 101}, Permissions: map[string]string{"contents": "read"}}), "order does not split the cache")
	require.Len(t, server.Writes(), 3)
}

func TestInstallationTokenRefreshesFiveMinutesBeforeExpiry(t *testing.T) {
	svc, server := newScopedTokenMinter(t)
	ctx := context.Background()
	scope := GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"issues": "read"}}
	first, err := svc.CreateGitHubInstallationToken(ctx, 91, scope)
	require.NoError(t, err)
	storeCachedInstallationToken(scope.cacheKey(91), 91, first.Token, time.Now().Add(6*time.Minute))
	again, err := svc.CreateGitHubInstallationToken(ctx, 91, scope)
	require.NoError(t, err)
	require.Equal(t, first.Token, again.Token)
	storeCachedInstallationToken(scope.cacheKey(91), 91, first.Token, time.Now().Add(4*time.Minute))
	refreshed, err := svc.CreateGitHubInstallationToken(ctx, 91, scope)
	require.NoError(t, err)
	require.NotEqual(t, first.Token, refreshed.Token)
	require.Len(t, server.Writes(), 2)
}

func TestInstallationTokenRefusesAnUnscopedRequest(t *testing.T) {
	svc, server := newScopedTokenMinter(t)
	for _, scope := range []GitHubTokenScope{
		{},
		{RepositoryIDs: []int64{100}},
		{Permissions: map[string]string{"contents": "read"}},
		{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}, AllRepositories: true},
		{RepositoryIDs: []int64{0}, Permissions: map[string]string{"contents": "read"}},
		{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents,issues": "read"}},
		{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "admin"}},
	} {
		_, err := svc.CreateGitHubInstallationToken(context.Background(), 91, scope)
		require.ErrorIs(t, err, ErrGitHubTokenScopeRequired)
	}
	require.Empty(t, server.Writes(), "an unscoped request never reaches GitHub")
}

func TestInstallationTokenFailsClosedWithoutLeakingToken(t *testing.T) {
	const secret = "ghs_secret_value_never_logged"
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	for _, body := range []string{
		`{"token":"` + secret + `","expires_at":"not-a-time"}`,
		`{"token":"","expires_at":"2099-01-01T00:00:00Z"}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(body))
		}))
		svc, _ := newScopedTokenMinter(t)
		t.Setenv(envGitHubAppAPIBaseURL, server.URL)
		token, err := svc.CreateGitHubInstallationToken(context.Background(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
		server.Close()
		var typed *pkgerrors.APIError
		require.ErrorAs(t, err, &typed)
		require.Empty(t, token.Token, "no fallback credential")
		require.NotContains(t, err.Error(), secret)
	}
	svc, _ := newScopedTokenMinter(t)
	_, err := svc.CreateGitHubInstallationToken(context.Background(), 999, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
	require.Error(t, err, "an unknown installation fails closed")
	token, err := svc.CreateGitHubInstallationToken(context.Background(), 91, GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"contents": "read"}})
	require.NoError(t, err)
	require.NotContains(t, logs.String(), secret)
	require.NotContains(t, logs.String(), token.Token)
}

// GitHub refuses a token that asks for more than the installation holds, so
// every caller's permission set must fit the App the manifest creates. The
// check-run issuer is the known gap: it needs checks:write and the manifest
// grants checks:read, so check runs fail on self-hosted installs today.
func TestEveryTokenScopeFitsTheManifestGrant(t *testing.T) {
	granted := gitHubAppPermissions()
	merge, err := gitHubProxyMutationPermissions("/repos/a/b/pulls/1/merge")
	require.NoError(t, err)
	require.Equal(t, map[string]string{"contents": "write"}, merge, "GitHub lists the merge endpoint under contents:write only")
	_, err = gitHubProxyMutationPermissions("/repos/a/b/unknown")
	require.Error(t, err, "an unknown mutation gets no token")
	level := map[string]int{"read": 1, "write": 2}
	for name, permissions := range map[string]map[string]string{
		"proxy read": gitHubProxyReadPermissions, "proxy merge": merge, "import": gitHubImportPermissions, "listing": gitHubListingPermissions,
		"text": gitHubIssueTextPermissions, "metadata": gitHubRepoMetadataPermissions, "stack": stackGitHubPermissions,
		"main pull": gitHubMainPullPermissions, "merge": landingGitHubMergePermissions, "push": landingGitHubPushPermissions,
		"pull": landingGitHubPullPermissions, "mythical": mythicalGitHubAPIPermissions,
	} {
		for permission, access := range permissions {
			require.NotZero(t, level[access], "%s asks for %s:%s", name, permission, access)
			require.LessOrEqual(t, level[access], level[granted[permission]], "%s asks for %s:%s", name, permission, access)
		}
	}
}

// #3691 item 1: discovery asks GitHub which installation holds the repository
// with the App JWT and never mints an installation token.
func TestGitHubAppManifestDiscoveryMintsNoInstallationTokenPostgres(t *testing.T) {
	f := newAppManifestFixture(t)
	ctx := WithGitHubAppSetupSession(context.Background(), strings.Repeat("s", 64), "http://localhost:4000")
	_, err := f.service.Convert(ctx, "manifest-code", f.start.State, f.start.State)
	require.NoError(t, err)
	require.NoError(t, f.service.ResumeInstallation(ctx))
	loaded, err := f.store.Load(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 91, loaded.InstallationID)
	for _, write := range f.github.Writes() {
		require.NotContains(t, write.Path, "access_tokens")
	}
}

// testTokenPermissions and testTokenKey reach the cache entry a user-repo mint
// of testRepositoryID fills.
const testRepositoryID = int64(4242)

var testTokenPermissions = map[string]string{"contents": "read"}

func testTokenKey(installationID int64) string {
	return GitHubTokenScope{RepositoryIDs: []int64{testRepositoryID}, Permissions: testTokenPermissions}.cacheKey(installationID)
}
