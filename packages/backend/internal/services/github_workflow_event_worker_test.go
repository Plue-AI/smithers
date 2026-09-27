package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockGitHubWebhookEventWorkerQuerier struct {
	claimPendingGitHubWebhookJobsFn        func(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error)
	markGitHubWebhookJobDoneFn             func(ctx context.Context, arg db.MarkGitHubWebhookJobDoneParams) (int64, error)
	markGitHubWebhookJobFailedFn           func(ctx context.Context, arg db.MarkGitHubWebhookJobFailedParams) (int64, error)
	retryGitHubWebhookJobFn                func(ctx context.Context, arg db.RetryGitHubWebhookJobParams) (int64, error)
	resetStalledGitHubWebhookJobsFn        func(ctx context.Context, olderThanSeconds float64) (int64, error)
	listRepositoryIDsForGitHubWebhookJobFn func(ctx context.Context, arg db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error)
	listWorkflowTriggersByRepositoryFn     func(ctx context.Context, repositoryID int64) ([]db.WorkflowTrigger, error)
	claimDueWorkflowScheduleSpecsFn        func(ctx context.Context, claimLimit int32) ([]db.WorkflowScheduleSpec, error)
	updateWorkflowScheduleFireTimesFn      func(ctx context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error

	markDoneIDs   []int64
	markDone      []db.MarkGitHubWebhookJobDoneParams
	markFailed    []db.MarkGitHubWebhookJobFailedParams
	retried       []db.RetryGitHubWebhookJobParams
	stalledResets []float64
	repoSelectors []db.ListRepositoryIDsForGitHubWebhookJobParams
	fireTimes     []db.UpdateWorkflowScheduleFireTimesParams
}

func (m *mockGitHubWebhookEventWorkerQuerier) ClaimPendingGitHubWebhookJobs(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error) {
	if m.claimPendingGitHubWebhookJobsFn != nil {
		return m.claimPendingGitHubWebhookJobsFn(ctx, claimLimit)
	}
	return nil, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) MarkGitHubWebhookJobDone(ctx context.Context, arg db.MarkGitHubWebhookJobDoneParams) (int64, error) {
	m.markDoneIDs = append(m.markDoneIDs, arg.ID)
	m.markDone = append(m.markDone, arg)
	if m.markGitHubWebhookJobDoneFn != nil {
		return m.markGitHubWebhookJobDoneFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) MarkGitHubWebhookJobFailed(ctx context.Context, arg db.MarkGitHubWebhookJobFailedParams) (int64, error) {
	m.markFailed = append(m.markFailed, arg)
	if m.markGitHubWebhookJobFailedFn != nil {
		return m.markGitHubWebhookJobFailedFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) RetryGitHubWebhookJob(ctx context.Context, arg db.RetryGitHubWebhookJobParams) (int64, error) {
	m.retried = append(m.retried, arg)
	if m.retryGitHubWebhookJobFn != nil {
		return m.retryGitHubWebhookJobFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) ResetStalledGitHubWebhookJobs(ctx context.Context, olderThanSeconds float64) (int64, error) {
	m.stalledResets = append(m.stalledResets, olderThanSeconds)
	if m.resetStalledGitHubWebhookJobsFn != nil {
		return m.resetStalledGitHubWebhookJobsFn(ctx, olderThanSeconds)
	}
	return 0, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) ListRepositoryIDsForGitHubWebhookJob(ctx context.Context, arg db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
	m.repoSelectors = append(m.repoSelectors, arg)
	if m.listRepositoryIDsForGitHubWebhookJobFn != nil {
		return m.listRepositoryIDsForGitHubWebhookJobFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) ListWorkflowTriggersByRepository(ctx context.Context, repositoryID int64) ([]db.WorkflowTrigger, error) {
	if m.listWorkflowTriggersByRepositoryFn != nil {
		return m.listWorkflowTriggersByRepositoryFn(ctx, repositoryID)
	}
	return nil, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) ClaimDueWorkflowScheduleSpecs(ctx context.Context, claimLimit int32) ([]db.WorkflowScheduleSpec, error) {
	if m.claimDueWorkflowScheduleSpecsFn != nil {
		return m.claimDueWorkflowScheduleSpecsFn(ctx, claimLimit)
	}
	return nil, nil
}

func (m *mockGitHubWebhookEventWorkerQuerier) UpdateWorkflowScheduleFireTimes(ctx context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error {
	m.fireTimes = append(m.fireTimes, arg)
	if m.updateWorkflowScheduleFireTimesFn != nil {
		return m.updateWorkflowScheduleFireTimesFn(ctx, arg)
	}
	return nil
}

type mockGitHubWebhookEventRunDispatcher struct {
	dispatchForEventFn func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	calls              []DispatchForEventInput
}

func (m *mockGitHubWebhookEventRunDispatcher) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.calls = append(m.calls, input)
	if m.dispatchForEventFn != nil {
		return m.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}

func TestGitHubWebhookEventWorker_PollOnce_NoJobs(t *testing.T) {
	t.Parallel()

	queries := &mockGitHubWebhookEventWorkerQuerier{}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, queries.markDoneIDs)
	assert.Empty(t, queries.markFailed)
	assert.Empty(t, dispatcher.calls)
}

func TestGitHubWebhookEventWorker_PollOnce_DispatchesMatchingWorkflows(t *testing.T) {
	t.Parallel()

	payload := json.RawMessage(`{
		"action": "opened",
		"installation": {"id": 777},
		"repository": {"id": 9001, "name": "demo", "owner": {"login": "Acme"}},
		"pull_request": {"head": {"ref": "feature/test", "sha": "abc123"}}
	}`)

	queries := &mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error) {
			assert.Equal(t, defaultGitHubWebhookEventWorkerClaimLimit, claimLimit)
			return []db.GithubWebhookJob{{
				ID:                 1,
				EventType:          "pull_request",
				InstallationID:     pgtype.Int8{Int64: 777, Valid: true},
				GithubRepositoryID: pgtype.Int8{Int64: 9001, Valid: true},
				Payload:            payload,
			}}, nil
		},
		listRepositoryIDsForGitHubWebhookJobFn: func(ctx context.Context, arg db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
			assert.Equal(t, int64(777), arg.InstallationID)
			assert.Equal(t, int64(9001), arg.GitHubRepositoryID)
			assert.Equal(t, "acme", arg.OwnerLoginLower)
			assert.Equal(t, "demo", arg.RepoNameLower)
			return []int64{42}, nil
		},
		listWorkflowTriggersByRepositoryFn: func(ctx context.Context, repositoryID int64) ([]db.WorkflowTrigger, error) {
			assert.Equal(t, int64(42), repositoryID)
			return []db.WorkflowTrigger{
				{WorkflowDefinitionID: 10, EventType: "pull_request", EventAction: "opened", Enabled: true},
				{WorkflowDefinitionID: 11, EventType: "pull_request", EventAction: "synchronize", Enabled: true},
				{WorkflowDefinitionID: 12, EventType: "check_run", EventAction: "", Enabled: true},
			}, nil
		},
	}

	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, int64(42), dispatcher.calls[0].RepositoryID)
	if assert.NotNil(t, dispatcher.calls[0].WorkflowDefinitionID) {
		assert.Equal(t, int64(10), *dispatcher.calls[0].WorkflowDefinitionID)
	}
	assert.Equal(t, "pull_request", dispatcher.calls[0].Event.Type)
	assert.Equal(t, "opened", dispatcher.calls[0].Event.Action)
	assert.Equal(t, "feature/test", dispatcher.calls[0].Event.Ref)
	assert.Equal(t, "abc123", dispatcher.calls[0].Event.CommitSHA)
	assert.Equal(t, []int64{1}, queries.markDoneIDs)
	assert.Empty(t, queries.markFailed)
}

func TestGitHubWebhookEventWorker_PollOnce_UnsupportedActionMarkedDone(t *testing.T) {
	t.Parallel()

	queries := &mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error) {
			return []db.GithubWebhookJob{{
				ID:        2,
				EventType: "pull_request",
				Action:    "closed",
				Payload:   json.RawMessage(`{"action":"closed"}`),
			}}, nil
		},
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Equal(t, []int64{2}, queries.markDoneIDs)
	assert.Empty(t, queries.markFailed)
	assert.Empty(t, dispatcher.calls)
}

func pushJobQuerier(job db.GithubWebhookJob) *mockGitHubWebhookEventWorkerQuerier {
	return &mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error) {
			return []db.GithubWebhookJob{job}, nil
		},
		listRepositoryIDsForGitHubWebhookJobFn: func(ctx context.Context, arg db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error) {
			return []int64{100}, nil
		},
		listWorkflowTriggersByRepositoryFn: func(ctx context.Context, repositoryID int64) ([]db.WorkflowTrigger, error) {
			return []db.WorkflowTrigger{{WorkflowDefinitionID: 44, EventType: "push", Enabled: true}}, nil
		},
	}
}

