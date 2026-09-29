package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockCronSchedulerQuerier struct {
	claimDueSpecsFn   func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error)
	updateFireTimesFn func(ctx context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error
	getWorkflowDefFn  func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)

	mu                   sync.Mutex
	updateFireTimesCalls []db.UpdateWorkflowScheduleFireTimesParams
}

func (m *mockCronSchedulerQuerier) ClaimDueWorkflowScheduleSpecs(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
	if m.claimDueSpecsFn != nil {
		return m.claimDueSpecsFn(ctx, limitCount)
	}
	return nil, nil
}

func (m *mockCronSchedulerQuerier) UpdateWorkflowScheduleFireTimes(ctx context.Context, arg db.UpdateWorkflowScheduleFireTimesParams) error {
	m.mu.Lock()
	m.updateFireTimesCalls = append(m.updateFireTimesCalls, arg)
	m.mu.Unlock()
	if m.updateFireTimesFn != nil {
		return m.updateFireTimesFn(ctx, arg)
	}
	return nil
}

func (m *mockCronSchedulerQuerier) GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	if m.getWorkflowDefFn != nil {
		return m.getWorkflowDefFn(ctx, arg)
	}
	return db.WorkflowDefinition{}, nil
}

type mockCronSchedulerRunDispatcher struct {
	dispatchFn    func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	mu            sync.Mutex
	dispatchCalls []DispatchForEventInput
}

func (m *mockCronSchedulerRunDispatcher) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.mu.Lock()
	m.dispatchCalls = append(m.dispatchCalls, input)
	m.mu.Unlock()
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, input)
	}
	return nil, nil
}

func TestCronSchedulerWorker_PollOnce_NoDueSchedules(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.Empty(t, dispatcher.dispatchCalls)
	assert.Empty(t, queries.updateFireTimesCalls)
}

func TestCronSchedulerWorker_PollOnce_FiresDueSchedule(t *testing.T) {
	specID := int64(123)
	defID := int64(456)
	repoID := int64(789)

	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{
				{
					ID:                   specID,
					WorkflowDefinitionID: defID,
					RepositoryID:         repoID,
					CronExpression:       "0 0 * * *",
				},
			}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Len(t, dispatcher.dispatchCalls, 1)
	assert.Equal(t, repoID, dispatcher.dispatchCalls[0].RepositoryID)
	require.NotNil(t, dispatcher.dispatchCalls[0].WorkflowDefinitionID)
	assert.Equal(t, defID, *dispatcher.dispatchCalls[0].WorkflowDefinitionID)
	assert.Equal(t, "schedule", dispatcher.dispatchCalls[0].Event.Type)

	require.Len(t, queries.updateFireTimesCalls, 1)
	assert.Equal(t, specID, queries.updateFireTimesCalls[0].ID)
	assert.True(t, queries.updateFireTimesCalls[0].PrevFireAt.Valid)
	assert.NotZero(t, queries.updateFireTimesCalls[0].NextFireAt)
}

func TestCronSchedulerWorker_PollOnce_FiresMultipleDueSchedules(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{
				{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "* * * * *"},
				{ID: 2, WorkflowDefinitionID: 20, RepositoryID: 200, CronExpression: "* * * * *"},
			}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.Len(t, dispatcher.dispatchCalls, 2)
	assert.Len(t, queries.updateFireTimesCalls, 2)
}

func TestCronSchedulerWorker_PollOnce_DispatchError_ContinuesProcessing(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{
				{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "* * * * *"},
				{ID: 2, WorkflowDefinitionID: 20, RepositoryID: 200, CronExpression: "* * * * *"},
			}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{
		dispatchFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			if input.RepositoryID == 100 {
				return nil, errors.New("dispatch failed")
			}
			return nil, nil
		},
	}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.Len(t, dispatcher.dispatchCalls, 2)
	// The dispatch failure for spec 1 must not acknowledge the occurrence:
	// its fire time is never advanced, so it stays due and is retried at
	// lease expiry. Only spec 2 (successful dispatch) gets its fire time
	// updated.
	require.Len(t, queries.updateFireTimesCalls, 1)
	assert.Equal(t, int64(2), queries.updateFireTimesCalls[0].ID)
}

