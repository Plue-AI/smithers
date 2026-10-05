package services

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// These are the streams with fetched-state storage and delivery contracts.
// Other streams must join their existing owner loops before activation.
var installMetadataResources = []string{GitHubRepoMetadataIssues, GitHubRepoMetadataPulls, gitHubIssueEvents}

type gitHubPollState struct {
	updated     time.Time
	cadenceAt   time.Time
	lastSuccess time.Time
	retryAt     time.Time
	lastError   error
}

type gitHubStreamPlan struct {
	resource  string
	scheduled bool
}

func metadataStreamCadence(resource string) time.Duration {
	if resource == GitHubRepoMetadataPulls {
		return 45 * time.Second
	}
	return 120 * time.Second
}

func metadataBudgetStream(resource string) string {
	if resource == gitHubIssueEvents {
		return "issue-events"
	}
	return resource
}

// dueInstallStreams uses memory state, not the hosted registry's adaptive
// interval or webhook heartbeat. A hint does not postpone the next regular poll.
func (s *GitHubSyncedRepoService) dueInstallStreams(row db.GithubSyncedRepo) []gitHubStreamPlan {
	if !row.SyncMetadata || row.SyncState == "disabled" || row.SyncState == "failed" {
		return nil
	}
	now := s.now()
	s.install.mu.Lock()
	defer s.install.mu.Unlock()
	var plans []gitHubStreamPlan
	for _, resource := range installMetadataResources {
		key := syncedStreamKey(row, resource)
		state := s.install.streams[key]
		stream := metadataBudgetStream(resource)
		pause := s.budget.StreamRetryAt(row.InstallationID.Int64, stream)
		if pause.After(now) {
			continue // Leave fetch hints pending until shared admission permits them.
		}
		cadence := s.budget.StreamCadence(row.InstallationID.Int64, stream, metadataStreamCadence(resource))
		scheduled := state.cadenceAt.IsZero() || !now.Before(state.cadenceAt.Add(cadence))
		if scheduled || s.install.requested[key] || (!state.retryAt.IsZero() && !now.Before(state.retryAt)) {
			plans = append(plans, gitHubStreamPlan{resource: resource, scheduled: scheduled})
		}
	}
	return plans
}

// backfillInstallStreams is the existing reconciler's install branch. Each
// stream commits independently, so one refusal does not suppress other reads.
func (s *GitHubSyncedRepoService) backfillInstallStreams(ctx context.Context, row db.GithubSyncedRepo, fetch gitHubSyncedRepoPageFetcher, plans []gitHubStreamPlan) error {
	var runErrors []error
	for _, plan := range plans {
		if err := ctx.Err(); err != nil {
			runErrors = append(runErrors, err)
			break
		}
		key := syncedStreamKey(row, plan.resource)
		stream := metadataBudgetStream(plan.resource)
		if pause := s.budget.StreamRetryAt(row.InstallationID.Int64, stream); pause.After(s.now()) {
			s.install.mu.Lock()
			state := s.install.streams[key]
			state.lastError, state.retryAt = errors.New("GitHub stream is paused"), pause
			s.install.streams[key] = state
			s.install.mu.Unlock()
			continue
		}
		s.install.mu.Lock()
		state := s.install.streams[key]
		if plan.scheduled {
			state.cadenceAt = s.now()
		}
		delete(s.install.requested, key)
		s.install.streams[key] = state
		s.install.mu.Unlock()
		var err error
		if plan.resource == gitHubIssueEvents {
			err = s.backfillIssueEvents(ctx, row, fetch)
		} else {
			err = s.backfillResource(ctx, row, plan.resource, fetch)
		}
		retryAt := s.budget.StreamRetryAt(row.InstallationID.Int64, stream)
		s.install.mu.Lock()
		state = s.install.streams[key]
		state.lastError, state.retryAt = err, time.Time{}
		if err == nil {
			state.lastSuccess = s.now()
		} else if retryAt.After(s.now()) {
			state.retryAt = retryAt
		}
		s.install.streams[key] = state
		s.install.mu.Unlock()
	}
	// A successful fast stream cannot erase an outstanding slower-stream error.
	s.install.mu.Lock()
	for _, resource := range installMetadataResources {
		state := s.install.streams[syncedStreamKey(row, resource)]
		if state.lastError != nil {
			runErrors = append(runErrors, state.lastError)
		} else if state.lastSuccess.IsZero() {
			runErrors = append(runErrors, gitHubFetchUnavailable())
		}
	}
	s.install.mu.Unlock()
	if err := errors.Join(runErrors...); err != nil {
		s.recordSyncError(row.ID, err)
		return err
	}
	markCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	err := pgx.BeginFunc(markCtx, s.install.pool, func(tx pgx.Tx) error {
		current, err := lockFetchedRepo(markCtx, tx, row.ID)
		if err != nil {
			return err
		}
		if current.InstallationID != row.InstallationID || current.GithubRepositoryID != row.GithubRepositoryID || current.OwnerLogin != row.OwnerLogin || current.RepoName != row.RepoName {
			return gitHubFetchUnavailable()
		}
		if err := s.authorizeFetched(markCtx, current); err != nil {
			return err
		}
		return db.New(tx).MarkGitHubSyncedRepoSynced(markCtx, row.ID)
	})
	if err != nil {
		s.recordSyncError(row.ID, err)
	}
	return err
}