func pushJob(id int64, attempts int32) db.GithubWebhookJob {
	return db.GithubWebhookJob{
		ID:        id,
		EventType: "push",
		Attempts:  attempts,
		InstallationID: pgtype.Int8{
			Int64: 777,
			Valid: true,
		},
		Payload: json.RawMessage(`{
			"ref":"refs/heads/main",
			"after":"abc",
			"installation":{"id":777},
			"repository":{"name":"demo","owner":{"login":"acme"}}
		}`),
	}
}

func TestGitHubWebhookEventWorker_PollOnce_DispatchFailureRetriesWithBackoff(t *testing.T) {
	t.Parallel()

	queries := pushJobQuerier(pushJob(3, 1))
	dispatcher := &mockGitHubWebhookEventRunDispatcher{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, errors.New("boom")
		},
	}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, queries.markDoneIDs)
	assert.Empty(t, queries.markFailed)
	require.Len(t, queries.retried, 1)
	assert.Equal(t, int64(3), queries.retried[0].ID)
	assert.Equal(t, int32(1), queries.retried[0].ExpectedAttempts)
	assert.Contains(t, queries.retried[0].Error, "boom")
	assert.Equal(t, gitHubWebhookJobRetryBaseBackoff.Seconds(), queries.retried[0].BackoffSeconds)
	require.Len(t, queries.stalledResets, 1)
	assert.Equal(t, gitHubWebhookJobStalledAfter.Seconds(), queries.stalledResets[0])
}

