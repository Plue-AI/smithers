package services

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type callerCredentialFixture struct {
	credentials GitHubAppCredentials
	err         error
	jwtCalls    int
}

func (f *callerCredentialFixture) Load(context.Context) (GitHubAppCredentials, error) {
	return f.credentials, f.err
}
func (f *callerCredentialFixture) InstallURL(ctx context.Context) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return "https://github.com/apps/" + f.credentials.Slug + "/installations/new", nil
}
func (f *callerCredentialFixture) AppJWT(ctx context.Context) (string, error) {
	f.jwtCalls++
	if f.err != nil {
		return "", f.err
	}
	key, err := parseGitHubAppPrivateKey(f.credentials.PEM)
	if err != nil {
		return "", err
	}
	return createGitHubAppJWTFunc(f.credentials.ID, key, time.Now().UTC())
}

func TestGitHubAppStatusUsesStoredSlugAndPropagatesStoreFailure(t *testing.T) {
	fixture := &callerCredentialFixture{credentials: GitHubAppCredentials{ID: 42, Slug: "team-install", OwnerLogin: "team", OwnerKind: "org"}}
	service := NewRepoConnectionService(notConfiguredStatusDB(), fixture)
	status, err := service.GetGitHubAppStatus(context.Background(), 7, "team", "repo")
	require.NoError(t, err)
	require.True(t, status.GitHubAppConfigured)
	require.Equal(t, "https://github.com/apps/team-install/installations/new", status.InstallURL)
	fixture.err = errors.New("cannot unseal credentials")
	_, err = service.GetGitHubAppStatus(context.Background(), 7, "team", "repo")
	require.Error(t, err)
}

var testCallerCredentialStores sync.Map

const testCallerInstallURL = "https://github.com/apps/team-install/installations/new"
const testCallerPermissionsURL = "https://github.com/organizations/team/settings/apps/team-install/permissions"

func testCallerCredentials(t *testing.T) *callerCredentialFixture {
	t.Helper()
	if value, ok := testCallerCredentialStores.Load(t); ok {
		return value.(*callerCredentialFixture)
	}
	fixture := &callerCredentialFixture{credentials: GitHubAppCredentials{Slug: "team-install", OwnerLogin: "team", OwnerKind: "org"}, err: ErrGitHubAppNotConfigured}
	testCallerCredentialStores.Store(t, fixture)
	t.Cleanup(func() { testCallerCredentialStores.Delete(t) })
	return fixture
}
func setTestCallerCredentials(t *testing.T, field, value string) {
	fixture := testCallerCredentials(t)
	if field == "ID" {
		fixture.credentials.ID, _ = strconv.ParseInt(value, 10, 64)
	} else {
		fixture.credentials.PEM = value
	}
	fixture.err = nil
	if fixture.credentials.ID <= 0 || fixture.credentials.PEM == "" {
		fixture.err = ErrGitHubAppNotConfigured
	}
}
func newTestRepoConnectionService(t *testing.T, db RepoConnectionDB) *RepoConnectionService {
	return NewRepoConnectionService(db, testCallerCredentials(t))
}
func newTestGitHubUserReposService(t *testing.T, queries GitHubUserReposDB, decrypter OAuthAccessTokenDecrypter, opts ...GitHubUserReposOption) *GitHubUserReposService {
	return NewGitHubUserReposService(queries, decrypter, append(opts, WithGitHubUserReposCredentialStore(testCallerCredentials(t)))...)
}
func newTestStackService(t *testing.T, queries StackQuerier, opts ...StackServiceOption) *StackService {
	return NewStackService(queries, append(opts, WithStackGitHubAppCredentialStore(testCallerCredentials(t)))...)
}
func newTestStackGitHubInstallationToken(t *testing.T, ctx context.Context, id int64) (string, error) {
	return createStackGitHubInstallationToken(ctx, id, testCallerCredentials(t))
}

func TestStoredGitHubAppPermissionsURLUsesAppOwner(t *testing.T) {
	for _, test := range []struct{ kind, owner, want string }{
		{"org", "team", "https://github.com/organizations/team/settings/apps/team-install/permissions"},
		{"user", "owner", "https://github.com/settings/apps/team-install/permissions"},
	} {
		t.Run(test.kind, func(t *testing.T) {
			require.Equal(t, test.want, githubAppPermissionsURL(GitHubAppCredentials{Slug: "team-install", OwnerLogin: test.owner, OwnerKind: test.kind}))
		})
	}
}
func TestLegacyAppEnvironmentCannotConfigureStatus(t *testing.T) {
	t.Setenv("SMITHERS_GITHUB_APP_ID", "42")
	t.Setenv("SMITHERS_GITHUB_APP_PRIVATE_KEY", testGitHubAppPrivateKeyPEM(t))
	t.Setenv("SMITHERS_GITHUB_APP_INSTALL_URL", "https://github.com/apps/legacy/installations/new")
	service := NewRepoConnectionService(notConfiguredStatusDB())
	status, err := service.GetGitHubAppStatus(context.Background(), 7, "team", "repo")
	require.NoError(t, err)
	require.False(t, status.GitHubAppConfigured)
	require.Empty(t, status.InstallURL)
}

func TestStoredCredentialsGateCachedInstallationTokens(t *testing.T) {
	const id = int64(991239)
	storeCachedInstallationToken(id, "cached-token", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(id) })
	fixture := &callerCredentialFixture{err: errors.New("cannot unseal credentials")}
	repoService := NewRepoConnectionService(notConfiguredStatusDB(), fixture)
	_, err := repoService.CreateGitHubInstallationTokenForInternalInstallation(context.Background(), id)
	require.Error(t, err, "cached tokens must not bypass a broken credential store")
	_, err = createStackGitHubInstallationToken(context.Background(), id, fixture)
	require.Error(t, err, "stack token cache must not bypass a broken credential store")
}
