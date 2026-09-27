package services

import (
	"context"
	"errors"
	"io"
	"log/slog"
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

func workflowSandboxZQueries() *mockWorkflowSandboxSchedulerQuerier {
	return &mockWorkflowSandboxSchedulerQuerier{
		getWorkflowDefinitionFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 701, RepositoryID: 601, Name: "CI", Path: ".smithers/workflows/ci.tsx"}, nil
		},
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 601, Name: "demo", UserID: pgtype.Int8{Int64: 11, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(context.Context, int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 801, WorkflowRunID: 501, Status: "queued"}}, nil
		},
	}
}

func workflowSandboxZLogger() WorkflowSandboxSchedulerOption {
	return WithWorkflowSandboxSchedulerLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestWorkflowSandboxScheduler_Z_ConstructorStartAndPollGuards(t *testing.T) {
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_TIMEOUT", "1s")
	worker := newRunnableWorkflowSandboxScheduler(t,
		&mockWorkflowSandboxSchedulerQuerier{},
		&mockWorkflowSandboxVMClient{},
		func(w *WorkflowSandboxSchedulerWorker) {
			w.timeout = 0
			w.vcpuCount = 0
			w.memoryMB = 0
			w.rootfsSizeMB = 0
			w.limit = 0
			w.interval = 0
		},
	)
	assert.Equal(t, defaultWorkflowSandboxTimeout, worker.timeout)
	assert.Equal(t, defaultWorkflowSandboxVCPUCount, worker.vcpuCount)
	assert.Equal(t, defaultWorkflowSandboxMemoryMB, worker.memoryMB)
	assert.Equal(t, defaultWorkflowSandboxRootfsMB, worker.rootfsSizeMB)
	assert.Equal(t, defaultWorkflowSandboxSchedulerClaim, worker.limit)
	assert.Equal(t, defaultWorkflowSandboxSchedulerInterval, worker.interval)

	// A panicking poll must not stop the loop: the scheduler recovers, keeps
	// polling, and only stops when the context is cancelled.
	panicCtx, panicCancel := context.WithCancel(context.Background())
	defer panicCancel()
	panicPolls := 0
	panicWorker := newRunnableWorkflowSandboxScheduler(t, &mockWorkflowSandboxSchedulerQuerier{
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
	cancelWorker := newRunnableWorkflowSandboxScheduler(t, &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			cancelCancel()
			return nil, context.Canceled
		},
	}, &mockWorkflowSandboxVMClient{}, workflowSandboxZLogger())
	cancelWorker.Start(cancelCtx)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	errorThenStopWorker := newRunnableWorkflowSandboxScheduler(t, &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			return nil, errors.New("poll failed")
		},
	}, &mockWorkflowSandboxVMClient{}, workflowSandboxZLogger())
	errorThenStopWorker.Start(ctx)

	assert.Error(t, (&WorkflowSandboxSchedulerWorker{}).PollOnce(context.Background()))
	assert.Error(t, newRunnableWorkflowSandboxScheduler(t, &mockWorkflowSandboxSchedulerQuerier{}, nil).PollOnce(context.Background()))

	claimedCtx, claimedCancel := context.WithCancel(context.Background())
	claimedCancel()
	claimedWorker := newRunnableWorkflowSandboxScheduler(t, &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(context.Context, int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{workflowSandboxZRun()}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	assert.ErrorIs(t, claimedWorker.PollOnce(claimedCtx), context.Canceled)
}

func TestWorkflowSandboxScheduler_Z_ExecuteRunFailureBranches(t *testing.T) {
	ctx := context.Background()
	run := workflowSandboxZRun()

	q := workflowSandboxZQueries()
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{}, errors.New("repo failed")
	}
	err := newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.Error(t, err)

	q = workflowSandboxZQueries()
	q.listWorkflowStepsByRunIDFn = func(context.Context, int64) ([]db.WorkflowStep, error) {
		return nil, errors.New("steps failed")
	}
	err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test")).executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.Error(t, err)

	q = workflowSandboxZQueries()
	err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.Error(t, err)

	q = workflowSandboxZQueries()
	secretInjector := NewSecretInjector(&mockSecretInjectionQuerier{
		getRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("secrets repo failed")
		},
	}, nil)
	err = newRunnableWorkflowSandboxScheduler(t,
		q,
		&mockWorkflowSandboxVMClient{},
		WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"),
		WithWorkflowSandboxSchedulerSecretInjector(secretInjector),
	).executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.Error(t, err)

	q = workflowSandboxZQueries()
	createErrWorker := newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, errors.New("create failed")
		},
	}, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"))
	err = createErrWorker.executeRun(ctx, testWorkflowSandboxRunClaim(run))
	require.Error(t, err)

	q = workflowSandboxZQueries()
	deleteErrWorker := newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{
		deleteVMFn: func(context.Context, string) error {
			return errors.New("delete failed")
		},
	}, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"), workflowSandboxZLogger())
	require.NoError(t, deleteErrWorker.executeRun(ctx, testWorkflowSandboxRunClaim(run)))

	q = workflowSandboxZQueries()
	q.markWorkflowRunSuccessFn = func(context.Context, int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, errors.New("mark success failed")
	}
	markSuccessWorker := newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"))
	require.Error(t, markSuccessWorker.executeRun(ctx, testWorkflowSandboxRunClaim(run)))
}