func TestCronSchedulerWorker_PollOnce_DispatchError_DoesNotAcknowledgeOccurrence(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{
				{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "* * * * *"},
			}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{
		dispatchFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, errors.New("dispatch failed")
		},
	}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.Len(t, dispatcher.dispatchCalls, 1)
	assert.Empty(t, queries.updateFireTimesCalls)
}

func TestCronSchedulerWorker_PollOnce_ComputesNextFireAt(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{
				{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "0 0 * * *"}, // midnight
			}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.Len(t, queries.updateFireTimesCalls, 1)
	nextFire := queries.updateFireTimesCalls[0].NextFireAt

	// Unprefixed schedules fire at UTC midnight even when NextFireAt has
	// the host's local location.
	assert.Equal(t, 0, nextFire.UTC().Hour())
	assert.Equal(t, 0, nextFire.UTC().Minute())
}

func TestCronSchedulerWorker_PollOnce_ContextCancelled(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return []db.WorkflowScheduleSpec{
				{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "* * * * *"},
				{ID: 2, WorkflowDefinitionID: 20, RepositoryID: 200, CronExpression: "* * * * *"},
			}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel before PollOnce

	err := worker.PollOnce(ctx)
	assert.ErrorIs(t, err, context.Canceled)

	assert.Empty(t, dispatcher.dispatchCalls)
	assert.Empty(t, queries.updateFireTimesCalls)
}

func TestCronSchedulerWorker_Start_PollsRepeatedlyAndStops(t *testing.T) {
	var pollCount atomic.Int32
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			pollCount.Add(1)
			return []db.WorkflowScheduleSpec{}, nil
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)
	worker.interval = 5 * time.Millisecond // very fast poll for test

	ctx, cancel := context.WithCancel(context.Background())

	// Run start in background
	go worker.Start(ctx)

	// Wait for a few polls
	time.Sleep(20 * time.Millisecond)
	cancel()

	// Wait for worker to stop
	time.Sleep(10 * time.Millisecond)

	assert.GreaterOrEqual(t, pollCount.Load(), int32(2))
}

func TestNextFireTime_Standard(t *testing.T) {
	// A non-UTC host must still interpret an unprefixed cron in UTC.
	now := time.Date(2023, 1, 1, 4, 0, 0, 0, time.FixedZone("UTC-8", -8*60*60))
	next, err := nextFireTime("0 0 * * *", now)
	require.NoError(t, err)
	assert.Equal(t, time.Date(2023, 1, 2, 0, 0, 0, 0, time.UTC), next.UTC())
}

func TestNextFireTime_EveryFiveMinutes(t *testing.T) {
	now := time.Date(2023, 1, 1, 12, 0, 0, 0, time.UTC)
	next, err := nextFireTime("*/5 * * * *", now)
	require.NoError(t, err)
	assert.Equal(t, time.Date(2023, 1, 1, 12, 5, 0, 0, time.UTC), next)
}

func TestNextFireTime_InvalidExpression(t *testing.T) {
	_, err := nextFireTime("invalid", time.Now())
	assert.Error(t, err)
}

