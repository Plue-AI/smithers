package services

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

func workflowSandboxZRun() db.WorkflowRun {
	return db.WorkflowRun{
		ID:                   501,
		RepositoryID:         601,
		WorkflowDefinitionID: 701,
		TriggerRef:           "main",
		TriggerCommitSha:     "abc123",
	}
}

// workflowSandboxZQueries serves a one-job graph ("build" on step 801) for
// whichever run executeRun is handed.
func workflowSandboxZQueries() *mockWorkflowSandboxSchedulerQuerier {
	return newSandboxSchedulerRunQuerier(501, 801)
}

// workflowSandboxZWorker wires a CI guest fleet whose "build" job succeeds.
func workflowSandboxZWorker(q WorkflowSandboxSchedulerQuerier, client *mockWorkflowSandboxVMClient, opts ...WorkflowSandboxSchedulerOption) *WorkflowSandboxSchedulerWorker {
	return NewWorkflowSandboxSchedulerWorker(q, client, append([]WorkflowSandboxSchedulerOption{
		WithWorkflowSandboxSchedulerCIGuests(&fakeNixCIGuests{}),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
	}, opts...)...)
}

// workflowSandboxZClient is a guest whose job exits 0 on its first poll.
func workflowSandboxZClient() *mockWorkflowSandboxVMClient {
	return &mockWorkflowSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			ok := int32(0)
			if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
				return sandbox.ExecResult{StatusCode: &ok}, nil
			}
			return sandbox.ExecResult{Stderr: nixCITaskExitMarker + "0", StatusCode: &ok}, nil
		},
	}
}

func workflowSandboxZLogger() WorkflowSandboxSchedulerOption {
	return WithWorkflowSandboxSchedulerLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestWorkflowSandboxScheduler_Z_ConstructorStartAndPollGuards(t *testing.T) {
	worker := NewWorkflowSandboxSchedulerWorker(
		&mockWorkflowSandboxSchedulerQuerier{},
		&mockWorkflowSandboxVMClient{},
		func(w *WorkflowSandboxSchedulerWorker) {
			w.limit = 0
			w.interval = 0
		},
	)
	assert.Equal(t, defaultWorkflowSandboxSchedulerClaim, worker.limit)
	assert.Equal(t, defaultWorkflowSandboxSchedulerInterval, worker.interval)

	// A panicking poll must not stop the loop: the scheduler recovers, keeps
	// polling, and only stops when the context is cancelled.
	panicCtx, panicCancel := context.WithCancel(context.Background())
	defer panicCancel()
	panicPolls := 0
	panicWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			panicPolls++
			if panicPolls == 1 {
				panic("boom")
			}
			panicCancel()
			return nil, nil
		},
	}, &mockWorkflowSandboxVMClient{}, workflowSandboxZLogger(), func(w *WorkflowSandboxSchedulerWorker) {
		w.interval = time.Millisecond
	})
	panicDone := make(chan struct{})
	go func() {
		defer close(panicDone)
		panicWorker.Start(panicCtx)
	}()
	select {
	case <-panicDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not survive a poll panic and stop on cancellation")
	}
	assert.GreaterOrEqual(t, panicPolls, 2, "scheduler must keep polling after a panic")

	// Start must key shutdown off the scheduler's own context, not off a
	// poll error merely being (or wrapping) context.Canceled: a healthy
	// shutdown cancels ctx, and the DB layer's query then plausibly returns
	// context.Canceled too, so cancel the real context here to model that.
	cancelCtx, cancelCancel := context.WithCancel(context.Background())
	cancelWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			cancelCancel()
			return nil, context.Canceled
		},
	}, &mockWorkflowSandboxVMClient{}, workflowSandboxZLogger())
	cancelWorker.Start(cancelCtx)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	errorThenStopWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			return nil, errors.New("poll failed")
		},
	}, &mockWorkflowSandboxVMClient{}, workflowSandboxZLogger())
	errorThenStopWorker.Start(ctx)

	assert.Error(t, (&WorkflowSandboxSchedulerWorker{}).PollOnce(context.Background()))
	assert.Error(t, NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{}, nil).PollOnce(context.Background()))

	claimedCtx, claimedCancel := context.WithCancel(context.Background())
	claimedCancel()
	claimedWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{workflowSandboxZRun()}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	assert.ErrorIs(t, claimedWorker.PollOnce(claimedCtx), context.Canceled)
}

