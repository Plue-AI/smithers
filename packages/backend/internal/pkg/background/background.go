// Package background runs slow work behind an instant answer: at most one
// job per key, with a failed job answered once to the next caller who asks.
package background

import (
	"context"
	"sync"
	"time"
)

type job struct {
	done     chan struct{}
	err      error
	finished time.Time
}

// Jobs is safe for concurrent use; its zero value is ready.
type Jobs[K comparable] struct {
	// Timeout bounds a job past the request that started it; zero is none.
	Timeout time.Duration
	// FailureTTL is how long a failure waits to be answered.
	FailureTTL time.Duration

	mu   sync.Mutex
	jobs map[K]*job
}

// Failed answers a finished job's failure once, and forgets expired ones.
func (jobs *Jobs[K]) Failed(key K) error {
	jobs.mu.Lock()
	defer jobs.mu.Unlock()
	var failed error
	for other, entry := range jobs.jobs {
		select {
		case <-entry.done:
		default:
			continue
		}
		if other == key && time.Since(entry.finished) < jobs.FailureTTL {
			failed = entry.err
		}
		if other == key || time.Since(entry.finished) >= jobs.FailureTTL {
			delete(jobs.jobs, other)
		}
	}
	return failed
}

// Running answers whether key has a job that has not finished.
func (jobs *Jobs[K]) Running(key K) bool {
	jobs.mu.Lock()
	defer jobs.mu.Unlock()
	entry, ok := jobs.jobs[key]
	if !ok {
		return false
	}
	select {
	case <-entry.done:
		return false
	default:
		return true
	}
}

// Start runs work for key in the background unless key already has a job.
// The job outlives ctx's cancellation but keeps its values; a job that
// succeeds is forgotten at once.
func (jobs *Jobs[K]) Start(ctx context.Context, key K, work func(context.Context) error) bool {
	jobs.mu.Lock()
	defer jobs.mu.Unlock()
	if _, exists := jobs.jobs[key]; exists {
		return false
	}
	if jobs.jobs == nil {
		jobs.jobs = map[K]*job{}
	}
	entry := &job{done: make(chan struct{})}
	jobs.jobs[key] = entry
	go func() {
		runCtx, cancel := context.WithoutCancel(ctx), context.CancelFunc(func() {})
		if jobs.Timeout > 0 {
			runCtx, cancel = context.WithTimeout(runCtx, jobs.Timeout)
		}
		defer cancel()
		err := work(runCtx)
		jobs.mu.Lock()
		defer jobs.mu.Unlock()
		if err == nil {
			delete(jobs.jobs, key)
		} else {
			entry.err, entry.finished = err, time.Now()
		}
		close(entry.done)
	}()
	return true
}
