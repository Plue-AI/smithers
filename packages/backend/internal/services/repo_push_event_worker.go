package services

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const (
	defaultRepoPushEventWorkerInterval = 2 * time.Second
	// Jobs run concurrently: one push's hour-long history import must not
	// hold back workflow dispatch for the pushes behind it.
	defaultRepoPushEventWorkerConcurrency = 16

	repoPushEventMaxAttempts      = int32(8)
	repoPushEventRetryBaseBackoff = 5 * time.Second
	repoPushEventRetryMaxBackoff  = 10 * time.Minute

	// A claimed job heartbeats while it runs; one whose worker died stops
	// heartbeating and is re-pended after the stall window.
	repoPushEventHeartbeat    = time.Minute
	repoPushEventStalledAfter = 5 * time.Minute
)

// RepoPushEventWorkerQuerier holds the repo_push_events queue queries.
type RepoPushEventWorkerQuerier interface {
	ClaimPendingRepoPushEvents(ctx context.Context, claimLimit int32) ([]db.RepoPushEvent, error)
	MarkRepoPushEventStepDone(ctx context.Context, arg db.MarkRepoPushEventStepDoneParams) (int64, error)
	TouchRepoPushEvent(ctx context.Context, arg db.TouchRepoPushEventParams) (int64, error)
	MarkRepoPushEventDone(ctx context.Context, arg db.MarkRepoPushEventDoneParams) (int64, error)
	MarkRepoPushEventFailed(ctx context.Context, arg db.MarkRepoPushEventFailedParams) (int64, error)
	RetryRepoPushEvent(ctx context.Context, arg db.RetryRepoPushEventParams) (int64, error)
	ResetStalledRepoPushEvents(ctx context.Context, olderThanSeconds float64) (int64, error)
}

// RepoPushEventProcessor runs the side effects of one push event, skipping
// steps already in event.StepsDone and calling markStep after each success.
// It calls releaseSlot once only a slow step it may wait on remains; the job
// then keeps its claim and heartbeat but frees its worker slot, so pushes to
// other repositories are still claimed.
type RepoPushEventProcessor interface {
	ProcessRepoPushEvent(ctx context.Context, event db.RepoPushEvent, markStep func(context.Context, string) error, releaseSlot func()) error
}

// RepoPushEventWorker drains repo_push_events: webhooks, change sync,
// workflow runs and search indexing for every push repo-host reported.
type RepoPushEventWorker struct {
	queries     RepoPushEventWorkerQuerier
	processor   RepoPushEventProcessor
	logger      *slog.Logger
	interval    time.Duration
	heartbeat   time.Duration
	concurrency int

	slots   chan struct{}
	running sync.WaitGroup
}

func NewRepoPushEventWorker(queries RepoPushEventWorkerQuerier, processor RepoPushEventProcessor) *RepoPushEventWorker {
	return &RepoPushEventWorker{
		queries:     queries,
		processor:   processor,
		logger:      slog.Default(),
		interval:    defaultRepoPushEventWorkerInterval,
		heartbeat:   repoPushEventHeartbeat,
		concurrency: defaultRepoPushEventWorkerConcurrency,
	}
}

