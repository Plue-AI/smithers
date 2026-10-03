package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeRepoPushEventQueue struct {
	mu        sync.Mutex
	pending   []db.RepoPushEvent
	claimed   int32
	steps     []db.MarkRepoPushEventStepDoneParams
	touches   int
	done      []db.MarkRepoPushEventDoneParams
	failed    []db.MarkRepoPushEventFailedParams
	retried   []db.RetryRepoPushEventParams
	resetArgs []float64
}

func (q *fakeRepoPushEventQueue) ClaimPendingRepoPushEvents(_ context.Context, limit int32) ([]db.RepoPushEvent, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.claimed = limit
	n := min(int(limit), len(q.pending))
	out := make([]db.RepoPushEvent, n)
	for i := range out {
		out[i] = q.pending[i]
		out[i].Attempts++
		out[i].Status = "processing"
	}
	q.pending = q.pending[n:]
	return out, nil
}

func (q *fakeRepoPushEventQueue) MarkRepoPushEventStepDone(_ context.Context, arg db.MarkRepoPushEventStepDoneParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.steps = append(q.steps, arg)
	return 1, nil
}

func (q *fakeRepoPushEventQueue) TouchRepoPushEvent(context.Context, db.TouchRepoPushEventParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.touches++
	return 1, nil
}

func (q *fakeRepoPushEventQueue) MarkRepoPushEventDone(_ context.Context, arg db.MarkRepoPushEventDoneParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.done = append(q.done, arg)
	return 1, nil
}

func (q *fakeRepoPushEventQueue) MarkRepoPushEventFailed(_ context.Context, arg db.MarkRepoPushEventFailedParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.failed = append(q.failed, arg)
	return 1, nil
}

func (q *fakeRepoPushEventQueue) RetryRepoPushEvent(_ context.Context, arg db.RetryRepoPushEventParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.retried = append(q.retried, arg)
	return 1, nil
}

func (q *fakeRepoPushEventQueue) ResetStalledRepoPushEvents(_ context.Context, olderThan float64) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.resetArgs = append(q.resetArgs, olderThan)
	return 0, nil
}

type fakeRepoPushEventProcessor struct {
	process func(ctx context.Context, event db.RepoPushEvent, markStep func(context.Context, string) error) error
}

func (p fakeRepoPushEventProcessor) ProcessRepoPushEvent(ctx context.Context, event db.RepoPushEvent, markStep func(context.Context, string) error, _ func()) error {
	return p.process(ctx, event, markStep)
}

func TestRepoPushEventWorkerMarksProcessedEventDone(t *testing.T) {
	queue := &fakeRepoPushEventQueue{pending: []db.RepoPushEvent{{ID: 7, DeliveryID: "d-7"}}}
	worker := NewRepoPushEventWorker(queue, fakeRepoPushEventProcessor{process: func(ctx context.Context, event db.RepoPushEvent, markStep func(context.Context, string) error) error {
		return markStep(ctx, "webhooks")
	}})

	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	worker.Wait()

	if len(queue.resetArgs) != 1 || queue.resetArgs[0] != repoPushEventStalledAfter.Seconds() {
		t.Fatalf("stall sweep args = %v", queue.resetArgs)
	}
	if queue.claimed != int32(defaultRepoPushEventWorkerConcurrency) {
		t.Fatalf("claimed %d, want one per free slot (%d)", queue.claimed, defaultRepoPushEventWorkerConcurrency)
	}
	wantStep := db.MarkRepoPushEventStepDoneParams{Step: "webhooks", ID: 7, ExpectedAttempts: 1}
	if len(queue.steps) != 1 || queue.steps[0] != wantStep {
		t.Fatalf("steps = %+v, want fenced %+v", queue.steps, wantStep)
	}
	if len(queue.done) != 1 || queue.done[0] != (db.MarkRepoPushEventDoneParams{ID: 7, ExpectedAttempts: 1}) {
		t.Fatalf("done = %+v", queue.done)
	}
	if len(queue.retried)+len(queue.failed) != 0 {
		t.Fatalf("unexpected retry/fail: %+v %+v", queue.retried, queue.failed)
	}
}

