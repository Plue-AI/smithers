package services

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkflowSandboxScheduler_Cov_OptionsEnvAndStart(t *testing.T) {
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_POLL_INTERVAL", "-1s")
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_CLAIM_LIMIT", "-3")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	injector := NewSecretInjector(nil, nil)
	worker := NewWorkflowSandboxSchedulerWorker(
		&mockWorkflowSandboxSchedulerQuerier{},
		&mockWorkflowSandboxVMClient{},
		WithWorkflowSandboxSchedulerLogger(logger),
		WithWorkflowSandboxSchedulerLogger(nil),
		WithWorkflowSandboxSchedulerAPIBaseURL(" https://api.example.test "),
		WithWorkflowSandboxSchedulerGitBaseURL(" https://git.example.test "),
		WithWorkflowSandboxSchedulerSecretInjector(injector),
	)
	assert.Same(t, logger, worker.logger)
	assert.Same(t, injector, worker.secretInjector)
	assert.Equal(t, "https://api.example.test", worker.apiBaseURL)
	assert.Equal(t, "https://git.example.test", worker.gitBaseURL)
	assert.Equal(t, defaultWorkflowSandboxSchedulerInterval, worker.interval)
	assert.Equal(t, defaultWorkflowSandboxSchedulerClaim, worker.limit)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		worker.Start(ctx)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Start did not return after context cancellation")
	}
}

func TestWorkflowSandboxScheduler_Cov_HelperBranches(t *testing.T) {
	t.Parallel()

	url, err := buildPublicRepoCloneURL("https://git.example.test/root", "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "https://git.example.test/root/alice/demo.git", url)
	_, err = buildPublicRepoCloneURL("", "alice", "demo")
	require.Error(t, err)
	_, err = buildPublicRepoCloneURL("https://git.example.test", "", "demo")
	require.Error(t, err)
	_, err = buildPublicRepoCloneURL("://bad", "alice", "demo")
	require.Error(t, err)
}

func TestWorkflowSandboxScheduler_Cov_RunPreparationAndFailureBranches(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		listTaskStepInfoForRunFn: func(context.Context, int64) ([]db.ListTaskStepInfoForRunRow, error) {
			return nil, pgx.ErrTxClosed
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})
	err := worker.executeRun(context.Background(), testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 50, RepositoryID: 60, WorkflowDefinitionID: 70}))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to load workflow job graph")
	assert.Equal(t, []int64{50}, queries.markFailureIDs)
	assert.Empty(t, queries.terminalSteps)

	orgWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", OrgID: pgtype.Int8{Int64: 44, Valid: true}}, nil
		},
		getOrgByIDFn: func(_ context.Context, id int64) (db.Organization, error) {
			assert.Equal(t, int64(44), id)
			return db.Organization{ID: id, Name: "acme"}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	repo, owner, cloneUserID, err := orgWorker.resolveRepositoryOwner(context.Background(), 90)
	require.NoError(t, err)
	assert.Equal(t, int64(90), repo.ID)
	assert.Equal(t, "acme", owner)
	assert.Zero(t, cloneUserID)

	noOwnerWorker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "orphan"}, nil
		},
	}, &mockWorkflowSandboxVMClient{})
	_, _, _, err = noOwnerWorker.resolveRepositoryOwner(context.Background(), 91)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository owner not set")
}

func TestWorkflowSandboxScheduler_Cov_CloneURLBranches(t *testing.T) {
	t.Parallel()

	worker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{
		createAccessTokenFn: func(_ context.Context, _ db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{}, fmt.Errorf("token store down")
		},
	}, &mockWorkflowSandboxVMClient{}, WithWorkflowSandboxSchedulerGitBaseURL("https://git.example.test"))

	cloneURL, cloneToken, revoke, err := worker.buildCloneURL(context.Background(), 42, "alice", "demo", 7)
	require.NoError(t, err)
	assert.Equal(t, "https://git.example.test/alice/demo.git", cloneURL)
	assert.Empty(t, cloneToken, "public fallback clone URL must not carry a token")
	require.NotNil(t, revoke)
	revoke()

	worker.gitBaseURL = ""
	_, _, _, err = worker.buildCloneURL(context.Background(), 42, "alice", "demo", 0)
	require.Error(t, err)
}