// Start polls until ctx ends, then waits for in-flight jobs. A job cut off
// by shutdown stays 'processing' and the stall sweep re-pends it.
func (w *RepoPushEventWorker) Start(ctx context.Context) {
	w.logger.Info("repo push event worker started")
	defer w.running.Wait()
	for {
		if err := w.PollOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			w.logger.Error("repo push event worker poll error", "error", err)
		}
		select {
		case <-ctx.Done():
			w.logger.Info("repo push event worker stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

// PollOnce re-pends stalled jobs and starts as many pending jobs as there
// are free worker slots. It does not wait for them; Wait does.
func (w *RepoPushEventWorker) PollOnce(ctx context.Context) error {
	if w == nil || w.queries == nil || w.processor == nil {
		return nil
	}
	if w.slots == nil {
		w.slots = make(chan struct{}, max(1, w.concurrency))
	}

	if reclaimed, err := w.queries.ResetStalledRepoPushEvents(ctx, repoPushEventStalledAfter.Seconds()); err != nil {
		w.logger.Error("failed to reset stalled repo push events", "error", err)
	} else if reclaimed > 0 {
		w.logger.Warn("reclaimed stalled repo push events", "count", reclaimed)
	}

	free := cap(w.slots) - len(w.slots)
	if free <= 0 {
		return nil
	}
	events, err := w.queries.ClaimPendingRepoPushEvents(ctx, int32(free))
	if err != nil {
		return fmt.Errorf("claim repo push events: %w", err)
	}
	for _, event := range events {
		w.slots <- struct{}{}
		w.running.Add(1)
		go func(event db.RepoPushEvent) {
			defer w.running.Done()
			releaseSlot := sync.OnceFunc(func() { <-w.slots })
			defer releaseSlot()
			w.runJob(ctx, event, releaseSlot)
		}(event)
	}
	return nil
}

// Wait blocks until every job PollOnce started has finished.
func (w *RepoPushEventWorker) Wait() { w.running.Wait() }

func (w *RepoPushEventWorker) runJob(ctx context.Context, event db.RepoPushEvent, releaseSlot func()) {
	jobCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		w.heartbeatJob(jobCtx, event)
	}()

	markStep := func(ctx context.Context, step string) error {
		if _, err := w.queries.MarkRepoPushEventStepDone(ctx, db.MarkRepoPushEventStepDoneParams{
			Step: step, ID: event.ID, ExpectedAttempts: event.Attempts,
		}); err != nil {
			return fmt.Errorf("record step %s done: %w", step, err)
		}
		return nil
	}

	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("panic: %v", r)
			}
		}()
		err = w.processor.ProcessRepoPushEvent(jobCtx, event, markStep, releaseSlot)
	}()
	cancel()
	<-heartbeatDone
	w.finishJob(ctx, event, err)
}

func (w *RepoPushEventWorker) heartbeatJob(ctx context.Context, event db.RepoPushEvent) {
	ticker := time.NewTicker(w.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := w.queries.TouchRepoPushEvent(ctx, db.TouchRepoPushEventParams{ID: event.ID, ExpectedAttempts: event.Attempts}); err != nil && ctx.Err() == nil {
				w.logger.Warn("repo push event heartbeat failed", "event_id", event.ID, "error", err)
			}
		}
	}
}

func (w *RepoPushEventWorker) finishJob(ctx context.Context, event db.RepoPushEvent, err error) {
	// Finishing uses a context that outlives shutdown so a completed job is
	// not re-run just because the worker stopped as it finished.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	attrs := []any{"event_id", event.ID, "delivery_id", event.DeliveryID, "repo_id", event.RepositoryID, "ref", event.RefName, "attempts", event.Attempts}

	if err == nil {
		if n, markErr := w.queries.MarkRepoPushEventDone(writeCtx, db.MarkRepoPushEventDoneParams{ID: event.ID, ExpectedAttempts: event.Attempts}); markErr != nil {
			w.logger.Error("failed to mark repo push event done", append(attrs, "error", markErr)...)
		} else if n == 0 {
			w.logger.Warn("repo push event claim lost before done", attrs...)
		}
		return
	}

	if event.Attempts >= repoPushEventMaxAttempts {
		if _, markErr := w.queries.MarkRepoPushEventFailed(writeCtx, db.MarkRepoPushEventFailedParams{
			Error: err.Error(), ID: event.ID, ExpectedAttempts: event.Attempts,
		}); markErr != nil {
			w.logger.Error("failed to mark repo push event failed", append(attrs, "error", markErr)...)
		}
		w.logger.Error("repo push event failed permanently", append(attrs, "error", err)...)
		return
	}

	backoff := repoPushEventRetryBackoff(event.Attempts)
	if _, retryErr := w.queries.RetryRepoPushEvent(writeCtx, db.RetryRepoPushEventParams{
		Error: err.Error(), BackoffSeconds: backoff.Seconds(), ID: event.ID, ExpectedAttempts: event.Attempts,
	}); retryErr != nil {
		// The row stays 'processing'; the stall sweep re-pends it.
		w.logger.Error("failed to re-pend repo push event", append(attrs, "error", retryErr)...)
		return
	}
	w.logger.Warn("repo push event failed, will retry", append(attrs, "backoff", backoff.String(), "error", err)...)
}

// repoPushEventRetryBackoff doubles per claim (attempts >= 1 after a claim).
func repoPushEventRetryBackoff(attempts int32) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	shift := uint(attempts - 1)
	if shift > 16 {
		return repoPushEventRetryMaxBackoff
	}
	backoff := repoPushEventRetryBaseBackoff << shift
	if backoff > repoPushEventRetryMaxBackoff {
		return repoPushEventRetryMaxBackoff
	}
	return backoff
}