func TestWorkflowSandboxScheduler_Z_ExecuteRunFailureBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowSandboxZRun()

	// An unresolvable repository owner fails the run before any guest boots.
	q := workflowSandboxZQueries()
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{}, errors.New("repo failed")
	}
	client := workflowSandboxZClient()
	err := workflowSandboxZWorker(q, client).executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.ErrorContains(t, err, "failed to resolve workflow repository owner")
	assert.Equal(t, []int64{501}, q.markFailureIDs)
	assert.Empty(t, client.createCalls)

	// Without a git base URL no guest can clone the repository: the job fails
	// to provision and the run fails.
	q = workflowSandboxZQueries()
	client = workflowSandboxZClient()
	require.Error(t, workflowSandboxZWorker(q, client).executeRun(ctx, testWorkflowSandboxRunClaim(run)))
	assert.Equal(t, []int64{501}, q.markFailureIDs)
	assert.Empty(t, client.createCalls)
	assert.Equal(t, map[int64]string{1: "failed"}, nixCITaskStatuses(q))

	// Secrets that cannot be loaded fail the run rather than running without them.
	q = workflowSandboxZQueries()
	secretInjector := NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("secrets repo failed")
		},
	}, nil)
	client = workflowSandboxZClient()
	err = workflowSandboxZWorker(
		q,
		client,
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerSecretInjector(secretInjector),
	).executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.ErrorContains(t, err, "failed to load repository secrets")
	assert.Equal(t, []int64{501}, q.markFailureIDs)
	assert.Empty(t, client.createCalls)

	// A guest that cannot be deleted does not fail a job that succeeded.
	q = workflowSandboxZQueries()
	client = workflowSandboxZClient()
	client.deleteVMFn = func(context.Context, string) error {
		return errors.New("delete failed")
	}
	require.NoError(t, workflowSandboxZWorker(q, client, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"), workflowSandboxZLogger()).
		executeRun(ctx, testWorkflowSandboxRunClaim(run)))
	assert.Equal(t, []int64{501}, q.markSuccessIDs)
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls)

	// A failed success write surfaces as an execution error.
	q = workflowSandboxZQueries()
	q.markWorkflowRunSuccessFn = func(context.Context, int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, errors.New("mark success failed")
	}
	markSuccessWorker := workflowSandboxZWorker(q, workflowSandboxZClient(), WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"))
	require.ErrorContains(t, markSuccessWorker.executeRun(ctx, testWorkflowSandboxRunClaim(run)), "mark success failed")
}

func TestWorkflowSandboxScheduler_Z_FinalizeStepCloneOwnerAndEnvBranches(t *testing.T) {
	ctx := context.Background()

	q := workflowSandboxZQueries()
	q.markWorkflowRunFailureFn = func(context.Context, int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, errors.New("mark failure failed")
	}
	worker := NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{})
	assert.ErrorContains(t, worker.finalizeFailure(ctx, testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 501}), 0, "failed"), "mark failure failed")

	q = workflowSandboxZQueries()
	worker = NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{})
	assert.ErrorContains(t, worker.finalizeFailure(ctx, testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 501}), 0, " "), "workflow sandbox run failed")

	worker.finalizeTimeout = 0
	finalizeCtx, cancel := worker.finalizeContext(ctx)
	defer cancel()
	deadline, ok := finalizeCtx.Deadline()
	require.True(t, ok)
	assert.WithinDuration(t, time.Now().Add(workflowSandboxFinalizeTimeout), deadline, time.Second)

	q = workflowSandboxZQueries()
	var revoked bool
	q.deleteAccessTokenFn = func(context.Context, db.DeleteAccessTokenParams) error {
		revoked = true
		return nil
	}
	_, _, _, err := NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{}, WithWorkflowSandboxSchedulerGitBaseURL("://bad")).
		buildCloneURL(ctx, 42, "alice", "demo", 11)
	require.Error(t, err)
	assert.True(t, revoked)

	q = workflowSandboxZQueries()
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{}, errors.New("repo failed")
	}
	_, _, _, err = NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{}).resolveRepositoryOwner(ctx, 601)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
		return db.User{}, errors.New("user failed")
	}
	_, _, _, err = NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{}).resolveRepositoryOwner(ctx, 601)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{ID: 601, Name: "demo", OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
	}
	q.getOrgByIDFn = func(context.Context, int64) (db.Organization, error) {
		return db.Organization{}, errors.New("org failed")
	}
	_, _, _, err = NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{}).resolveRepositoryOwner(ctx, 601)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.insertWorkflowRunLogNextSequenceFn = func(context.Context, db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error) {
		return db.InsertWorkflowRunLogNextSequenceRow{}, errors.New("insert failed")
	}
	assert.Error(t, NewWorkflowSandboxSchedulerWorker(q, &mockWorkflowSandboxVMClient{}).appendLog(ctx, 501, 801, "system", "entry"))

	t.Setenv("WORKFLOW_SANDBOX_Z_INT32", "bad")
	assert.Equal(t, int32(12), envInt32("WORKFLOW_SANDBOX_Z_INT32", 12))

	_, err = buildPublicRepoCloneURL("localhost:3000", "alice", "demo")
	assert.Error(t, err)
}