// TestCronSchedulerWorker_ConcurrentPollers_SpecFiresOnlyOnce verifies that
// when multiple CronSchedulerWorker instances poll concurrently, each spec is
// only dispatched once. This simulates the FOR UPDATE SKIP LOCKED behavior at
// the mock level: the first caller to claim a spec removes it from the
// available set, so subsequent callers get an empty list.
func TestCronSchedulerWorker_ConcurrentPollers_SpecFiresOnlyOnce(t *testing.T) {
	spec := db.WorkflowScheduleSpec{
		ID:                   42,
		WorkflowDefinitionID: 100,
		RepositoryID:         200,
		CronExpression:       "* * * * *",
	}

	// claimed tracks whether the spec has been claimed. Only the first
	// caller gets the spec; all others get an empty slice, mirroring the
	// FOR UPDATE SKIP LOCKED semantics in the real query.
	var claimed atomic.Bool

	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			if claimed.CompareAndSwap(false, true) {
				return []db.WorkflowScheduleSpec{spec}, nil
			}
			return []db.WorkflowScheduleSpec{}, nil
		},
	}

	var dispatchCount atomic.Int32
	dispatcher := &mockCronSchedulerRunDispatcher{
		dispatchFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			dispatchCount.Add(1)
			return nil, nil
		},
	}

	const numPollers = 10
	var wg sync.WaitGroup
	wg.Add(numPollers)

	for i := 0; i < numPollers; i++ {
		go func() {
			defer wg.Done()
			worker := NewCronSchedulerWorker(queries, dispatcher)
			_ = worker.PollOnce(context.Background())
		}()
	}

	wg.Wait()

	// The spec must have been dispatched exactly once despite 10 concurrent pollers.
	assert.Equal(t, int32(1), dispatchCount.Load(),
		"spec should fire exactly once with concurrent pollers")
}

// TestCronSchedulerWorker_ConcurrentPollers_MultipleSpecs verifies that
// concurrent pollers correctly partition multiple due specs among themselves,
// with each spec firing exactly once across all pollers.
func TestCronSchedulerWorker_ConcurrentPollers_MultipleSpecs(t *testing.T) {
	specs := []db.WorkflowScheduleSpec{
		{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "* * * * *"},
		{ID: 2, WorkflowDefinitionID: 20, RepositoryID: 200, CronExpression: "* * * * *"},
		{ID: 3, WorkflowDefinitionID: 30, RepositoryID: 300, CronExpression: "* * * * *"},
	}

	// Simulate FOR UPDATE SKIP LOCKED: each spec can only be claimed once.
	// Use a mutex to protect the unclaimed slice and simulate atomic claim.
	var mu sync.Mutex
	unclaimed := make([]db.WorkflowScheduleSpec, len(specs))
	copy(unclaimed, specs)

	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			mu.Lock()
			defer mu.Unlock()
			if len(unclaimed) == 0 {
				return []db.WorkflowScheduleSpec{}, nil
			}
			// Claim one spec (simulating per-row locking)
			claimed := unclaimed[0]
			unclaimed = unclaimed[1:]
			return []db.WorkflowScheduleSpec{claimed}, nil
		},
	}

	// Track which spec IDs were dispatched.
	var dispatchedMu sync.Mutex
	dispatchedIDs := map[int64]int{}

	dispatcher := &mockCronSchedulerRunDispatcher{
		dispatchFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			if input.WorkflowDefinitionID != nil {
				dispatchedMu.Lock()
				dispatchedIDs[*input.WorkflowDefinitionID]++
				dispatchedMu.Unlock()
			}
			return nil, nil
		},
	}

	const numPollers = 10
	var wg sync.WaitGroup
	wg.Add(numPollers)

	for i := 0; i < numPollers; i++ {
		go func() {
			defer wg.Done()
			worker := NewCronSchedulerWorker(queries, dispatcher)
			_ = worker.PollOnce(context.Background())
		}()
	}

	wg.Wait()

	// Every spec must have been dispatched exactly once.
	for _, spec := range specs {
		assert.Equal(t, 1, dispatchedIDs[spec.WorkflowDefinitionID],
			"spec with def_id=%d should fire exactly once", spec.WorkflowDefinitionID)
	}
}

// TestCronSchedulerWorker_ClaimError_ReturnsError verifies that an error
// from the atomic claim query is propagated correctly.
func TestCronSchedulerWorker_ClaimError_ReturnsError(t *testing.T) {
	queries := &mockCronSchedulerQuerier{
		claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
			return nil, errors.New("database connection lost")
		},
	}
	dispatcher := &mockCronSchedulerRunDispatcher{}
	worker := NewCronSchedulerWorker(queries, dispatcher)

	err := worker.PollOnce(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "database connection lost")
	assert.Empty(t, dispatcher.dispatchCalls)
}

