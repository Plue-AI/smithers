package cleanup

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// SweepFailures counts cleaner sweeps that returned an error or panicked.
// compose registers it on the Smithers metrics registry.
var SweepFailures = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "smithers_cleanup_sweep_failures_total",
	Help: "Cleanup sweeps that failed, by cleaner.",
}, []string{"cleaner"})

// ticker is an interface for time.Ticker to allow mocking in tests.
type ticker interface {
	Chan() <-chan time.Time
	Stop()
}

// realTicker wraps time.Ticker to implement the ticker interface.
type realTicker struct {
	t *time.Ticker
}

func (t *realTicker) Chan() <-chan time.Time { return t.t.C }

func (t *realTicker) Stop() { t.t.Stop() }

// periodicRunner is the Start/Stop/Wait lifecycle every cleaner shares: one
// goroutine calls the sweep on each tick until Stop or context cancellation.
// A failed or panicking sweep is logged and counted, and the loop continues.
type periodicRunner struct {
	name         string
	interval     time.Duration
	ticker       ticker
	newTicker    func(time.Duration) ticker
	stopCh       chan struct{}
	wakeCh       chan struct{}
	wg           sync.WaitGroup
	mu           sync.Mutex
	running      bool
	initialSweep bool
}

// init sets up the runner. A non-positive interval falls back to fallback:
// time.NewTicker panics on d<=0 and Start builds the ticker synchronously, so
// a misconfigured duration would otherwise crash the server at boot.
func (r *periodicRunner) init(name string, interval, fallback time.Duration) {
	if interval <= 0 {
		interval = fallback
	}
	r.name = name
	r.interval = interval
	r.stopCh = make(chan struct{})
	r.wakeCh = make(chan struct{}, 1)
	r.newTicker = func(d time.Duration) ticker {
		return &realTicker{t: time.NewTicker(d)}
	}
}

func (r *periodicRunner) start(ctx context.Context, sweep func(context.Context) error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running {
		return
	}
	r.running = true
	r.ticker = r.newTicker(r.interval)
	r.wg.Add(1)
	go r.loop(ctx, r.ticker, sweep)
}

func (r *periodicRunner) loop(ctx context.Context, t ticker, sweep func(context.Context) error) {
	defer r.wg.Done()
	defer t.Stop()
	if r.initialSweep {
		// Deploys can restart more often than the interval. Retention must
		// not depend on a process surviving its first tick.
		r.runSweep(ctx, sweep)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.stopCh:
			return
		case <-t.Chan():
			r.runSweep(ctx, sweep)
		case <-r.wakeCh:
			r.runSweep(ctx, sweep)
		}
	}
}

func (r *periodicRunner) runSweep(ctx context.Context, sweep func(context.Context) error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			r.recordFailure(fmt.Errorf("panic: %v", recovered))
		}
	}()
	if err := sweep(ctx); err != nil {
		r.recordFailure(err)
	}
}

func (r *periodicRunner) recordFailure(err error) {
	slog.Warn("cleanup sweep failed", "cleaner", r.name, "error", err)
	SweepFailures.WithLabelValues(r.name).Inc()
}

// Stop stops the runner and blocks until the current sweep completes. It is
// safe to call concurrently and more than once.
func (r *periodicRunner) Stop() {
	r.mu.Lock()
	if !r.running {
		r.mu.Unlock()
		r.wg.Wait()
		return
	}
	r.running = false
	close(r.stopCh)
	r.mu.Unlock()
	r.wg.Wait()
}

// Wait blocks until the loop has exited.
func (r *periodicRunner) Wait() {
	r.wg.Wait()
}
