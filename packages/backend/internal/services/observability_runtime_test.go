package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeRuntimeMetricsStore struct {
	activeSessions int64
	oldestSession  float64
	landingDepth   int64
	backlog        db.GetCodeSearchBacklogRow
}

func (f *fakeRuntimeMetricsStore) CountActiveAgentSessions(context.Context) (int64, error) {
	return f.activeSessions, nil
}

func (f *fakeRuntimeMetricsStore) GetActiveAgentSessionOldestAgeSeconds(context.Context) (float64, error) {
	return f.oldestSession, nil
}

func (f *fakeRuntimeMetricsStore) GetLandingQueueDepth(context.Context) (int64, error) {
	return f.landingDepth, nil
}

func (f *fakeRuntimeMetricsStore) GetCodeSearchBacklog(context.Context) (db.GetCodeSearchBacklogRow, error) {
	return f.backlog, nil
}

type fakeRuntimeMetricsObserver struct {
	mu             sync.Mutex
	activeSessions float64
	oldestSession  float64
	landingDepth   float64
	backlog        float64
	backlogOldest  float64
	sets           int
}

func (f *fakeRuntimeMetricsObserver) SetActiveAgentSessions(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.activeSessions = n
	f.sets++
}

func (f *fakeRuntimeMetricsObserver) SetActiveAgentSessionOldestAgeSeconds(n float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.oldestSession = n
	f.sets++
}

func (f *fakeRuntimeMetricsObserver) SetLandingQueueDepth(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.landingDepth = float64(n)
	f.sets++
}

func (f *fakeRuntimeMetricsObserver) SetCodeSearchBacklog(repositories int, oldestAgeSeconds float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.backlog, f.backlogOldest = float64(repositories), oldestAgeSeconds
	f.sets++
}

func (f *fakeRuntimeMetricsObserver) backlogSnapshot() (repositories, oldest float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.backlog, f.backlogOldest
}

func (f *fakeRuntimeMetricsObserver) snapshot() (active, oldest, landing float64, sets int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.activeSessions, f.oldestSession, f.landingDepth, f.sets
}

// runCollector starts the collector and returns a channel closed when it returns.
func runCollector(ctx context.Context, store RuntimeMetricsStore, observer RuntimeMetricsObserver, interval, timeout time.Duration) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		runRuntimeMetricsCollector(ctx, store, observer, interval, timeout)
	}()
	return done
}

func TestRuntimeMetricsCollector_CollectsCurrentState(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &fakeRuntimeMetricsStore{activeSessions: 7, oldestSession: 1860, landingDepth: 3, backlog: db.GetCodeSearchBacklogRow{Repositories: 4, OldestAgeSeconds: 900}}
	observer := &fakeRuntimeMetricsObserver{}
	done := runCollector(ctx, store, observer, time.Hour, time.Second)

	// The first refresh runs immediately, not after the first interval.
	require.Eventually(t, func() bool {
		active, oldest, landing, _ := observer.snapshot()
		backlog, backlogOldest := observer.backlogSnapshot()
		return active == 7 && oldest == 1860 && landing == 3 && backlog == 4 && backlogOldest == 900
	}, time.Second, 5*time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("collector did not return after cancellation")
	}
}

func TestRuntimeMetricsCollector_RefreshesEveryInterval(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observer := &fakeRuntimeMetricsObserver{}
	done := runCollector(ctx, &fakeRuntimeMetricsStore{}, observer, 5*time.Millisecond, time.Second)
	require.Eventually(t, func() bool {
		_, _, _, sets := observer.snapshot()
		return sets >= 12 // four gauge refreshes, at least three polls
	}, time.Second, 5*time.Millisecond)
	cancel()
	<-done
}

func TestRunRuntimeMetricsCollector_ReturnsWithoutDependencies(t *testing.T) {
	ctx := context.Background()
	for name, run := range map[string]func(){
		"nil store":    func() { RunRuntimeMetricsCollector(ctx, nil, &fakeRuntimeMetricsObserver{}, time.Second) },
		"nil observer": func() { RunRuntimeMetricsCollector(ctx, &fakeRuntimeMetricsStore{}, nil, time.Second) },
		"no interval":  func() { RunRuntimeMetricsCollector(ctx, &fakeRuntimeMetricsStore{}, &fakeRuntimeMetricsObserver{}, 0) },
	} {
		done := make(chan struct{})
		go func() { defer close(done); run() }()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s: collector did not return", name)
		}
	}
}

func TestRunRuntimeMetricsCollector_CancelledContextDoesNotQuery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	observer := &fakeRuntimeMetricsObserver{}
	RunRuntimeMetricsCollector(ctx, &fakeRuntimeMetricsStore{activeSessions: 1}, observer, time.Millisecond)
	_, _, _, sets := observer.snapshot()
	require.Zero(t, sets)
}

type blockingLandingMetricsStore struct {
	fakeRuntimeMetricsStore
	polls     atomic.Int64
	cancelled chan error
}