func TestCronSchedulerWorker_PollOnce_RefusedDispatch_SkipsOccurrence(t *testing.T) {
	refusals := map[string]error{
		"billing cap":        pkgerrors.Forbidden("CI minutes quota exceeded for the current billing plan"),
		"invalid trigger":    pkgerrors.UnprocessableEntity("invalid workflow trigger configuration: bad"),
		"missing def":        pkgerrors.NotFound("workflow definition not found"),
		"wrapped refusal":    fmt.Errorf("dispatch: %w", pkgerrors.Forbidden("CI minutes quota exceeded")),
		"plan limit (402)":   pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "plan limit"),
		"per-resource (429)": pkgerrors.QuotaExceeded("at cap"),
	}
	for name, refusal := range refusals {
		t.Run(name, func(t *testing.T) {
			now := time.Date(2026, 9, 24, 12, 7, 30, 0, time.UTC)
			queries := &mockCronSchedulerQuerier{
				claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
					return []db.WorkflowScheduleSpec{
						{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "0 * * * *"},
					}, nil
				},
			}
			dispatcher := &mockCronSchedulerRunDispatcher{
				dispatchFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
					return nil, refusal
				},
			}
			var logs bytes.Buffer
			worker := NewCronSchedulerWorker(queries, dispatcher)
			worker.logger = slog.New(slog.NewTextHandler(&logs, nil))

			require.NoError(t, worker.pollOnce(context.Background(), now))

			require.Len(t, queries.updateFireTimesCalls, 1)
			update := queries.updateFireTimesCalls[0]
			assert.Equal(t, int64(1), update.ID)
			assert.Equal(t, pgtype.Timestamptz{Time: now, Valid: true}, update.PrevFireAt)
			assert.Equal(t, time.Date(2026, 9, 24, 13, 0, 0, 0, time.UTC), update.NextFireAt)

			assert.Contains(t, logs.String(), "spec_id=1")
			assert.Contains(t, logs.String(), "repository_id=100")
			assert.Contains(t, logs.String(), "workflow_definition_id=10")
		})
	}
}

// Transient failures (plue's own infra, a bug, a wrapped non-API error) keep
// the claim lease so the same occurrence is retried, and the log names the
// repository and definition so an operator can find the schedule.
func TestCronSchedulerWorker_PollOnce_TransientDispatchError_KeepsLeaseAndLogsIDs(t *testing.T) {
	transients := map[string]error{
		"internal":    pkgerrors.Internal("failed to fetch workflow definition"),
		"unavailable": pkgerrors.New(pkgerrors.CodeServiceUnavailable, "down"),
		"plain":       errors.New("connection reset"),
	}
	for name, transient := range transients {
		t.Run(name, func(t *testing.T) {
			queries := &mockCronSchedulerQuerier{
				claimDueSpecsFn: func(ctx context.Context, limitCount int32) ([]db.WorkflowScheduleSpec, error) {
					return []db.WorkflowScheduleSpec{
						{ID: 1, WorkflowDefinitionID: 10, RepositoryID: 100, CronExpression: "0 * * * *"},
					}, nil
				},
			}
			dispatcher := &mockCronSchedulerRunDispatcher{
				dispatchFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
					return nil, transient
				},
			}
			var logs bytes.Buffer
			worker := NewCronSchedulerWorker(queries, dispatcher)
			worker.logger = slog.New(slog.NewTextHandler(&logs, nil))

			require.NoError(t, worker.PollOnce(context.Background()))

			assert.Empty(t, queries.updateFireTimesCalls)
			assert.Contains(t, logs.String(), "repository_id=100")
			assert.Contains(t, logs.String(), "workflow_definition_id=10")
		})
	}
}
