package compose

import (
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type githubSyncServices struct {
	budget           *services.BudgetTracker
	connections      *services.RepoConnectionService
	repositories     *services.GitHubRepoListService
	userRepositories *services.GitHubUserReposService
	synced           *services.GitHubSyncedRepoService
}

// composeGitHubSync assembles the shared credential and budget boundary used by
// both HTTP services and workers. Install admission follows GitHub's response
// headers; hosted deployments retain their existing token-bucket policy.
func composeGitHubSync(pool *pgxpool.Pool, credentials services.GitHubAppCredentialSource, auth *services.AuthService, topology topology) (*githubSyncServices, error) {
	budget := services.NewBudgetTracker()
	if !topology.hosted() {
		budget = services.NewGitHubResponseBudgetTracker()
	}
	connections := services.NewRepoConnectionService(pool, credentials)
	connections.SetGitHubBudgetTracker(budget)
	repositories := services.NewGitHubRepoListService(pool, connections,
		services.WithGitHubRepoListHTTPClient(budget.WrapClient(observability.NewHTTPClient(15*time.Second))))
	synced := services.NewGitHubSyncedRepoService(db.New(pool), services.WithGitHubSyncedRepoBudget(budget))
	if !topology.hosted() {
		if err := synced.ConfigureInstallSync(pool); err != nil {
			return nil, err
		}
	}
	userRepositories := services.NewGitHubUserReposService(db.New(pool), auth,
		services.WithGitHubUserReposTokenRefresher(auth),
		services.WithGitHubUserReposHTTPClient(budget.WrapClient(observability.NewHTTPClient(15*time.Second))),
		services.WithGitHubUserReposCredentialStore(credentials),
		services.WithGitHubUserReposSyncedStore(synced))
	connections.SetGitHubRepoAccessVerifier(userRepositories)
	synced.SetPushAccess(userRepositories)
	if topology.hosted() {
		synced.SetFetcherFactory(userRepositories.SyncedRepoInstallationFetcherFactory(connections))
	} else {
		synced.SetConditionalFetcherFactory(userRepositories.SyncedRepoConditionalFetcherFactory(connections))
	}
	return &githubSyncServices{budget, connections, repositories, userRepositories, synced}, nil
}