func TestRepoPushEventWorkerRetriesThenFailsAtMaxAttempts(t *testing.T) {
	boom := errors.New("workflow dispatch: db down")
	processor := fakeRepoPushEventProcessor{process: func(context.Context, db.RepoPushEvent, func(context.Context, string) error) error { return boom }}

	queue := &fakeRepoPushEventQueue{pending: []db.RepoPushEvent{{ID: 1, Attempts: 1}}}
	worker := NewRepoPushEventWorker(queue, processor)
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	worker.Wait()
	if len(queue.retried) != 1 {
		t.Fatalf("retried = %+v", queue.retried)
	}
	retry := queue.retried[0]
	if retry.ExpectedAttempts != 2 || retry.BackoffSeconds != repoPushEventRetryBackoff(2).Seconds() || retry.Error != boom.Error() {
		t.Fatalf("retry = %+v", retry)
	}

	queue = &fakeRepoPushEventQueue{pending: []db.RepoPushEvent{{ID: 2, Attempts: repoPushEventMaxAttempts - 1}}}
	worker = NewRepoPushEventWorker(queue, processor)
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	worker.Wait()
	if len(queue.failed) != 1 || queue.failed[0].ExpectedAttempts != repoPushEventMaxAttempts || len(queue.retried) != 0 {
		t.Fatalf("failed = %+v retried = %+v", queue.failed, queue.retried)
	}
}

// A long job heartbeats so the stall sweep does not hand it to a second
// worker while it is still running.
func TestRepoPushEventWorkerHeartbeatsLongJobs(t *testing.T) {
	release := make(chan struct{})
	queue := &fakeRepoPushEventQueue{pending: []db.RepoPushEvent{{ID: 3}}}
	worker := NewRepoPushEventWorker(queue, fakeRepoPushEventProcessor{process: func(ctx context.Context, _ db.RepoPushEvent, _ func(context.Context, string) error) error {
		<-release
		return nil
	}})
	worker.heartbeat = 5 * time.Millisecond
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		queue.mu.Lock()
		touches := queue.touches
		queue.mu.Unlock()
		if touches >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	worker.Wait()
	if queue.touches < 2 {
		t.Fatalf("touches = %d, want heartbeats while the job runs", queue.touches)
	}
	if len(queue.done) != 1 {
		t.Fatalf("done = %+v", queue.done)
	}
}

// Busy slots bound how many events one poll claims.
func TestRepoPushEventWorkerClaimsOnlyFreeSlots(t *testing.T) {
	release := make(chan struct{})
	queue := &fakeRepoPushEventQueue{pending: []db.RepoPushEvent{{ID: 1}, {ID: 2}, {ID: 3}}}
	worker := NewRepoPushEventWorker(queue, fakeRepoPushEventProcessor{process: func(context.Context, db.RepoPushEvent, func(context.Context, string) error) error {
		<-release
		return nil
	}})
	worker.concurrency = 2
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queue.claimed != 2 {
		t.Fatalf("first poll claimed limit %d, want 2", queue.claimed)
	}
	queue.claimed = -1
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queue.claimed != -1 {
		t.Fatalf("a poll with no free slot must not claim, got limit %d", queue.claimed)
	}
	close(release)
	worker.Wait()
}

func TestRepoPushEventWorkerRecoversProcessorPanic(t *testing.T) {
	queue := &fakeRepoPushEventQueue{pending: []db.RepoPushEvent{{ID: 4}}}
	worker := NewRepoPushEventWorker(queue, fakeRepoPushEventProcessor{process: func(context.Context, db.RepoPushEvent, func(context.Context, string) error) error {
		panic("boom")
	}})
	if err := worker.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	worker.Wait()
	if len(queue.retried) != 1 {
		t.Fatalf("a panicking job must be retried, got %+v", queue.retried)
	}
}
