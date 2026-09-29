package cleanup

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// workspaceCoverStore is a thread-safe WorkspaceCleanupStore with per-pass
// error injection, safe to drive from a concurrent (real ticker) loop.
type workspaceCoverStore struct {
	mu    sync.Mutex
	sweep int32

	idleSessionsFn func(context.Context) error
}

func (m *workspaceCoverStore) CleanupIdleSessions(ctx context.Context) error {
	atomic.AddInt32(&m.sweep, 1)
	if m.idleSessionsFn != nil {
		return m.idleSessionsFn(ctx)
	}
	return nil
}

func (m *workspaceCoverStore) CleanupStalePendingWorkspaces(ctx context.Context) error { return nil }
func (m *workspaceCoverStore) CleanupIdleWorkspaces(ctx context.Context) error         { return nil }
func (m *workspaceCoverStore) CleanupOverQuotaWorkspaces(context.Context) error        { return nil }
func (m *workspaceCoverStore) CleanupAbandonedWorkspaces(context.Context) error        { return nil }

func (m *workspaceCoverStore) sweepCount() int {
	return int(atomic.LoadInt32(&m.sweep))
}

// TestWorkspaceCleaner_Cover_SweepIdleSessionsError covers the
// CleanupIdleSessions error branch of sweep (siblings only fail the other two).
func TestWorkspaceCleaner_Cover_SweepIdleSessionsError(t *testing.T) {
	t.Parallel()

	store := &workspaceCoverStore{
		idleSessionsFn: func(context.Context) error { return errors.New("idle sessions failed") },
	}
	cleaner := NewWorkspaceCleaner(store, time.Minute)

	err := cleaner.sweep(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cleanup idle sessions")
}

// TestWorkspaceCleaner_Cover_Lifecycle covers Start, loop (ticker + stopCh
// cases), Stop, Wait and the default newTicker closure end-to-end.
func TestWorkspaceCleaner_Cover_Lifecycle(t *testing.T) {
	t.Parallel()

	store := &workspaceCoverStore{}
	cleaner := NewWorkspaceCleaner(store, 2*time.Millisecond)

	cleaner.Start(context.Background())
	waitForCondition(t, 2*time.Second, func() bool {
		return store.sweepCount() >= 1
	})

	cleaner.Stop()
	cleaner.Wait()
	require.GreaterOrEqual(t, store.sweepCount(), 1)
}

// TestWorkspaceCleaner_Cover_DoubleStart covers the running-guard early return
// in Start.
func TestWorkspaceCleaner_Cover_DoubleStart(t *testing.T) {
	t.Parallel()

	store := &workspaceCoverStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkspaceCleaner(store, time.Hour)
	cleaner.newTicker = func(time.Duration) ticker { return ft }

	ctx := context.Background()
	cleaner.Start(ctx)
	cleaner.Start(ctx) // no-op

	cleaner.Stop()
	cleaner.Wait()
	assert.Equal(t, 1, ft.StopCalls())
}

// TestWorkspaceCleaner_Cover_ContextCancel covers the ctx.Done() branch of the
// loop.
func TestWorkspaceCleaner_Cover_ContextCancel(t *testing.T) {
	t.Parallel()

	store := &workspaceCoverStore{}
	ft := &fakeTicker{ch: make(chan time.Time, 1)}
	cleaner := NewWorkspaceCleaner(store, time.Hour)
	cleaner.newTicker = func(time.Duration) ticker { return ft }

	ctx, cancel := context.WithCancel(context.Background())
	cleaner.Start(ctx)
	cancel()
	cleaner.Wait()

	require.GreaterOrEqual(t, ft.StopCalls(), 1)
}

// TestWorkspaceCleaner_Cover_StopWithoutStart covers Stop's not-running early
// return.
func TestWorkspaceCleaner_Cover_StopWithoutStart(t *testing.T) {
	t.Parallel()

	cleaner := NewWorkspaceCleaner(&workspaceCoverStore{}, time.Hour)
	cleaner.Stop()
}
