package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// These are the streams with fetched-state storage and delivery contracts.
// Other streams must join their existing owner loops before activation.
var installMetadataResources = []string{GitHubRepoMetadataIssues, GitHubRepoMetadataPulls, gitHubIssueEvents, gitHubConversationComments}

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
	if resource == GitHubRepoMetadataPulls || resource == gitHubConversationComments {
		return 45 * time.Second
	}
	return 120 * time.Second
}

func metadataBudgetStream(resource string) string {
	if resource == gitHubIssueEvents {
		return "issue-events"
	}
	if resource == gitHubConversationComments {
		return "conversation-comments"
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

// RequiredStreams projects existing repository and per-TODO observations. It
// does not claim to include the separate refs, checks, reviews or permission
// owners; the install's aggregate requires those providers as well.
func (s *GitHubSyncedRepoService) RequiredStreams(ctx context.Context) ([]GitHubSyncStream, error) {
	rows, err := s.readyInstallSyncRows(ctx)
	if err != nil {
		return nil, err
	}
	var streams []GitHubSyncStream
	for _, row := range rows {
		for _, resource := range installMetadataResources {
			streams = append(streams, s.syncStreamObservation(row, resource, metadataBudgetStream(resource)))
		}
		pulls, err := s.install.requiredPulls(ctx, row)
		if err != nil {
			return nil, err
		}
		streams = append(streams, pulls...)
	}
	return streams, nil
}

// RetryStreams schedules the existing readers and returns before HTTP. Fetch
// hints cannot reset cadence, ETags, failed-read backoff or shared admission.
func (s *GitHubSyncedRepoService) RetryStreams(ctx context.Context) error {
	rows, err := s.readyInstallSyncRows(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, row := range rows {
		if err := s.requestInstallFetch(ctx, row.GithubRepositoryID.Int64); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (s *GitHubSyncedRepoService) readyInstallSyncRows(ctx context.Context) ([]db.GithubSyncedRepo, error) {
	if s == nil || s.install == nil || s.install.authorize == nil || !s.hasConditionalFetcher() || s.install.requestPulls == nil || s.install.requiredPulls == nil {
		return nil, githubSyncUnavailable()
	}
	rows, err := s.store.ListGitHubSyncedRepos(ctx, false)
	if err != nil {
		return nil, err
	}
	ready := make([]db.GithubSyncedRepo, 0, len(rows))
	for _, row := range rows {
		if !row.SyncMetadata {
			continue
		}
		if err := s.authorizeFetched(ctx, row); err != nil {
			return nil, err
		}
		ready = append(ready, row)
	}
	if len(ready) == 0 {
		return nil, githubSyncUnavailable()
	}
	return ready, nil
}

func (s *GitHubSyncedRepoService) syncStreamObservation(row db.GithubSyncedRepo, resource, budgetStream string) GitHubSyncStream {
	s.install.mu.Lock()
	state := s.install.streams[syncedStreamKey(row, resource)]
	s.install.mu.Unlock()
	stream := GitHubSyncStream{}
	if !state.lastSuccess.IsZero() {
		at := state.lastSuccess
		stream.LastSuccessAt = &at
	}
	retryAt := s.budget.StreamRetryAt(row.InstallationID.Int64, budgetStream)
	if state.retryAt.After(retryAt) {
		retryAt = state.retryAt
	}
	if retryAt.After(s.now()) {
		stream.RetryAt = &retryAt
	}
	var fault *pkgerrors.APIError
	if errors.As(state.lastError, &fault) {
		switch fault.Code {
		case pkgerrors.CodeGitHubPermission:
			stream.Cause = "permission"
		case pkgerrors.CodeGitHubNotInstalled:
			stream.Cause = "not_installed"
		case pkgerrors.CodeGitHubUnavailable:
			stream.Cause = "unreachable"
		}
	}
	return stream
}

// AuthorizeRefRead shares the install qualification and observed budget with
// the existing main-ref reader before it can mint a token or contact GitHub.
func (s *GitHubSyncedRepoService) AuthorizeRefRead(ctx context.Context, repositoryID int64) error {
	if s == nil || s.install == nil {
		return githubSyncUnavailable()
	}
	owner, repo, err := resolveGitHubDestination(ctx, db.New(s.install.pool), nil, 0, repositoryID, "", "")
	if err != nil {
		return err
	}
	row, err := s.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo})
	if err != nil {
		return err
	}
	if err := s.authorizeFetched(ctx, row); err != nil {
		return err
	}
	pause := s.budget.StreamRetryAt(row.InstallationID.Int64, "refs")
	mintPause := s.budget.StreamRetryAt(row.InstallationID.Int64, fmt.Sprintf("/app/installations/%d/access_tokens", row.InstallationID.Int64))
	if mintPause.After(pause) {
		pause = mintPause
	}
	if pause.After(s.now()) {
		return GitHubRateLimitError(http.StatusTooManyRequests, http.Header{"Retry-After": {pause.UTC().Format(http.TimeFormat)}}, s.now())
	}
	return nil
}
