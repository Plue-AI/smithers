package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
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
var installMetadataResources = []string{GitHubRepoMetadataIssues, GitHubRepoMetadataPulls, gitHubIssueEvents, gitHubConversationComments, gitHubReviewComments}

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
	if resource == GitHubRepoMetadataPulls || resource == gitHubConversationComments || resource == gitHubReviewComments {
		return 45 * time.Second
	}
	return 120 * time.Second
}

func metadataBudgetStream(resource string) string {
	if resource == gitHubIssueEvents {
		return "issue-events"
	}
	if resource == gitHubReviewComments {
		return "review-comments"
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
	for _, resource := range s.installResources() {
		key := syncedStreamKey(row, resource)
		state := s.install.streams[key]
		stream := metadataBudgetStream(resource)
		pause := s.budget.StreamRetryAt(row.InstallationID.Int64, stream)
		if state.retryAt.After(pause) {
			pause = state.retryAt
		}
		if pause.After(now) {
			continue // Leave fetch hints pending until shared admission permits them.
		}
		base := metadataStreamCadence(resource)
		if resource == gitHubIssueEvents && s.install.issueEventsEvery > 0 {
			base = s.install.issueEventsEvery
		}
		cadence := s.budget.StreamCadence(row.InstallationID.Int64, stream, base)
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
		if pause := s.installPollRetryAt(row, plan.resource, stream); pause.After(s.now()) {
			s.install.mu.Lock()
			state := s.install.streams[key]
			if state.lastError == nil {
				state.lastError = errors.New("GitHub stream is paused")
			}
			state.retryAt = pause
			if saveErr := s.persistPollHealth(ctx, row, plan.resource, state); saveErr != nil {
				runErrors = append(runErrors, saveErr)
			}
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
		}
		if retryAt.After(s.now()) {
			state.retryAt = retryAt
		}
		if saveErr := s.persistPollHealth(ctx, row, plan.resource, state); saveErr != nil {
			state.lastSuccess = s.install.streams[key].lastSuccess
			state.lastError = errors.Join(state.lastError, saveErr)
		}
		s.install.streams[key] = state
		s.install.mu.Unlock()
	}
	// A successful fast stream cannot erase an outstanding slower-stream error.
	s.install.mu.Lock()
	for _, resource := range s.installResources() {
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
		for _, resource := range s.installResources() {
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
// Retry retains cadence, ETags and shared admission. Its explicit request
// supersedes a transient per-TODO fetch delay; webhook hints keep that delay.
func (s *GitHubSyncedRepoService) RetryStreams(ctx context.Context) error {
	rows, err := s.readyInstallSyncRows(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, row := range rows {
		if err := s.requestInstallFetchMode(ctx, row.GithubRepositoryID.Int64, true); err != nil {
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
	observation := gitHubSyncObservation(state, s.budget.StreamRetryAt(row.InstallationID.Int64, budgetStream), s.now())
	observation.Background = resource == GitHubRepoMetadataIssues || resource == gitHubIssueEvents
	return observation
}

func gitHubSyncObservation(state gitHubPollState, retryAt, now time.Time) GitHubSyncStream {
	stream := GitHubSyncStream{}
	if !state.lastSuccess.IsZero() {
		at := state.lastSuccess
		stream.LastSuccessAt = &at
	}
	if state.retryAt.After(retryAt) {
		retryAt = state.retryAt
	}
	if retryAt.After(now) {
		stream.RetryAt = &retryAt
	}
	stream.Cause = gitHubSyncFaultCause(state.lastError)
	return stream
}

// A batch can include transient and permission errors. Preserve the strongest
// refusal regardless of member order or contextual wrapping.
func gitHubSyncFaultCause(err error) string {
	if fault, ok := err.(*pkgerrors.APIError); ok {
		switch fault.Code {
		case pkgerrors.CodeGitHubPermission:
			return "permission"
		case pkgerrors.CodeGitHubNotInstalled:
			return "not_installed"
		case pkgerrors.CodeGitHubUnavailable:
			return "unreachable"
		}
	}
	if batch, ok := err.(interface{ Unwrap() []error }); ok {
		cause := ""
		for _, child := range batch.Unwrap() {
			next := gitHubSyncFaultCause(child)
			if next == "not_installed" {
				return next
			}
			if next == "permission" || cause == "" {
				cause = next
			}
		}
		return cause
	}
	if wrapped := errors.Unwrap(err); wrapped != nil {
		return gitHubSyncFaultCause(wrapped)
	}
	return ""
}

// AuthorizeRefRead shares the install qualification and observed budget with
// the existing main-ref reader before it can mint a token or contact GitHub.
func (s *GitHubSyncedRepoService) AuthorizeRefRead(ctx context.Context, repositoryID int64) error {
	_, err := s.authorizeRefSource(ctx, repositoryID)
	return err
}

func (s *GitHubSyncedRepoService) authorizeRefSource(ctx context.Context, repositoryID int64) (db.GithubSyncedRepo, error) {
	if s == nil || s.install == nil {
		return db.GithubSyncedRepo{}, githubSyncUnavailable()
	}
	owner, repo, err := resolveGitHubDestination(ctx, db.New(s.install.pool), nil, 0, repositoryID, "", "")
	if err != nil {
		return db.GithubSyncedRepo{}, err
	}
	row, err := s.store.GetGitHubSyncedRepo(ctx, db.GetGitHubSyncedRepoParams{OwnerLogin: owner, RepoName: repo})
	if err != nil {
		return db.GithubSyncedRepo{}, err
	}
	if err := s.authorizeFetched(ctx, row); err != nil {
		return db.GithubSyncedRepo{}, err
	}
	pause := s.budget.StreamRetryAt(row.InstallationID.Int64, "refs")
	mintPause := s.budget.StreamRetryAt(row.InstallationID.Int64, gitHubInstallationTokenPath(row.InstallationID.Int64))
	if mintPause.After(pause) {
		pause = mintPause
	}
	if pause.After(s.now()) {
		return db.GithubSyncedRepo{}, GitHubRateLimitError(http.StatusTooManyRequests, http.Header{"Retry-After": {pause.UTC().Format(http.TimeFormat)}}, s.now())
	}
	return row, nil
}

func (s *GitHubSyncedRepoService) installResources() []string {
	if s.install != nil && s.install.pullFacts {
		return installMetadataResources
	}
	return installMetadataResources[:len(installMetadataResources)-1]
}

// Keep stream health inputs in the same install settings store that already
// owns permission health. Identity includes the installation and repository,
// so an old enrollment can never lend its receipt to a rebound repository.
type gitHubPollReceipt struct {
	Registry     int64     `json:"registry"`
	Installation int64     `json:"installation"`
	Repository   int64     `json:"repository"`
	Owner        string    `json:"owner"`
	Repo         string    `json:"repo"`
	Resource     string    `json:"resource"`
	Success      time.Time `json:"success"`
	Retry        time.Time `json:"retry"`
	Cause        string    `json:"cause"`
}

func (s *GitHubSyncedRepoService) persistPollHealth(ctx context.Context, row db.GithubSyncedRepo, resource string, state gitHubPollState) error {
	receipt := gitHubPollReceipt{row.ID, row.InstallationID.Int64, row.GithubRepositoryID.Int64, row.OwnerLogin, row.RepoName, resource, state.lastSuccess, state.retryAt, gitHubSyncFaultCause(state.lastError)}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	identity := fmt.Sprintf("%d/%d/%d/%s/%s/%s", receipt.Registry, receipt.Installation, receipt.Repository, receipt.Owner, receipt.Repo, resource)
	key := fmt.Sprintf("github.stream.health.%x", sha256.Sum256([]byte(identity)))
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	result, err := s.install.pool.Exec(saveCtx, `INSERT INTO install_settings(key,value)
 SELECT $1,$2::jsonb WHERE EXISTS (SELECT 1 FROM github_synced_repos WHERE id=$3 AND installation_id=$4 AND github_repository_id=$5 AND owner_login=$6 AND repo_name=$7 AND sync_state NOT IN ('disabled','failed'))
 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`, key, raw, row.ID, row.InstallationID.Int64, row.GithubRepositoryID.Int64, row.OwnerLogin, row.RepoName)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return gitHubFetchUnavailable()
	}
	return nil
}

func (s *GitHubSyncedRepoService) restorePollHealth() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := s.install.pool.Query(ctx, `SELECT s.value FROM install_settings s JOIN github_synced_repos r
 ON r.id=(s.value->>'registry')::bigint AND r.installation_id=(s.value->>'installation')::bigint AND r.github_repository_id=(s.value->>'repository')::bigint AND r.owner_login=s.value->>'owner' AND r.repo_name=s.value->>'repo'
 WHERE s.key LIKE 'github.stream.health.%' AND r.sync_state NOT IN ('disabled','failed')`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		var receipt gitHubPollReceipt
		if err := json.Unmarshal(raw, &receipt); err != nil {
			return err
		}
		state := gitHubPollState{lastSuccess: receipt.Success, retryAt: receipt.Retry}
		switch receipt.Cause {
		case "permission":
			state.lastError = pkgerrors.New(pkgerrors.CodeGitHubPermission, "GitHub permission missing")
		case "not_installed":
			state.lastError = pkgerrors.New(pkgerrors.CodeGitHubNotInstalled, "GitHub App is not installed")
		case "unreachable":
			state.lastError = pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "GitHub is unavailable")
		}
		key := gitHubStreamKey{receipt.Registry, receipt.Installation, receipt.Repository, receipt.Owner, receipt.Repo, receipt.Resource}
		s.install.streams[key] = state
	}
	return rows.Err()
}

func (s *GitHubSyncedRepoService) installPollRetryAt(row db.GithubSyncedRepo, resource, budgetStream string) time.Time {
	pause := s.budget.StreamRetryAt(row.InstallationID.Int64, budgetStream)
	s.install.mu.Lock()
	stored := s.install.streams[syncedStreamKey(row, resource)].retryAt
	s.install.mu.Unlock()
	if stored.After(pause) {
		return stored
	}
	return pause
}
