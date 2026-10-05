package services

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// UseInstallGitHubPolling routes the existing per-TODO follow loop through the
// shared cache and durable delivery boundary. A nil/unqualified service refuses
// before resolving credentials. Hosted composition does not select this policy.
func (s *MythicalService) UseInstallGitHubPolling(synced *GitHubSyncedRepoService) {
	s.installGitHubPolling, s.installGitHubSync = true, synced
}

func (s *MythicalService) pullPollEvery() time.Duration {
	if s != nil && s.installGitHubPolling {
		return 45 * time.Second
	}
	return mythicalPullPollEvery
}

func (st *mythicalItemStep) followInstallPull(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, error) {
	synced := st.s.installGitHubSync
	if synced == nil || synced.install == nil || synced.install.authorize == nil || !item.PRNumber.Valid || item.PRNumber.Int64 <= 0 {
		return nil, gitHubFetchUnavailable()
	}
	// Resolve the stored binding only. No legacy Resolve call: it mints write
	// credentials and proves an actor's push access before provider qualification.
	owner, repo, err := resolveGitHubDestination(ctx, st.s.queries(), nil, 0, item.RepositoryID, "", "")
	if err != nil {
		return nil, err
	}
	row, err := synced.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo})
	if err != nil {
		return nil, err
	}
	if err := synced.pollInstallPull(ctx, row, item.PRNumber.Int64); err != nil {
		return nil, err
	}
	next := item
	next.NextAttemptAt = pgtype.Timestamptz{Time: st.now.Add(st.s.pullPollEvery()), Valid: true}
	// The fetched consumer owns PR state, foreign-head and merge effects, with
	// its receipt in one transaction. A successful fetch cannot run the old gate.
	return &next, nil
}
