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
func composeGitHubSync(pool *pgxpool.Pool, credentials services.GitHubAppCredentialSource, auth *services.AuthService, topology topology, budget *services.BudgetTracker, options ...services.GitHubSyncedRepoOption) (*githubSyncServices, error) {
	connections := services.NewRepoConnectionService(pool, credentials)
	connections.SetGitHubBudgetTracker(budget)
	repositories := services.NewGitHubRepoListService(pool, connections,
		services.WithGitHubRepoListHTTPClient(budget.WrapClient(observability.NewHTTPClient(15*time.Second))))
	synced := services.NewGitHubSyncedRepoService(db.New(pool), append(options, services.WithGitHubSyncedRepoBudget(budget))...)
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
		// The per-TODO follow loop reads and commits checks and reviews too.
		main.SetInstallSyncStreams(synced, synced.PullFactStreams("checks"), synced.PullFactStreams("reviews"), nil)
	}
}

// The existing roster worker supplies permission observations; the TODO
// follow loop supplies checks and reviews from the shared fetched cache.
func composeGitHubPermissionPolling(members *services.Members, synced *services.GitHubSyncedRepoService, main *services.GitHubMainPullService, wake func()) {
	members.UseInstallPermissionPolling(synced, wake)
	main.SetInstallSyncStreams(synced, synced.PullFactStreams("checks"), synced.PullFactStreams("reviews"), members)
}

func composeGitHubInstallAuthority(synced *services.GitHubSyncedRepoService, credentials services.GitHubAppCredentialReader, runtimeReady bool) {
	synced.BindInstallAuthority(credentials, runtimeReady)
}

// Pull, reset and merge dispatch share a repository operation lock.
func composeGitHubMainReset(pool *pgxpool.Pool, stack *services.MythicalService, main *services.GitHubMainPullService, topology topology) {
	if topology.hosted() {
		return
	}
	journal := &services.GitHubMainResetJournal{Pool: pool, Stack: stack}
	main.SetMainSerialization(journal)
}