func (s *blockingLandingMetricsStore) CountActiveAgentSessions(context.Context) (int64, error) {
	return s.polls.Add(1), nil
}

func (s *blockingLandingMetricsStore) GetLandingQueueDepth(ctx context.Context) (int64, error) {
	<-ctx.Done()
	s.cancelled <- ctx.Err()
	return 0, ctx.Err()
}

func TestRuntimeMetricsCollector_BlockedLandingDoesNotFreezeOtherGauges(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &blockingLandingMetricsStore{fakeRuntimeMetricsStore: fakeRuntimeMetricsStore{oldestSession: 42}, cancelled: make(chan error, 100)}
	observer := &fakeRuntimeMetricsObserver{landingDepth: 17}
	done := runCollector(ctx, store, observer, 10*time.Millisecond, 100*time.Millisecond)
	for i := 0; i < 2; i++ {
		select {
		case err := <-store.cancelled:
			require.ErrorIs(t, err, context.DeadlineExceeded)
		case <-time.After(time.Second):
			t.Fatal("landing refresh did not reach its deadline or polling stopped")
		}
	}
	active, oldest, landing, _ := observer.snapshot()
	require.GreaterOrEqual(t, active, 2.0)
	require.Equal(t, 42.0, oldest)
	require.Equal(t, 17.0, landing, "failed query must not publish a false zero")
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("collector did not return while a query was blocked")
	}
}

type failingRuntimeMetricsStore struct{ fakeRuntimeMetricsStore }

func (failingRuntimeMetricsStore) CountActiveAgentSessions(context.Context) (int64, error) {
	return 0, errors.New("database unavailable")
}

func TestRuntimeMetricsCollector_QueryErrorKeepsLastValue(t *testing.T) {
	observer := &fakeRuntimeMetricsObserver{activeSessions: 5}
	collectRuntimeMetrics(context.Background(), &failingRuntimeMetricsStore{fakeRuntimeMetricsStore{landingDepth: 2}}, observer, time.Second)
	active, _, landing, _ := observer.snapshot()
	require.Equal(t, 5.0, active)
	require.Equal(t, 2.0, landing)
}

// The generated product queries back the gauges, and the values follow
// sessions starting and finishing and landing tasks being queued and claimed.
func TestRuntimeMetricsCollector_PostgresGaugesMove(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	userID, repoID := setupTestUserAndRepo(t, pool)

	// Other tests in this package share the database, so compare with the
	// state before this test's rows exist.
	observer := &fakeRuntimeMetricsObserver{activeSessions: -1, landingDepth: -1}
	refresh := func() (float64, float64, float64) {
		collectRuntimeMetrics(ctx, q, observer, 5*time.Second)
		active, oldest, landing, _ := observer.snapshot()
		return active, oldest, landing
	}
	baseActive, baseOldest, baseLanding := refresh()
	require.GreaterOrEqual(t, baseActive, 0.0)
	require.GreaterOrEqual(t, baseLanding, 0.0)

	sessions := make([]string, 2)
	for i := range sessions {
		sessions[i] = uuid.NewString()
		_, err := q.CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: sessions[i], RepositoryID: repoID, UserID: userID, Title: "gauge", Status: "active"})
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `UPDATE agent_sessions SET created_at = NOW() - interval '1 day' WHERE id = $1`, sessions[0])
	require.NoError(t, err)
	for _, title := range []string{"first", "second"} {
		lr, err := q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: repoID, AuthorID: userID, Title: title, TargetBookmark: "main", StackSize: 1})
		require.NoError(t, err)
		_, err = q.CreateLandingTask(ctx, db.CreateLandingTaskParams{LandingRequestID: lr.ID, RepositoryID: repoID, Priority: 1})
		require.NoError(t, err)
	}
	active, oldest, landing := refresh()
	require.Equal(t, baseActive+2, active)
	require.InDelta(t, 86400, oldest, 60, "the backdated session is the oldest active one")
	require.Equal(t, baseLanding+2, landing)

	// Finishing the oldest session drops the count and the oldest age.
	_, err = q.UpdateAgentSessionStatus(ctx, db.UpdateAgentSessionStatusParams{ID: sessions[0], Status: "completed"})
	require.NoError(t, err)
	// A claimed task is running, no longer queued.
	_, err = q.ClaimPendingLandingTask(ctx)
	require.NoError(t, err)
	active, oldest, landing = refresh()
	require.Equal(t, baseActive+1, active)
	require.Less(t, oldest, 86400.0-60)
	require.Equal(t, baseLanding+1, landing)

	_, err = q.UpdateAgentSessionStatus(ctx, db.UpdateAgentSessionStatusParams{ID: sessions[1], Status: "failed"})
	require.NoError(t, err)
	active, oldest, _ = refresh()
	require.Equal(t, baseActive, active)
	require.InDelta(t, baseOldest, oldest, 60)
}
