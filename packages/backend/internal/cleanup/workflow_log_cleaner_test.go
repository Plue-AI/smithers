package cleanup

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type workflowLogCleanupFixture struct {
	mu       sync.Mutex
	calls    []db.DeleteWorkflowLogsOlderThanParams
	err      error
	runErr   error
	runCalls []db.DeleteWorkflowRunLogsOlderThanParams
	deadline time.Time
}

func (f *workflowLogCleanupFixture) DeleteWorkflowLogsOlderThan(ctx context.Context, arg db.DeleteWorkflowLogsOlderThanParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, arg)
	f.deadline, _ = ctx.Deadline()
	if f.err != nil {
		return 0, f.err
	}
	if len(f.calls) < 3 {
		return 1, nil
	}
	return 0, nil
}
func TestWorkflowLogCleanerStartupDrainsBoundedBatches(t *testing.T) {
	f := &workflowLogCleanupFixture{}
	c := NewWorkflowLogCleaner(f)
	before := time.Now().Add(-30 * 24 * time.Hour)
	c.Start(context.Background())
	defer c.Stop()
	require.Eventually(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) == 3 }, time.Second, time.Millisecond)
	c.Stop()
	f.mu.Lock()
	defer f.mu.Unlock()
	require.Len(t, f.runCalls, 3)
	require.WithinDuration(t, time.Now().Add(30*time.Second), f.deadline, time.Second)
	for i, call := range f.calls {
		require.Equal(t, call.Cutoff, f.runCalls[i].Cutoff)
		require.Equal(t, call.BatchLimit, f.runCalls[i].BatchLimit)
		require.Equal(t, int32(1000), call.BatchLimit)
		require.Equal(t, f.calls[0].Cutoff, call.Cutoff)
		require.False(t, call.Cutoff.Before(before))
		require.WithinDuration(t, before, call.Cutoff, time.Second)
	}
}
func TestWorkflowLogCleanerFailureAndCancellation(t *testing.T) {
	f := &workflowLogCleanupFixture{err: errors.New("database unavailable")}
	c := NewWorkflowLogCleaner(f)
	require.ErrorIs(t, c.sweep(context.Background()), f.err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, c.sweep(ctx), context.Canceled)
	require.Len(t, f.calls, 1)
	f.err = nil
	require.NoError(t, c.sweep(context.Background()))
	require.Len(t, f.calls, 3)
}

func TestWorkflowLogCleanerRetriesOnHourlyTick(t *testing.T) {
	f := &workflowLogCleanupFixture{err: errors.New("temporary database error")}
	c := NewWorkflowLogCleaner(f)
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	c.newTicker = func(interval time.Duration) ticker {
		require.Equal(t, time.Hour, interval)
		return ft
	}
	c.Start(context.Background())
	defer c.Stop()
	require.Eventually(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) == 1 }, time.Second, time.Millisecond)
	f.mu.Lock()
	f.err = nil
	f.mu.Unlock()
	ft.ch <- time.Now()
	require.Eventually(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) == 3 }, time.Second, time.Millisecond)
}

func (f *workflowLogCleanupFixture) DeleteWorkflowRunLogsOlderThan(ctx context.Context, arg db.DeleteWorkflowRunLogsOlderThanParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runCalls = append(f.runCalls, arg)
	return 0, f.runErr
}

func TestWorkflowLogCleanerRunLogFailure(t *testing.T) {
	f := &workflowLogCleanupFixture{runErr: errors.New("run log delete failed")}
	c := NewWorkflowLogCleaner(f)
	require.ErrorIs(t, c.sweep(context.Background()), f.runErr)
	require.Len(t, f.calls, 1)
	require.Len(t, f.runCalls, 1)
}