func TestGitHubWebhookEventWorker_PollOnce_LostClaimWritesAreFencedAndNotReported(t *testing.T) {
	t.Parallel()

	queries := pushJobQuerier(pushJob(6, 2))
	queries.retryGitHubWebhookJobFn = func(context.Context, db.RetryGitHubWebhookJobParams) (int64, error) { return 0, nil }
	dispatcher := &mockGitHubWebhookEventRunDispatcher{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, errors.New("boom")
		},
	}
	require.NoError(t, NewGitHubWebhookEventWorker(queries, dispatcher).PollOnce(context.Background()))
	require.Len(t, queries.retried, 1)
	assert.Equal(t, int32(2), queries.retried[0].ExpectedAttempts)
	assert.Empty(t, queries.markFailed)

	done := pushJobQuerier(pushJob(7, 3))
	done.markGitHubWebhookJobDoneFn = func(context.Context, db.MarkGitHubWebhookJobDoneParams) (int64, error) { return 0, nil }
	require.NoError(t, NewGitHubWebhookEventWorker(done, &mockGitHubWebhookEventRunDispatcher{}).PollOnce(context.Background()))
	require.Len(t, done.markDone, 1)
	assert.Equal(t, db.MarkGitHubWebhookJobDoneParams{ID: 7, ExpectedAttempts: 3}, done.markDone[0])
	assert.Empty(t, done.retried, "a lost done claim is not an error to retry")
	assert.Empty(t, done.markFailed)
}

func TestGitHubWebhookEventWorker_PollOnce_DispatchFailureAtAttemptCapMarksJobFailed(t *testing.T) {
	t.Parallel()

	queries := pushJobQuerier(pushJob(4, gitHubWebhookJobMaxAttempts))
	dispatcher := &mockGitHubWebhookEventRunDispatcher{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, errors.New("boom")
		},
	}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, queries.retried)
	require.Len(t, queries.markFailed, 1)
	assert.Equal(t, int64(4), queries.markFailed[0].ID)
	assert.Equal(t, gitHubWebhookJobMaxAttempts, queries.markFailed[0].ExpectedAttempts)
	assert.Contains(t, queries.markFailed[0].Error, "boom")
}

func TestGitHubWebhookEventWorker_PollOnce_UnparseablePayloadFailsPermanently(t *testing.T) {
	t.Parallel()

	queries := &mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error) {
			return []db.GithubWebhookJob{{
				ID:        5,
				EventType: "push",
				Attempts:  1,
				Payload:   json.RawMessage(`{"broken"`),
			}}, nil
		},
	}
	worker := NewGitHubWebhookEventWorker(queries, &mockGitHubWebhookEventRunDispatcher{})

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, queries.retried)
	require.Len(t, queries.markFailed, 1)
	assert.Equal(t, int64(5), queries.markFailed[0].ID)
	assert.Contains(t, queries.markFailed[0].Error, "parse payload")
}

func TestGitHubWebhookJobRetryBackoff_DoublesAndCaps(t *testing.T) {
	t.Parallel()

	assert.Equal(t, gitHubWebhookJobRetryBaseBackoff, gitHubWebhookJobRetryBackoff(0))
	assert.Equal(t, gitHubWebhookJobRetryBaseBackoff, gitHubWebhookJobRetryBackoff(1))
	assert.Equal(t, 2*gitHubWebhookJobRetryBaseBackoff, gitHubWebhookJobRetryBackoff(2))
	assert.Equal(t, 8*gitHubWebhookJobRetryBaseBackoff, gitHubWebhookJobRetryBackoff(4))
	assert.Equal(t, gitHubWebhookJobRetryMaxBackoff, gitHubWebhookJobRetryBackoff(30))
	assert.Equal(t, gitHubWebhookJobRetryMaxBackoff, gitHubWebhookJobRetryBackoff(1000))
}

