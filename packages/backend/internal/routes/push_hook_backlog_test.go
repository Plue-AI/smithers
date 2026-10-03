package routes

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// backlogPushQueue is an in-memory repo_push_events queue for the worker.
type backlogPushQueue struct {
	mu      sync.Mutex
	pending []db.RepoPushEvent
	steps   map[int64][]string
	done    map[int64]bool
}

func (q *backlogPushQueue) ClaimPendingRepoPushEvents(_ context.Context, limit int32) ([]db.RepoPushEvent, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := min(int(limit), len(q.pending))
	out := slices.Clone(q.pending[:n])
	for i := range out {
		out[i].Attempts++
		out[i].Status = "processing"
	}
	q.pending = q.pending[n:]
	return out, nil
}

func (q *backlogPushQueue) MarkRepoPushEventStepDone(_ context.Context, arg db.MarkRepoPushEventStepDoneParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.steps[arg.ID] = append(q.steps[arg.ID], arg.Step)
	return 1, nil
}

func (q *backlogPushQueue) TouchRepoPushEvent(context.Context, db.TouchRepoPushEventParams) (int64, error) {
	return 1, nil
}

func (q *backlogPushQueue) MarkRepoPushEventDone(_ context.Context, arg db.MarkRepoPushEventDoneParams) (int64, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.done[arg.ID] = true
	return 1, nil
}

func (q *backlogPushQueue) MarkRepoPushEventFailed(context.Context, db.MarkRepoPushEventFailedParams) (int64, error) {
	return 1, nil
}

func (q *backlogPushQueue) RetryRepoPushEvent(context.Context, db.RetryRepoPushEventParams) (int64, error) {
	return 1, nil
}

func (q *backlogPushQueue) ResetStalledRepoPushEvents(context.Context, float64) (int64, error) {
	return 0, nil
}

func (q *backlogPushQueue) stepDone(id int64, step string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return slices.Contains(q.steps[id], step)
}

func (q *backlogPushQueue) allDone(ids ...int64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, id := range ids {
		if !q.done[id] {
			return false
		}
	}
	return true
}

// #3664: a backlog of pushes to one repository whose full change sync is
// slow must not hold every worker slot. Another repository's push is still
// claimed and its workflows step runs, and the backlog shares coalesced
// syncs instead of running one full sync per push.
func TestRepoPushEventWorker_ChangeSyncBacklogDoesNotBlockOtherRepos(t *testing.T) {
	const slowRepo, fastRepo = int64(101), int64(202)
	const backlog = 40 // more than the worker's slots

	unblock := make(chan struct{})
	var mu sync.Mutex
	syncs := map[int64]int{}
	recorder := &backlogChangeRecorder{record: func(ctx context.Context, repoID int64) error {
		mu.Lock()
		syncs[repoID]++
		mu.Unlock()
		if repoID != slowRepo {
			return nil
		}
		select {
		case <-unblock:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	handler := &InternalPushHookHandler{
		RepoResolver:   &mockPushHookRepoResolver{},
		WorkflowRun:    &mockPushHookWorkflowRunner{},
		ChangeRecorder: recorder,
	}

	queue := &backlogPushQueue{steps: map[int64][]string{}, done: map[int64]bool{}}
	var ids []int64
	for i := range backlog {
		id := int64(i + 1)
		ids = append(ids, id)
		queue.pending = append(queue.pending, db.RepoPushEvent{ID: id, RepositoryID: slowRepo, Owner: "mirror", Repo: "big", RefName: "refs/heads/main", CommitSha: "abc"})
	}
	fastID := int64(backlog + 1)
	ids = append(ids, fastID)
	queue.pending = append(queue.pending, db.RepoPushEvent{ID: fastID, RepositoryID: fastRepo, Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSha: "def"})

	worker := services.NewRepoPushEventWorker(queue, handler)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		worker.Wait()
	})
	poll := func() { require.NoError(t, worker.PollOnce(ctx)) }

	deadline := time.Now().Add(5 * time.Second)
	for !queue.stepDone(fastID, PushStepWorkflows) {
		if time.Now().After(deadline) {
			close(unblock)
			t.Fatal("the other repository's workflows step never ran while the change-sync backlog held the worker")
		}
		poll()
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	running := syncs[slowRepo]
	mu.Unlock()
	assert.Equal(t, 1, running, "one full sync runs for the backlogged repository at a time")

	close(unblock)
	deadline = time.Now().Add(5 * time.Second)
	for !queue.allDone(ids...) {
		if time.Now().After(deadline) {
			t.Fatal("backlog did not drain after change sync unblocked")
		}
		poll()
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	assert.LessOrEqual(t, syncs[slowRepo], 2, "queued pushes coalesce into one running and one pending sync")
	assert.Equal(t, 1, syncs[fastRepo])
}

type backlogChangeRecorder struct {
	record func(ctx context.Context, repoID int64) error
}

func (r *backlogChangeRecorder) RecordPush(ctx context.Context, repositoryID int64, _, _ string) error {
	return r.record(ctx, repositoryID)
}

// A caller that arrives while a sync runs waits for the next sync, which
// every such caller shares, so it sees changes pushed after the running
// sync started.
func TestChangeSyncCoalescer_JoinsRunningCallersIntoOneNextSync(t *testing.T) {
	t.Parallel()

	var c changeSyncCoalescer
	unblock := make(chan struct{})
	var mu sync.Mutex
	var calls []string
	syncAs := func(name string) func(context.Context) error {
		return func(context.Context) error {
			mu.Lock()
			calls = append(calls, name)
			mu.Unlock()
			<-unblock
			return nil
		}
	}

	first := c.join(context.Background(), 101, syncAs("first"))
	second := c.join(context.Background(), 101, syncAs("second"))
	third := c.join(context.Background(), 101, syncAs("third"))
	other := c.join(context.Background(), 202, syncAs("other"))
	assert.NotSame(t, first, second)
	assert.Same(t, second, third)
	assert.NotSame(t, first, other)

	close(unblock)
	for _, run := range []*changeSyncRun{first, second, other} {
		select {
		case <-run.done:
			require.NoError(t, run.err)
		case <-time.After(5 * time.Second):
			t.Fatal("coalesced sync did not finish")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	assert.ElementsMatch(t, []string{"first", "third", "other"}, calls, "the next sync uses the latest caller's coordinates")
}
