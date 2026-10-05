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

// Create the budget before auth/setup and reuse it for repository clients.
// Install admission follows response headers; hosted retains its old policy.
func newGitHubBudget(topology topology) *services.BudgetTracker {
	if !topology.hosted() {
		return services.NewGitHubResponseBudgetTracker()
	}
	return services.NewBudgetTracker()
}

// composeGitHubSync assembles the shared credential and budget boundary used
// by repository HTTP services and workers.
func composeGitHubSync(pool *pgxpool.Pool, credentials services.GitHubAppCredentialSource, auth *services.AuthService, topology topology, budget *services.BudgetTracker) (*githubSyncServices, error) {
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

// Bind the existing TODO loop to the same guarded fetched-state service.
func composeGitHubTodoPolling(stack *services.MythicalService, main *services.GitHubMainPullService, synced *services.GitHubSyncedRepoService, topology topology) {
	if !topology.hosted() {
		stack.UseInstallGitHubPolling(synced)
		// Absent stream owners keep aggregate Retry, health and main polling dark.
		main.SetInstallSyncStreams(synced, nil, nil, nil)
	}
}
