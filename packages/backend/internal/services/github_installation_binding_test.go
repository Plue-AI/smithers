package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Owner review pass 3 of #3693: authorization reads the repository id that a
// verified connect persisted, never a name.

type bindingFixture struct {
	pool   *pgxpool.Pool
	server *githubfake.Server
	svc    *RepoConnectionService
}

func newBindingFixture(t *testing.T) bindingFixture {
	t.Helper()
	pool := newProductTestPool(t)
	server, credentials := manifestFixture(t)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	invalidateCachedInstallationToken(91)
	t.Cleanup(func() { invalidateCachedInstallationToken(91) })
	for _, statement := range []string{
		`INSERT INTO github_app_installations(installation_id, account_login, account_type) VALUES (91, 'acme', 'Organization')`,
		`INSERT INTO github_app_installation_repositories(installation_id, github_repository_id, owner_login, owner_login_lower, repo_name, repo_name_lower) VALUES (91, 100, 'acme', 'acme', 'app', 'app')`,
	} {
		_, err := pool.Exec(context.Background(), statement)
		require.NoError(t, err)
	}
	return bindingFixture{pool: pool, server: server, svc: NewRepoConnectionService(pool, &callerCredentialFixture{credentials: credentials})}
}

func (f bindingFixture) user(t *testing.T, name string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `INSERT INTO users(username, lower_username) VALUES ($1, $1) RETURNING id`, name).Scan(&id))
	return id
}

// connection inserts a repo_connections row; repositoryID 0 is a legacy row.
func (f bindingFixture) connection(t *testing.T, userID, repositoryID int64) {
	t.Helper()
	var id any
	if repositoryID > 0 {
		id = repositoryID
	}
	_, err := f.pool.Exec(context.Background(), `INSERT INTO repo_connections(user_id, repo_owner, repo_name, repo_owner_lower, repo_name_lower, license_spdx_id, github_repository_id) VALUES ($1, 'acme', 'app', 'acme', 'app', 'MIT', $2)`, userID, id)
	require.NoError(t, err)
}

// renameAndReplace renames repository 100 and lets newcomer 200 take its name.
func (f bindingFixture) renameAndReplace(t *testing.T) {
	t.Helper()
	for _, statement := range []string{
		`UPDATE github_app_installation_repositories SET repo_name='renamed', repo_name_lower='renamed' WHERE github_repository_id=100`,
		`INSERT INTO github_app_installation_repositories(installation_id, github_repository_id, owner_login, owner_login_lower, repo_name, repo_name_lower) VALUES (91, 200, 'acme', 'acme', 'app', 'app')`,
	} {
		_, err := f.pool.Exec(context.Background(), statement)
		require.NoError(t, err)
	}
}

func requireReconnect(t *testing.T, err error) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, pkgerrors.CodeGitHubReconnectRequired, apiErr.Code)
}

func TestLegacyConnectionWithoutRepositoryIDIsRefusedPostgres(t *testing.T) {
	f := newBindingFixture(t)
	userID := f.user(t, "legacy-owner")
	f.connection(t, userID, 0)
	_, err := f.svc.CreateGitHubInstallationTokenForUserRepo(context.Background(), userID, "acme", "app", map[string]string{"contents": "read"})
	requireReconnect(t, err)
	require.Empty(t, f.server.Writes(), "a legacy row never binds by name")
}

func TestConcurrentMappingChangeMintsOnlyThePersistedIDPostgres(t *testing.T) {
	f := newBindingFixture(t)
	bound, legacy := f.user(t, "bound-owner"), f.user(t, "legacy-owner")
	f.connection(t, bound, 100)
	f.connection(t, legacy, 0)
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i == 8 {
				f.renameAndReplace(t)
			}
			user := bound
			if i%2 == 1 {
				user = legacy
			}
			_, err := f.svc.CreateGitHubInstallationTokenForUserRepo(context.Background(), user, "acme", "app", map[string]string{"contents": "read"})
			if user == legacy {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		requireReconnect(t, err)
	}
	for _, write := range f.server.Writes() {
		require.JSONEq(t, `{"repository_ids":[100],"permissions":{"contents":"read"}}`, string(write.Body))
	}
}

