package services

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// countingMythicalLauncher counts every admission a worker attempts, so a
// duplicate the fake launcher refuses still shows up as a second attempt.
type countingMythicalLauncher struct {
	inner    *fakeMythicalLauncher
	mu       sync.Mutex
	attempts map[string]int
}

func (l *countingMythicalLauncher) AdmitInTx(ctx context.Context, tx pgx.Tx, request flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	l.mu.Lock()
	if l.attempts == nil {
		l.attempts = map[string]int{}
	}
	l.attempts[request.FlowID]++
	l.mu.Unlock()
	return l.inner.AdmitInTx(ctx, tx, request)
}

func (l *countingMythicalLauncher) count(flowID string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.attempts[flowID]
}

// mythicalWorker is another backend replica over the same database and
// repo host: its own service and scratch, the same GitHub, dispatch and lanes.
func (o *mythicalOrchestration) mythicalWorker(launcher mythicalLauncher) *MythicalService {
	o.t.Helper()
	worker := NewMythicalService(o.pool, o.host)
	worker.scratchRoot = filepath.Join(o.t.TempDir(), "scratch")
	worker.SetOrchestration(o.github, launcher, o.lanes)
	worker.EnableTodoAdmission()
	worker.SetPolicyReader(policyHost{mythicalPolicy("")})
	return worker
}

func (o *mythicalOrchestration) admittedTodo(number int64) {
	o.t.Helper()
	require.NoError(o.t, seedMythicalIssue(o.service, context.Background(), o.repoID, mythicalIssue{Number: number, Title: "Add docs",
		State: "open", TextByMaintainer: true, Body: "Please add a docs page.", Labels: []string{"todo"}}, maintainerTodo))
	require.Equal(o.t, "queued", o.item(number).State)
}

// One authorized TODO starts one coding run however many replicas pass over
// it at once, and a worker that loses its lease mid-pass launches nothing the
// replica that took the stack over already launched.
func TestMythicalConcurrentWorkersLaunchOneTodoOnce(t *testing.T) {
	o := newMythicalOrchestration(t)
	launcher := &countingMythicalLauncher{inner: o.launcher}
	o.service.SetOrchestration(o.github, launcher, o.lanes)
	o.admittedTodo(7)
	workers := []*MythicalService{o.service, o.mythicalWorker(launcher), o.mythicalWorker(launcher)}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for round := 0; round < 3; round++ {
		_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
		require.NoError(t, err)
		var wg sync.WaitGroup
		errs := make(chan error, 2*len(workers))
		for _, worker := range workers {
			for range 2 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					worker.MainMoved(ctx, o.repoID)
					errs <- worker.PollOnce(ctx)
				}()
			}
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			require.NoError(t, err)
		}
	}
	require.NoError(t, ctx.Err())
	item := o.item(7)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.lanes.created, 1, "one lane for one TODO")
	require.Equal(t, 1, launcher.count("coding/request"), "one admission attempt, never a refused duplicate")
	require.Len(t, o.launcher.requests, 1)
	require.Equal(t, o.lanes.created[0], o.launcher.last("coding/request").Target.WorkspaceID)
}

func TestMythicalWorkerThatLosesItsLeaseMidPassLaunchesNothingTwice(t *testing.T) {
	o := newMythicalOrchestration(t)
	launcher := &countingMythicalLauncher{inner: o.launcher}
	o.service.SetOrchestration(o.github, launcher, o.lanes)
	o.admittedTodo(7)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	takeover := o.mythicalWorker(launcher)
	var once sync.Once
	var takeoverErr error
	// While the first worker starts the lane, its lease expires and another
	// replica claims the stack and runs a whole pass over the same TODO.
	o.lanes.provision = func(string) {
		once.Do(func() {
			if _, err := o.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE repository_id = $1`, o.repoID); err != nil {
				takeoverErr = err
				return
			}
			takeover.MainMoved(ctx, o.repoID)
			takeoverErr = takeover.PollOnce(ctx)
		})
	}
	o.wake()
	require.NoError(t, takeoverErr)
	require.NoError(t, ctx.Err())
	o.lanes.provision = nil
	o.wake()
	item := o.item(7)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.launcher.requests, 1, "one coding run for one TODO")
	require.Equal(t, 1, launcher.count("coding/request"), "the stale worker never attempts the launch again")
	require.EqualValues(t, 1, item.Attempt)
	stack, err := db.New(o.pool).GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, stack.Claim, int64(3), "the takeover claimed the stack between the stale worker's claim and the last pass")
}

// A TODO admitted before a restart is still queued after it and launches
// once on the next worker.
func TestMythicalQueuedTodoSurvivesARestartAndLaunchesOnce(t *testing.T) {
	o := newMythicalOrchestration(t)
	o.admittedTodo(7)
	launcher := &countingMythicalLauncher{inner: o.launcher}
	restarted := o.mythicalWorker(launcher)
	o.service = restarted
	o.wake()
	o.wake()
	require.Equal(t, "running", o.item(7).State)
	require.Equal(t, 1, launcher.count("coding/request"))
	require.Len(t, o.launcher.requests, 1)
}
