package services

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type WorkflowRunMetricsObserver interface {
	ObserveWorkflowRunCompletion(status string, seconds float64)
}

type AgentSessionMetricsObserver interface {
	ObserveAgentSessionCompletion(status string)
	ObserveAgentSessionTimeout()
}

// RuntimeMetricsObserver receives live runtime state for gauges.
type RuntimeMetricsObserver interface {
	SetActiveAgentSessions(n float64)
	SetActiveAgentSessionOldestAgeSeconds(n float64)
	SetLandingQueueDepth(n int)
	SetCodeSearchBacklog(repositories int, oldestAgeSeconds float64)
}

// RuntimeMetricsStore reads the current state backing runtime gauges. The
// generated product queries satisfy it.
type RuntimeMetricsStore interface {
	CountActiveAgentSessions(ctx context.Context) (int64, error)
	GetActiveAgentSessionOldestAgeSeconds(ctx context.Context) (float64, error)
	GetLandingQueueDepth(ctx context.Context) (int64, error)
	GetCodeSearchBacklog(ctx context.Context) (db.GetCodeSearchBacklogRow, error)
}

// RuntimeMetricsInterval is how often the worker refreshes runtime gauges.
const RuntimeMetricsInterval = 15 * time.Second

const runtimeMetricsTimeout = 3 * time.Second

// RunRuntimeMetricsCollector refreshes runtime state gauges from the database
// immediately and then every interval, so alerts and dashboards reflect live
// agent-session and landing-queue state. It is a worker duty: it blocks until
// ctx is cancelled and any in-flight refresh has returned.
func RunRuntimeMetricsCollector(ctx context.Context, store RuntimeMetricsStore, observer RuntimeMetricsObserver, interval time.Duration) {
	if store == nil || observer == nil || interval <= 0 {
		return
	}
	runRuntimeMetricsCollector(ctx, store, observer, interval, runtimeMetricsTimeout)
}

func runRuntimeMetricsCollector(ctx context.Context, store RuntimeMetricsStore, observer RuntimeMetricsObserver, interval, timeout time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		collectRuntimeMetrics(ctx, store, observer, timeout)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func collectRuntimeMetrics(ctx context.Context, store RuntimeMetricsStore, observer RuntimeMetricsObserver, timeout time.Duration) {
	refreshCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Independent queries publish successful values immediately, even while
	// another query is waiting for its deadline. A failed query keeps the
	// gauge's last value rather than publishing a false zero. Wait before the
	// next poll so refreshes cannot accumulate during a database outage.
	var wg sync.WaitGroup
	run := func(name string, query func(context.Context) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := query(refreshCtx); err != nil && ctx.Err() == nil {
				slog.Warn("runtime metrics collection failed", "metric", name, "error", err)
			}
		}()
	}
	run("active_sessions", func(ctx context.Context) error {
		n, err := store.CountActiveAgentSessions(ctx)
		if err == nil {
			observer.SetActiveAgentSessions(float64(n))
		}
		return err
	})
	run("oldest_session", func(ctx context.Context) error {
		n, err := store.GetActiveAgentSessionOldestAgeSeconds(ctx)
		if err == nil {
			observer.SetActiveAgentSessionOldestAgeSeconds(n)
		}
		return err
	})
	run("landing_queue", func(ctx context.Context) error {
		n, err := store.GetLandingQueueDepth(ctx)
		if err == nil {
			observer.SetLandingQueueDepth(int(n))
		}
		return err
	})
	run("code_search_backlog", func(ctx context.Context) error {
		backlog, err := store.GetCodeSearchBacklog(ctx)
		if err == nil {
			observer.SetCodeSearchBacklog(int(backlog.Repositories), backlog.OldestAgeSeconds)
		}
		return err
	})
	wg.Wait()
}

// ObserveWorkflowRunCompletion counts a run's transition to status. run is the
// row loaded before the transition; a run that was already terminal was
// counted when it got there.
func ObserveWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	if IsTerminalWorkflowRunStatus(run.Status) {
		return
	}
	recordWorkflowRunCompletion(observer, run, status)
}

// recordWorkflowRunCompletion counts a completion the caller knows is the
// run's only one, such as a claim-fenced terminal write.
func recordWorkflowRunCompletion(observer WorkflowRunMetricsObserver, run db.WorkflowRun, status string) {
	if observer == nil || run.ID <= 0 || !IsTerminalWorkflowRunStatus(status) {
		return
	}

	startedAt := run.CreatedAt
	if run.StartedAt.Valid {
		startedAt = run.StartedAt.Time
	}

	duration := time.Since(startedAt).Seconds()
	if duration < 0 {
		return
	}

	observer.ObserveWorkflowRunCompletion(status, duration)
}