func TestRepoListReturnsOnlyTheConnectionsRepositoryIDsPostgres(t *testing.T) {
	f := newBindingFixture(t)
	userID := f.user(t, "list-owner")
	f.connection(t, userID, 100)
	f.renameAndReplace(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"repositories":[
			{"id":200,"full_name":"acme/app","name":"app","owner":{"login":"acme"}},
			{"id":100,"full_name":"acme/renamed","name":"renamed","owner":{"login":"acme"}}]}`))
	}))
	t.Cleanup(upstream.Close)
	t.Setenv(envGitHubAppAPIBaseURL, upstream.URL)
	result, err := NewGitHubRepoListService(f.pool, repoListZTokenIssuer{}).ListInstallationRepositories(context.Background(), userID, nil)
	require.NoError(t, err)
	require.Len(t, result.Repos, 1)
	require.EqualValues(t, 100, result.Repos[0].ID, "the newcomer under the connected name is never listed")
	require.True(t, strings.EqualFold(result.Repos[0].Name, "renamed"))
}

func TestImportedSourceMintRefusesWritePermissions(t *testing.T) {
	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{queryRowFn: func(context.Context, string, ...any) pgx.Row {
		t.Fatal("a write scope is refused before any lookup")
		return nil
	}})
	_, err := svc.CreateGitHubInstallationTokenForImportedSource(context.Background(), 8, 333, "acme", "app", map[string]string{"contents": "write"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, http.StatusForbidden, apiErr.Status)
}

// fixedPushVerifier stands in for GitHub's push-permission answer, which
// names the repository by id.
type fixedPushVerifier struct{ id int64 }

func (v *fixedPushVerifier) VerifyUserCanPushToGitHubRepo(context.Context, int64, string, string) (int64, error) {
	return v.id, nil
}

func (f bindingFixture) storedRepositoryID(t *testing.T, userID int64) int64 {
	t.Helper()
	var id int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT github_repository_id FROM repo_connections WHERE user_id = $1`, userID).Scan(&id))
	return id
}

func TestConnectCapturesAndReconnectReplacesRepositoryIDPostgres(t *testing.T) {
	f := newBindingFixture(t)
	userID := f.user(t, "connect-owner")
	verifier := &fixedPushVerifier{id: 100}
	f.svc.SetGitHubRepoAccessVerifier(verifier)
	_, err := f.svc.ConnectRepo(context.Background(), userID, "acme", "app", "MIT")
	require.NoError(t, err)
	require.EqualValues(t, 100, f.storedRepositoryID(t, userID))
	verifier.id = 200
	_, err = f.svc.ConnectRepo(context.Background(), userID, "acme", "app", "MIT")
	require.NoError(t, err)
	require.EqualValues(t, 200, f.storedRepositoryID(t, userID), "a reconnect records the newly verified repository")
}

func TestRenameBeforeFirstLookupNeverReachesTheNewcomerPostgres(t *testing.T) {
	f := newBindingFixture(t)
	userID := f.user(t, "rename-owner")
	f.svc.SetGitHubRepoAccessVerifier(&fixedPushVerifier{id: 100})
	_, err := f.svc.ConnectRepo(context.Background(), userID, "acme", "app", "MIT")
	require.NoError(t, err)
	f.renameAndReplace(t)
	_, err = f.svc.CreateGitHubInstallationTokenForUserRepo(context.Background(), userID, "acme", "app", map[string]string{"contents": "read"})
	require.NoError(t, err)
	writes := f.server.Writes()
	require.Len(t, writes, 1)
	require.JSONEq(t, `{"repository_ids":[100],"permissions":{"contents":"read"}}`, string(writes[0].Body), "the token names the connected repository, never the newcomer")
}

// The repair path for a legacy row: status answers instead of failing with a
// 401 (which the CLI treats as a logout), and connect records the id.
func TestLegacyConnectionStatusThenReconnectRepairsPostgres(t *testing.T) {
	f := newBindingFixture(t)
	userID := f.user(t, "repair-owner")
	f.connection(t, userID, 0)
	status, err := f.svc.GetGitHubAppStatus(context.Background(), userID, "acme", "app")
	require.NoError(t, err, "status never answers a legacy row with a 401")
	require.True(t, status.ReconnectRequired)
	require.Zero(t, status.InstallationID)
	f.svc.SetGitHubRepoAccessVerifier(&fixedPushVerifier{id: 100})
	_, err = f.svc.ConnectRepo(context.Background(), userID, "acme", "app", "MIT")
	require.NoError(t, err)
	require.EqualValues(t, 100, f.storedRepositoryID(t, userID))
	status, err = f.svc.GetGitHubAppStatus(context.Background(), userID, "acme", "app")
	require.NoError(t, err)
	require.False(t, status.ReconnectRequired)
	require.EqualValues(t, 91, status.InstallationID)
}