func TestWorkflowSandboxScheduler_Z_FinalizeStepCloneOwnerAndEnvBranches(t *testing.T) {
	ctx := context.Background()

	q := workflowSandboxZQueries()
	q.markWorkflowRunFailureFn = func(context.Context, int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, errors.New("mark failure failed")
	}
	worker := newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{})
	assert.ErrorContains(t, worker.finalizeFailure(ctx, testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 501}), 0, "failed"), "mark failure failed")

	q = workflowSandboxZQueries()
	worker = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{})
	assert.ErrorContains(t, worker.finalizeFailure(ctx, testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 501}), 0, " "), "workflow sandbox run failed")

	worker.finalizeTimeout = 0
	finalizeCtx, cancel := worker.finalizeContext(ctx)
	defer cancel()
	deadline, ok := finalizeCtx.Deadline()
	require.True(t, ok)
	assert.WithinDuration(t, time.Now().Add(workflowSandboxFinalizeTimeout), deadline, time.Second)

	q = workflowSandboxZQueries()
	q.listWorkflowStepsByRunIDFn = func(context.Context, int64) ([]db.WorkflowStep, error) {
		return nil, errors.New("list failed")
	}
	_, err := newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).ensureRunningStep(ctx, 501)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.listWorkflowStepsByRunIDFn = func(context.Context, int64) ([]db.WorkflowStep, error) { return nil, nil }
	q.createWorkflowStepFn = func(context.Context, db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
		return db.WorkflowStep{}, errors.New("create failed")
	}
	_, err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).ensureRunningStep(ctx, 501)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	var revoked bool
	q.deleteAccessTokenFn = func(context.Context, db.DeleteAccessTokenParams) error {
		revoked = true
		return nil
	}
	_, _, _, err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}, WithWorkflowSandboxSchedulerGitBaseURL("://bad")).
		buildCloneURL(ctx, 42, "alice", "demo", 11)
	require.Error(t, err)
	assert.True(t, revoked)

	q = workflowSandboxZQueries()
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{}, errors.New("repo failed")
	}
	_, _, _, err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).resolveRepositoryOwner(ctx, 601)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.getUserByIDFn = func(context.Context, int64) (db.User, error) {
		return db.User{}, errors.New("user failed")
	}
	_, _, _, err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).resolveRepositoryOwner(ctx, 601)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.getRepoByIDFn = func(context.Context, int64) (db.Repository, error) {
		return db.Repository{ID: 601, Name: "demo", OrgID: pgtype.Int8{Int64: 9, Valid: true}}, nil
	}
	q.getOrgByIDFn = func(context.Context, int64) (db.Organization, error) {
		return db.Organization{}, errors.New("org failed")
	}
	_, _, _, err = newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).resolveRepositoryOwner(ctx, 601)
	assert.Error(t, err)

	q = workflowSandboxZQueries()
	q.insertWorkflowRunLogNextSequenceFn = func(context.Context, db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error) {
		return db.InsertWorkflowRunLogNextSequenceRow{}, errors.New("insert failed")
	}
	assert.Error(t, newRunnableWorkflowSandboxScheduler(t, q, &mockWorkflowSandboxVMClient{}).appendLog(ctx, 501, 801, "system", "entry"))

	t.Setenv("WORKFLOW_SANDBOX_Z_INT32", "bad")
	t.Setenv("WORKFLOW_SANDBOX_Z_INT64", "bad")
	assert.Equal(t, int32(12), envInt32("WORKFLOW_SANDBOX_Z_INT32", 12))
	assert.Equal(t, int64(34), envInt64("WORKFLOW_SANDBOX_Z_INT64", 34))

	_, err = buildPublicRepoCloneURL("localhost:3000", "alice", "demo")
	assert.Error(t, err)
}