func TestMatchingWorkflowDefinitionIDs_AllowsWildcardAction(t *testing.T) {
	t.Parallel()

	ids := matchingWorkflowDefinitionIDs([]db.WorkflowTrigger{
		{WorkflowDefinitionID: 1, EventType: "check_run", EventAction: "", Enabled: true},
		{WorkflowDefinitionID: 2, EventType: "check_run", EventAction: "completed", Enabled: true},
	}, TriggerEvent{Type: "check_run", Action: "completed"})

	assert.Equal(t, []int64{1, 2}, ids)
}

func TestGitHubWebhookEventWorker_PollScheduledWorkflowTriggers_DelegatesToCronScheduler(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	queries := &mockGitHubWebhookEventWorkerQuerier{
		claimDueWorkflowScheduleSpecsFn: func(ctx context.Context, claimLimit int32) ([]db.WorkflowScheduleSpec, error) {
			assert.Equal(t, defaultGitHubWebhookEventWorkerClaimLimit, claimLimit)
			return []db.WorkflowScheduleSpec{{
				ID:                   7,
				WorkflowDefinitionID: 10,
				RepositoryID:         42,
				CronExpression:       "*/5 * * * *",
			}}, nil
		},
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)

	err := worker.PollScheduledWorkflowTriggers(context.Background(), now)
	require.NoError(t, err)

	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, int64(42), dispatcher.calls[0].RepositoryID)
	require.NotNil(t, dispatcher.calls[0].WorkflowDefinitionID)
	assert.Equal(t, int64(10), *dispatcher.calls[0].WorkflowDefinitionID)
	assert.Equal(t, "schedule", dispatcher.calls[0].Event.Type)

	require.Len(t, queries.fireTimes, 1)
	assert.Equal(t, int64(7), queries.fireTimes[0].ID)
	assert.True(t, queries.fireTimes[0].PrevFireAt.Valid)
	assert.Equal(t, now, queries.fireTimes[0].PrevFireAt.Time)
	assert.Equal(t, now.Add(5*time.Minute), queries.fireTimes[0].NextFireAt)
}

type recordingMythicalObserver struct {
	events   []string
	payloads [][]byte
}

func (m *recordingMythicalObserver) ObserveGitHubEvent(_ context.Context, eventType string, payload []byte) error {
	var event struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal(payload, &event)
	m.events = append(m.events, eventType+":"+event.Action)
	m.payloads = append(m.payloads, payload)
	return nil
}

// The stack sees an outside contributor's issue events that the trigger
// trust gate drops, so closing a maintainer-approved outsider issue cancels
// its item; the stack applies its own trust rule (smithersai/smithers#2175).
func TestGitHubWebhookEventWorker_PollOnce_UntrustedIssueEventsReachTheStack(t *testing.T) {
	t.Parallel()

	queries := &mockGitHubWebhookEventWorkerQuerier{
		claimPendingGitHubWebhookJobsFn: func(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error) {
			return []db.GithubWebhookJob{{
				ID:        3,
				EventType: "issues",
				Action:    "closed",
				Payload: json.RawMessage(`{"action":"closed",
					"issue":{"id":9,"number":7,"state":"closed","author_association":"NONE","labels":[{"name":"smithers"}]},
					"repository":{"name":"demo","owner":{"login":"acme"}}}`),
			}}, nil
		},
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)
	stack := &recordingMythicalObserver{}
	worker.SetMythical(stack)

	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []string{"issues:closed"}, stack.events)
	assert.Equal(t, []int64{3}, queries.markDoneIDs)
	assert.Empty(t, dispatcher.calls, "the trigger trust gate still drops the event")
}

func TestGitHubPushCredentialIsAPersonOnlyOnTheDefaultBranch(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		reviewed      bool
	}{
		{"person on default", `{"ref":"refs/heads/main","repository":{"default_branch":"main"},"sender":{"type":"User"}}`, true},
		{"person on branch", `{"ref":"refs/heads/topic","repository":{"default_branch":"main"},"sender":{"type":"User"}}`, false},
		{"person on tag", `{"ref":"refs/tags/main","repository":{"default_branch":"main"},"sender":{"type":"User"}}`, false},
		{"bot on default", `{"ref":"refs/heads/main","repository":{"default_branch":"main"},"sender":{"type":"Bot"}}`, false},
		{"no sender", `{"ref":"refs/heads/main","repository":{"default_branch":"main"}}`, false},
		{"no default", `{"ref":"refs/heads/","repository":{},"sender":{"type":"User"}}`, false},
		{"no repository", `{"ref":"refs/heads/main","sender":{"type":"User"}}`, false},
	} {
		payload, err := parseGitHubWorkflowEventPayload(json.RawMessage(tc.payload))
		require.NoError(t, err)
		assert.Equal(t, tc.reviewed, gitHubPushCredential(payload).Reviewed(), tc.name)
	}
}
