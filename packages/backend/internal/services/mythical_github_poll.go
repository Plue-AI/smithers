package services

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// UseInstallGitHubPolling routes the existing per-TODO follow loop through the
// shared cache and durable delivery boundary. A nil/unqualified service refuses
// before resolving credentials. Hosted composition does not select this policy.
func (s *MythicalService) UseInstallGitHubPolling(synced *GitHubSyncedRepoService) {
	s.installGitHubPolling, s.installGitHubSync = true, synced
	s.installPullHints = &mythicalPullHints{pending: make(map[pgtype.UUID]mythicalPullHint), wake: make(chan struct{}, 1)}
	if synced != nil && synced.install != nil {
		synced.install.requestPulls = s.requestInstallPulls
		synced.install.requiredPulls = s.requiredInstallPulls
	}
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
	// This scheduled read also satisfies any hint already waiting for this item.
	// A new hint arriving during the fetch is retained for the next pass.
	st.s.installPullHints.mu.Lock()
	delete(st.s.installPullHints.pending, item.ID)
	st.s.installPullHints.mu.Unlock()
	if err := synced.pollInstallPull(ctx, row, item.PRNumber.Int64); err != nil {
		return nil, err
	}
	next := item
	next.NextAttemptAt = pgtype.Timestamptz{Time: st.now.Add(st.s.pullPollEvery()), Valid: true}
	// The fetched consumer owns PR state, foreign-head and merge effects, with
	// its receipt in one transaction. A successful fetch cannot run the old gate.
	return &next, nil
}

// Hints belong to the existing stack worker. They do not change an item's
// next_attempt_at: an early fetch must not postpone its regular 45-second read.
type mythicalPullHint struct {
	row     db.GithubSyncedRepo
	retryAt time.Time
}
type mythicalPullHints struct {
	mu      sync.Mutex
	pending map[pgtype.UUID]mythicalPullHint
	wake    chan struct{}
}

func (s *MythicalService) requestInstallPulls(ctx context.Context, row db.GithubSyncedRepo) error {
	synced := s.installGitHubSync
	if synced == nil || synced.install == nil || synced.install.authorize == nil {
		return nil // A webhook is acknowledged, but cannot activate a dark provider.
	}
	if err := synced.authorizeFetched(ctx, row); err != nil {
		return err
	}
	ids, err := s.queries().ListRepositoryIDsForGitHubSource(ctx, row.OwnerLogin, row.RepoName)
	if err != nil {
		return err
	}
	for _, id := range ids {
		// The source query nominates candidates, including older import bindings.
		// Only the currently effective destination may wake this repository.
		owner, repo, err := resolveGitHubDestination(ctx, s.queries(), nil, 0, id, "", "")
		if err != nil {
			return err
		}
		if !strings.EqualFold(owner, row.OwnerLogin) || !strings.EqualFold(repo, row.RepoName) {
			continue
		}
		items, err := s.queries().ListMythicalOpenPullItems(ctx, id)
		if err != nil {
			return err
		}
		requested := false
		s.installPullHints.mu.Lock()
		for _, item := range items {
			if mythicalSettledStates[item.State] || !item.PRNumber.Valid || item.PRNumber.Int64 <= 0 {
				continue
			}
			hint := s.installPullHints.pending[item.ID]
			hint.row = row
			s.installPullHints.pending[item.ID] = hint
			requested = true
		}
		s.installPullHints.mu.Unlock()
		if requested {
			if _, err := s.queries().RequestMythicalStack(ctx, id); err != nil {
				return err
			}
			select {
			case s.installPullHints.wake <- struct{}{}:
			default:
			}
		}
	}
	return nil
}

// fetchInstallPullHint runs inside the existing item pass, even when the item's
// normal read is not due yet. It returns the next retry without advancing the
// item's state, running review/merge effects or clearing shared budget pauses.
func (s *MythicalService) fetchInstallPullHint(ctx context.Context, item db.MythicalItem) (time.Time, error) {
	hints := s.installPullHints
	if hints == nil {
		return time.Time{}, nil
	}
	hints.mu.Lock()
	hint, ok := hints.pending[item.ID]
	if !ok {
		hints.mu.Unlock()
		return time.Time{}, nil
	}
	if mythicalSettledStates[item.State] || !item.PRNumber.Valid || item.PRNumber.Int64 <= 0 {
		delete(hints.pending, item.ID)
		hints.mu.Unlock()
		return time.Time{}, nil
	}
	synced := s.installGitHubSync
	pause := synced.budget.StreamRetryAt(hint.row.InstallationID.Int64, "pulls")
	if pause.After(hint.retryAt) {
		hint.retryAt = pause
	}
	if hint.retryAt.After(s.now()) {
		hints.mu.Unlock()
		return hint.retryAt, nil
	}
	delete(hints.pending, item.ID)
	hints.mu.Unlock()
	// Re-resolve after the hint: changing the repository binding cannot disclose
	// another repository's fetched state or populate the old destination's cache.
	owner, repo, err := resolveGitHubDestination(ctx, s.queries(), nil, 0, item.RepositoryID, "", "")
	if err == nil && (!strings.EqualFold(owner, hint.row.OwnerLogin) || !strings.EqualFold(repo, hint.row.RepoName)) {
		return time.Time{}, nil
	}
	if err == nil {
		err = synced.pollInstallPull(ctx, hint.row, item.PRNumber.Int64)
	}
	if err != nil {
		hint.retryAt = mythicalStepFailedDue(err, s.now())
		hints.mu.Lock()
		newer, exists := hints.pending[item.ID]
		if !exists || newer.row.ID == hint.row.ID && newer.row.InstallationID == hint.row.InstallationID {
			hints.pending[item.ID] = hint
		}
		hints.mu.Unlock()
		return hint.retryAt, err
	}
	return time.Time{}, nil
}

// requiredInstallPulls reports the same uncapped per-TODO working set that the
// existing follow loop reads, including a missing observation before first fetch.
func (s *MythicalService) requiredInstallPulls(ctx context.Context, row db.GithubSyncedRepo) ([]GitHubSyncStream, error) {
	ids, err := s.queries().ListRepositoryIDsForGitHubSource(ctx, row.OwnerLogin, row.RepoName)
	if err != nil {
		return nil, err
	}
	var streams []GitHubSyncStream
	for _, id := range ids {
		owner, repo, err := resolveGitHubDestination(ctx, s.queries(), nil, 0, id, "", "")
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(owner, row.OwnerLogin) || !strings.EqualFold(repo, row.RepoName) {
			continue
		}
		items, err := s.queries().ListMythicalOpenPullItems(ctx, id)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			streams = append(streams, s.installGitHubSync.syncStreamObservation(row, "pulls/"+strconv.FormatInt(item.PRNumber.Int64, 10), "pulls"))
		}
	}
	return streams, nil
}
