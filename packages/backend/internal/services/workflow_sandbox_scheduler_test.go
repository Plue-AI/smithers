package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"path"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type mockWorkflowSandboxSchedulerQuerier struct {
	claimQueuedWorkflowRunsFn          func(ctx context.Context, limitCount int32) ([]db.WorkflowRun, error)
	markWorkflowRunSuccessFn           func(ctx context.Context, id int64) (db.WorkflowRun, error)
	markWorkflowRunFailureFn           func(ctx context.Context, id int64) (db.WorkflowRun, error)
	resumeWorkflowRunFn                func(ctx context.Context, id int64) error
	renewWorkflowSandboxClaimFn        func(ctx context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error)
	getWorkflowDefinitionFn            func(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	getRepoByIDFn                      func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn                      func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                       func(ctx context.Context, id int64) (db.Organization, error)
	getOrgCredentialOwnerIDFn          func(ctx context.Context, id int64) (int64, error)
	listWorkflowStepsByRunIDFn         func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	createWorkflowStepFn               func(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	updateWorkflowStepStatusRunningFn  func(ctx context.Context, stepID int64) (int64, error)
	updateWorkflowStepStatusTerminalFn func(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	insertWorkflowRunLogNextSequenceFn func(ctx context.Context, arg db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error)
	notifyWorkflowRunLogFn             func(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error
	notifyWorkflowRunEventFn           func(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	createAccessTokenFn                func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	deleteAccessTokenFn                func(ctx context.Context, arg db.DeleteAccessTokenParams) error
	updateWorkflowRunJJHubTokenIDFn    func(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error
	clearWorkflowRunJJHubTokenIDFn     func(ctx context.Context, id int64) error
	cancelWorkflowTasksFn              func(ctx context.Context, workflowRunID int64) error
	getWorkflowRunJJHubTokenIDFn       func(ctx context.Context, id int64) (pgtype.Int8, error)
	// NixOS CI plane (workflow_nix_ci.go). Unset, the run carries no task
	// graph and the scheduler keeps the single-VM orchestrator path.
	listTaskStepInfoForRunFn       func(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	getWorkflowTaskFn              func(ctx context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error)
	markWorkflowTaskVMRunningFn    func(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	markWorkflowTaskTerminalByIDFn func(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error)
	unblockWorkflowTaskFn          func(ctx context.Context, id int64) error
	skipBlockedWorkflowTaskFn      func(ctx context.Context, id int64) error

	markSuccessIDs         []int64
	markFailureIDs         []int64
	markSuccessParams      []runtimeports.MarkWorkflowRunSuccessParams
	markFailureParams      []runtimeports.MarkWorkflowRunFailureParams
	resumeRunIDs           []int64
	renewClaimParams       []runtimeports.RenewWorkflowSandboxClaimParams
	cancelTaskIDs          []int64
	terminalSteps          []db.UpdateWorkflowStepStatusTerminalParams
	logInserts             []db.InsertWorkflowRunLogNextSequenceParams
	logNotifies            []db.NotifyWorkflowRunLogParams
	runNotifies            []db.NotifyWorkflowRunEventParams
	nextLogID              int64
	claimLeaseExpiresAt    time.Time
	deleteAccessTokenCalls []db.DeleteAccessTokenParams
	clearJJHubTokenIDCalls []int64
	updateAgentTokenCalls  []db.UpdateWorkflowRunAgentTokenParams

	// The NixOS CI executor runs a run's jobs concurrently, so every recorder
	// this mock writes from a task goroutine is mutex-guarded.
	mu             sync.Mutex
	taskVMRunning  []db.MarkWorkflowTaskVMRunningParams
	terminalTasks  []db.MarkWorkflowTaskTerminalByIDParams
	unblockedTasks []int64
	skippedTasks   []int64
}

func (m *mockWorkflowSandboxSchedulerQuerier) UnblockWorkflowTask(ctx context.Context, id int64) error {
	m.mu.Lock()
	m.unblockedTasks = append(m.unblockedTasks, id)
	m.mu.Unlock()
	if m.unblockWorkflowTaskFn != nil {
		return m.unblockWorkflowTaskFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) SkipBlockedWorkflowTask(ctx context.Context, id int64) error {
	m.mu.Lock()
	m.skippedTasks = append(m.skippedTasks, id)
	m.mu.Unlock()
	if m.skipBlockedWorkflowTaskFn != nil {
		return m.skipBlockedWorkflowTaskFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetOrgCredentialOwnerID(ctx context.Context, id int64) (int64, error) {
	if m.getOrgCredentialOwnerIDFn != nil {
		return m.getOrgCredentialOwnerIDFn(ctx, id)
	}
	return 0, pgx.ErrNoRows
}

func (m *mockWorkflowSandboxSchedulerQuerier) ClaimQueuedWorkflowRuns(ctx context.Context, limitCount int32) ([]runtimeports.ClaimQueuedWorkflowRunsRow, error) {
	if m.claimQueuedWorkflowRunsFn != nil {
		runs, err := m.claimQueuedWorkflowRunsFn(ctx, limitCount)
		if err != nil {
			return nil, err
		}
		claims := make([]runtimeports.ClaimQueuedWorkflowRunsRow, 0, len(runs))
		for _, run := range runs {
			claim := testWorkflowSandboxClaimRow(run)
			if !m.claimLeaseExpiresAt.IsZero() {
				claim.ClaimLeaseExpiresAt = pgtype.Timestamptz{Time: m.claimLeaseExpiresAt, Valid: true}
			}
			claims = append(claims, claim)
		}
		return claims, nil
	}
	return nil, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) MarkWorkflowRunSuccess(ctx context.Context, arg runtimeports.MarkWorkflowRunSuccessParams) (db.WorkflowRun, error) {
	m.markSuccessIDs = append(m.markSuccessIDs, arg.ID)
	m.markSuccessParams = append(m.markSuccessParams, arg)
	if m.markWorkflowRunSuccessFn != nil {
		return m.markWorkflowRunSuccessFn(ctx, arg.ID)
	}
	return db.WorkflowRun{ID: arg.ID, Status: "success"}, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) MarkWorkflowRunFailure(ctx context.Context, arg runtimeports.MarkWorkflowRunFailureParams) (db.WorkflowRun, error) {
	m.markFailureIDs = append(m.markFailureIDs, arg.ID)
	m.markFailureParams = append(m.markFailureParams, arg)
	if m.markWorkflowRunFailureFn != nil {
		return m.markWorkflowRunFailureFn(ctx, arg.ID)
	}
	return db.WorkflowRun{ID: arg.ID, Status: "failure"}, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) ResumeWorkflowRun(ctx context.Context, id int64) error {
	m.resumeRunIDs = append(m.resumeRunIDs, id)
	if m.resumeWorkflowRunFn != nil {
		return m.resumeWorkflowRunFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) RenewWorkflowSandboxClaim(ctx context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
	m.renewClaimParams = append(m.renewClaimParams, arg)
	if m.renewWorkflowSandboxClaimFn != nil {
		return m.renewWorkflowSandboxClaimFn(ctx, arg)
	}
	return pgtype.Timestamptz{Time: time.Now().Add(2 * time.Minute), Valid: true}, nil
}

func testWorkflowSandboxClaimRow(run db.WorkflowRun) runtimeports.ClaimQueuedWorkflowRunsRow {
	return runtimeports.ClaimQueuedWorkflowRunsRow{
		ID:                   run.ID,
		RepositoryID:         run.RepositoryID,
		WorkflowDefinitionID: run.WorkflowDefinitionID,
		TriggerRef:           run.TriggerRef,
		TriggerCommitSha:     run.TriggerCommitSha,
		TriggerEvent:         run.TriggerEvent,
		ClaimToken:           stringToUUID("00000000-0000-4000-8000-000000000001"),
		ClaimGeneration:      1,
		ClaimLeaseExpiresAt:  pgtype.Timestamptz{Time: time.Now().Add(2 * time.Minute), Valid: true},
	}
}

func testWorkflowSandboxRunClaim(run db.WorkflowRun) workflowSandboxRunClaim {
	return workflowSandboxRunClaimFromRow(testWorkflowSandboxClaimRow(run))
}

func (m *mockWorkflowSandboxSchedulerQuerier) CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error {
	m.cancelTaskIDs = append(m.cancelTaskIDs, workflowRunID)
	if m.cancelWorkflowTasksFn != nil {
		return m.cancelWorkflowTasksFn(ctx, workflowRunID)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	if m.getWorkflowDefinitionFn != nil {
		return m.getWorkflowDefinitionFn(ctx, arg)
	}
	return db.WorkflowDefinition{}, pgx.ErrNoRows
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, pgx.ErrNoRows
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{}, pgx.ErrNoRows
}

func (m *mockWorkflowSandboxSchedulerQuerier) ListWorkflowStepsByRunID(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if m.listWorkflowStepsByRunIDFn != nil {
		return m.listWorkflowStepsByRunIDFn(ctx, runID)
	}
	return nil, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
	if m.createWorkflowStepFn != nil {
		return m.createWorkflowStepFn(ctx, arg)
	}
	return db.WorkflowStep{}, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error) {
	if m.updateWorkflowStepStatusRunningFn != nil {
		return m.updateWorkflowStepStatusRunningFn(ctx, stepID)
	}
	return 1, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
	m.mu.Lock()
	m.terminalSteps = append(m.terminalSteps, arg)
	m.mu.Unlock()
	if m.updateWorkflowStepStatusTerminalFn != nil {
		return m.updateWorkflowStepStatusTerminalFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) InsertWorkflowRunLogNextSequence(ctx context.Context, arg db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error) {
	m.mu.Lock()
	m.logInserts = append(m.logInserts, arg)
	m.mu.Unlock()
	if m.insertWorkflowRunLogNextSequenceFn != nil {
		return m.insertWorkflowRunLogNextSequenceFn(ctx, arg)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextLogID++
	return db.InsertWorkflowRunLogNextSequenceRow{
		ID:             m.nextLogID,
		WorkflowRunID:  arg.WorkflowRunID,
		WorkflowStepID: arg.WorkflowStepID,
		Sequence:       m.nextLogID,
		Stream:         arg.Stream,
		Entry:          arg.Entry,
	}, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) NotifyWorkflowRunLog(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error {
	m.mu.Lock()
	m.logNotifies = append(m.logNotifies, arg)
	m.mu.Unlock()
	if m.notifyWorkflowRunLogFn != nil {
		return m.notifyWorkflowRunLogFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error {
	m.mu.Lock()
	m.runNotifies = append(m.runNotifies, arg)
	m.mu.Unlock()
	if m.notifyWorkflowRunEventFn != nil {
		return m.notifyWorkflowRunEventFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	if m.createAccessTokenFn != nil {
		return m.createAccessTokenFn(ctx, arg)
	}
	return db.AccessToken{ID: 1}, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error {
	m.deleteAccessTokenCalls = append(m.deleteAccessTokenCalls, arg)
	if m.deleteAccessTokenFn != nil {
		return m.deleteAccessTokenFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) UpdateWorkflowRunJJHubTokenID(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error {
	if m.updateWorkflowRunJJHubTokenIDFn != nil {
		return m.updateWorkflowRunJJHubTokenIDFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) ClearWorkflowRunJJHubTokenID(ctx context.Context, id int64) error {
	m.clearJJHubTokenIDCalls = append(m.clearJJHubTokenIDCalls, id)
	if m.clearWorkflowRunJJHubTokenIDFn != nil {
		return m.clearWorkflowRunJJHubTokenIDFn(ctx, id)
	}
	return nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error) {
	if m.getWorkflowRunJJHubTokenIDFn != nil {
		return m.getWorkflowRunJJHubTokenIDFn(ctx, id)
	}
	return pgtype.Int8{}, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) UpdateWorkflowRunAgentToken(_ context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
	m.updateAgentTokenCalls = append(m.updateAgentTokenCalls, arg)
	return db.WorkflowRun{ID: arg.ID}, nil
}

type mockWorkflowSandboxVMClient struct {
	createVMFn  func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	execAwaitFn func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	deleteVMFn  func(ctx context.Context, vmID string) error

	// The NixOS CI executor boots one guest per job concurrently, so the call
	// recorders are mutex-guarded.
	mu          sync.Mutex
	createCalls []sandbox.CreateRequest
	execCalls   []sandbox.ExecRequest
	deleteCalls []string
}

func (m *mockWorkflowSandboxVMClient) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	m.mu.Lock()
	m.createCalls = append(m.createCalls, req)
	m.mu.Unlock()
	if m.createVMFn != nil {
		return m.createVMFn(ctx, req)
	}
	return sandbox.CreateResult{ID: "vm-1"}, nil
}

func (m *mockWorkflowSandboxVMClient) Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	m.mu.Lock()
	m.execCalls = append(m.execCalls, req)
	m.mu.Unlock()
	if m.execAwaitFn != nil {
		return m.execAwaitFn(ctx, vmID, req)
	}
	success := int32(0)
	return sandbox.ExecResult{StatusCode: &success}, nil
}

func (m *mockWorkflowSandboxVMClient) DeleteSandbox(ctx context.Context, vmID string) error {
	m.mu.Lock()
	m.deleteCalls = append(m.deleteCalls, vmID)
	m.mu.Unlock()
	if m.deleteVMFn != nil {
		return m.deleteVMFn(ctx, vmID)
	}
	return nil
}

func TestWorkflowSandboxSchedulerWorker_PollOnce_NoQueuedRuns(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{}
	sandboxClient := &mockWorkflowSandboxVMClient{}
	worker := NewWorkflowSandboxSchedulerWorker(queries, sandboxClient)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, sandboxClient.createCalls)
	assert.Empty(t, queries.markSuccessIDs)
	assert.Empty(t, queries.markFailureIDs)
}

func TestWorkflowSandboxSchedulerWorker_PollOnce_Success(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   42,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
				TriggerCommitSha:     "deadbeef",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			assert.Equal(t, int64(7), arg.ID)
			assert.Equal(t, int64(100), arg.RepositoryID)
			return db.WorkflowDefinition{
				ID:           7,
				RepositoryID: 100,
				Name:         "CI",
				Path:         "flows/ci/flow.ts",
			}, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			assert.Equal(t, int64(100), id)
			return db.Repository{
				ID:     100,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			assert.Equal(t, int64(11), id)
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, runID int64) ([]db.WorkflowStep, error) {
			assert.Equal(t, int64(42), runID)
			return []db.WorkflowStep{{ID: 9, WorkflowRunID: 42, Status: "queued"}}, nil
		},
	}

	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			require.NotNil(t, req.VCPUCount)
			require.NotNil(t, req.MemSizeMB)
			require.NotNil(t, req.RootfsSizeMB)
			assert.EqualValues(t, 2, *req.VCPUCount)
			assert.EqualValues(t, 4096, *req.MemSizeMB)
			assert.EqualValues(t, 2048, *req.RootfsSizeMB)
			assert.Contains(t, req.Packages, "git")
			assert.Contains(t, req.Packages, "nodejs_26")
			assert.Contains(t, req.Files[defaultWorkflowSandboxRunnerSH].Content, "node_modules/@smthrs/cli/bin/smithers.mjs")
			assert.Contains(t, req.Files[defaultWorkflowSandboxRunnerSH].Content, "SMITHERS_WORKFLOW_RUN_ID")
			assert.NotNil(t, req.Init)
			require.Len(t, req.Init.Services, 1)
			assert.NotEmpty(t, req.Init.Services[0].Env["SMITHERS_JJHUB_TOKEN"])
			assert.Equal(t, "https://api.smithers.test/api", req.Init.Services[0].Env["SMITHERS_JJHUB_API_URL"])
			assert.NotNil(t, req.Persistence)
			// Leak backstop: the ephemeral workflow VM self-reclaims if the pod
			// dies before the deferred DeleteSandbox, and the idle window sits above the
			// max run budget so it never reaps a live run.
			require.NotNil(t, req.IdleTimeoutSeconds)
			assert.Greater(t, *req.IdleTimeoutSeconds, int64(maxWorkflowSandboxTimeout/time.Second))
			assert.NotNil(t, req.WaitForReady)
			require.NotNil(t, req.Firewall)
			assert.Equal(t, "deny", req.Firewall.DefaultEgressAction)
			return sandbox.CreateResult{ID: "vm-success"}, nil
		},
		execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			assert.Equal(t, "vm-success", vmID)
			assert.Contains(t, req.Command, "systemctl start")
			assert.NotContains(t, req.Command, "then &&")
			success := int32(0)
			return sandbox.ExecResult{
				Stdout:     "hello workflow\n",
				StatusCode: &success,
			}, nil
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.Equal(t, []int64{42}, queries.markSuccessIDs)
	require.Len(t, queries.markSuccessParams, 1)
	assert.Equal(t, "00000000-0000-4000-8000-000000000001", queries.markSuccessParams[0].ClaimToken)
	assert.Equal(t, int64(1), queries.markSuccessParams[0].ClaimGeneration)
	assert.Empty(t, queries.markFailureIDs)
	assert.Equal(t, []int64{42}, queries.cancelTaskIDs, "dispatched runner tasks must be terminalized with the run")
	require.NotEmpty(t, queries.terminalSteps)
	assert.Equal(t, "success", queries.terminalSteps[len(queries.terminalSteps)-1].Status)
	assert.NotEmpty(t, queries.logInserts)
	assert.NotEmpty(t, queries.logNotifies)
	assert.Equal(t, []string{"vm-success"}, sandboxClient.deleteCalls)
}

func TestWorkflowSandboxSchedulerWorker_PollOnce_ExecFailureMarksRunFailure(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   84,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     100,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 12, WorkflowRunID: 84, Status: "queued"}}, nil
		},
	}

	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-failure"}, nil
		},
		execAwaitFn: func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			exitCode := int32(1)
			return sandbox.ExecResult{
				Stdout:     "boom\n",
				StatusCode: &exitCode,
			}, nil
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll should continue after per-run failures")

	assert.Empty(t, queries.markSuccessIDs)
	assert.Equal(t, []int64{84}, queries.markFailureIDs)
	assert.Equal(t, []int64{84}, queries.cancelTaskIDs, "dispatched runner tasks must be terminalized with the run")
	require.NotEmpty(t, queries.terminalSteps)
	assert.Equal(t, "failure", queries.terminalSteps[len(queries.terminalSteps)-1].Status)
	assert.Equal(t, []string{"vm-failure"}, sandboxClient.deleteCalls)
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_ExecFailureRevokesCredentials pins
// issue #178: finalizeFailure must revoke the run's live agent token and any
// persisted per-run jjhub API token, not just terminalize the run/step rows.
func TestWorkflowSandboxSchedulerWorker_PollOnce_ExecFailureRevokesCredentials(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   84,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     100,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 12, WorkflowRunID: 84, Status: "queued"}}, nil
		},
		markWorkflowRunFailureFn: func(_ context.Context, id int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: id, RepositoryID: 100, Status: "failure"}, nil
		},
		getWorkflowRunJJHubTokenIDFn: func(_ context.Context, _ int64) (pgtype.Int8, error) {
			return pgtype.Int8{Int64: 555, Valid: true}, nil
		},
	}

	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-failure"}, nil
		},
		execAwaitFn: func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			exitCode := int32(1)
			return sandbox.ExecResult{
				Stdout:     "boom\n",
				StatusCode: &exitCode,
			}, nil
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll should continue after per-run failures")

	assert.Equal(t, []int64{84}, queries.markFailureIDs)
	require.NotEmpty(t, queries.updateAgentTokenCalls)
	last := queries.updateAgentTokenCalls[len(queries.updateAgentTokenCalls)-1]
	assert.False(t, last.AgentTokenHash.Valid)
	assert.Equal(t, int64(84), last.ID)

	// The scheduler also revokes its own short-lived clone/push/mint tokens
	// (each defaulting to id=1 from the mock's CreateAccessToken) as part of
	// normal run teardown; assert only that RevokeWorkflowRunCredentials did
	// its part: the persisted jjhub_token_id (555) got revoked for the
	// repo-owner user.
	require.NotEmpty(t, queries.deleteAccessTokenCalls)
	var revokedPersistedToken bool
	for _, call := range queries.deleteAccessTokenCalls {
		assert.Equal(t, int64(11), call.UserID)
		if call.ID == 555 {
			revokedPersistedToken = true
		}
	}
	assert.True(t, revokedPersistedToken, "expected the persisted jjhub_token_id (555) to be revoked")
	assert.Contains(t, queries.clearJJHubTokenIDCalls, int64(84))
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_CreateNoCapacityRequeuesRun pins
// the capacity-refusal contract: when the sandbox control plane refuses
// placement because the fleet is full (HTTP 503, code no_capacity), the run
// must return to a re-claimable 'queued' state — never terminal failure — so a
// later poll retries it once a guest slot frees. Ownership is released through
// the same claim-fenced write failRun uses (its DB trigger clears
// workflow_sandbox_claims), then ResumeWorkflowRun flips failure -> queued,
// leaving the row immediately re-claimable in its original created_at order.
func TestWorkflowSandboxSchedulerWorker_PollOnce_CreateNoCapacityRequeuesRun(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(88, 22)
	var order []string
	queries.markWorkflowRunFailureFn = func(_ context.Context, id int64) (db.WorkflowRun, error) {
		order = append(order, "release_claim")
		return db.WorkflowRun{ID: id, RepositoryID: 100, Status: "failure"}, nil
	}
	queries.resumeWorkflowRunFn = func(_ context.Context, _ int64) error {
		order = append(order, "resume")
		return nil
	}

	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			// The exact refusal the microsandbox client decodes from the
			// controller's structured 503 envelope when the fleet is full.
			return sandbox.CreateResult{}, &sandbox.StatusError{
				StatusCode: http.StatusServiceUnavailable,
				ErrorCode:  "no_capacity",
				Code:       "no_capacity",
				Message:    "no healthy Microsandbox worker has sufficient capacity",
			}
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "a capacity refusal must not fail the poll")

	// The claim-fenced release must precede the failure -> queued flip:
	// ResumeWorkflowRun matches only cancelled/failure rows, so this order is
	// what leaves the run 'queued' instead of terminally failed.
	assert.Equal(t, []string{"release_claim", "resume"}, order)
	assert.Equal(t, []int64{88}, queries.resumeRunIDs, "capacity-refused run must return to the queued pool")
	require.Len(t, queries.markFailureParams, 1)
	assert.Equal(t, "00000000-0000-4000-8000-000000000001", queries.markFailureParams[0].ClaimToken)
	assert.Equal(t, int64(1), queries.markFailureParams[0].ClaimGeneration)

	// None of the terminal-failure side effects may fire.
	assert.Empty(t, queries.markSuccessIDs)
	assert.Empty(t, queries.terminalSteps, "requeue must not terminalize the step")
	assert.Empty(t, queries.cancelTaskIDs, "requeue must not cancel the run's tasks")
	for _, notify := range queries.runNotifies {
		assert.NotContains(t, notify.Payload, "workflow_sandbox.failure",
			"a requeued run must not emit a terminal failure event")
	}

	// A placement refusal means no VM exists: nothing to exec or delete.
	assert.Empty(t, sandboxClient.execCalls)
	assert.Empty(t, sandboxClient.deleteCalls)
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_CreateErrorStillFailsTerminally
// pins the unchanged half of the capacity contract: a create error that is NOT
// a fleet-capacity refusal keeps failing the run terminally, exactly as today.
func TestWorkflowSandboxSchedulerWorker_PollOnce_CreateErrorStillFailsTerminally(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(89, 23)
	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, &sandbox.StatusError{
				StatusCode: http.StatusInternalServerError,
				ErrorCode:  "internal_error",
				Message:    "worker exploded",
			}
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll should continue after per-run failures")

	assert.Equal(t, []int64{89}, queries.markFailureIDs)
	assert.Empty(t, queries.resumeRunIDs, "non-capacity create errors must not requeue")
	assert.Equal(t, []int64{89}, queries.cancelTaskIDs, "dispatched runner tasks must be terminalized with the run")
	require.NotEmpty(t, queries.terminalSteps)
	assert.Equal(t, "failure", queries.terminalSteps[len(queries.terminalSteps)-1].Status)
	assert.Empty(t, queries.markSuccessIDs)
	assert.Empty(t, sandboxClient.execCalls)
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_ExecNoCapacityStillFailsTerminally
// guards the branch boundary: a no_capacity-flavored error AFTER a successful
// create is an execute failure, not a placement refusal — the VM exists and
// the run keeps today's terminal semantics (and the VM is still torn down).
func TestWorkflowSandboxSchedulerWorker_PollOnce_ExecNoCapacityStillFailsTerminally(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(90, 24)
	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-exec-capacity"}, nil
		},
		execAwaitFn: func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return sandbox.ExecResult{}, &sandbox.StatusError{
				StatusCode: http.StatusServiceUnavailable,
				ErrorCode:  "no_capacity",
				Code:       "no_capacity",
				Message:    "no healthy Microsandbox worker has sufficient capacity",
			}
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll should continue after per-run failures")

	assert.Equal(t, []int64{90}, queries.markFailureIDs)
	assert.Empty(t, queries.resumeRunIDs, "only placement refusals requeue; execute errors stay terminal")
	assert.Equal(t, []string{"vm-exec-capacity"}, sandboxClient.deleteCalls, "the created VM must still be torn down")
	assert.Empty(t, queries.markSuccessIDs)
}

// newSandboxSchedulerRunQuerier builds a querier mock that claims a single run
// and satisfies the definition/repo/user/step lookups executeRun performs.
func newSandboxSchedulerRunQuerier(runID, stepID int64) *mockWorkflowSandboxSchedulerQuerier {
	return &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   runID,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     100,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: stepID, WorkflowRunID: runID, Status: "queued"}}, nil
		},
	}
}

// TestWorkflowSandboxSchedulerWorker_PollOnceRecovering_ConvertsPanicToError
// pins the fix for the scheduler permanently exiting after a panic: a panic
// anywhere in a poll becomes an ordinary error so Start's loop keeps running.
func TestWorkflowSandboxSchedulerWorker_PollOnceRecovering_ConvertsPanicToError(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			panic("claim exploded")
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})

	err := worker.pollOnceRecovering(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "panicked")
	assert.Contains(t, err.Error(), "claim exploded")
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_PanicDuringRunMarksFailure pins
// per-run panic recovery: a panic while executing one claimed run terminalizes
// that run as failed instead of propagating (which would both skip the rest of
// the batch and leave the run stuck 'running').
func TestWorkflowSandboxSchedulerWorker_PollOnce_PanicDuringRunMarksFailure(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(61, 13)
	queries.getWorkflowDefinitionFn = func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
		panic("malformed workflow definition")
	}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		&mockWorkflowSandboxVMClient{},
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll must survive a per-run panic")
	assert.Equal(t, []int64{61}, queries.markFailureIDs, "panicked run must be terminalized as failure")
	assert.Empty(t, queries.markSuccessIDs)
}

// TestWorkflowSandboxSchedulerWorker_Start_SurvivesDeadlineFlavoredPollError
// pins the residual issue #140 hardening: pgx/pgconn wraps transient DB
// connect timeouts as context.DeadlineExceeded, so Start must not treat a
// DeadlineExceeded-flavored poll error as a shutdown signal when the
// scheduler's own context is still live. Only ctx.Err() may stop the loop.
func TestWorkflowSandboxSchedulerWorker_Start_SurvivesDeadlineFlavoredPollError(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	calls := 0
	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			mu.Lock()
			calls++
			n := calls
			mu.Unlock()
			if n == 1 {
				return nil, fmt.Errorf("connect: %w", context.DeadlineExceeded)
			}
			cancel()
			return nil, nil
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})
	worker.interval = time.Millisecond

	done := make(chan struct{})
	go func() {
		worker.Start(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not stop after context cancellation")
	}

	mu.Lock()
	defer mu.Unlock()
	assert.GreaterOrEqual(t, calls, 2, "Start must survive a DeadlineExceeded-flavored poll error and keep polling until real ctx cancellation")
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_ShutdownFailsUnstartedClaimedRuns
// pins the shutdown path: claimed runs already flipped to 'running' must not be
// stranded when cancellation arrives before they execute — they are
// terminalized (resumable failure) instead.
func TestWorkflowSandboxSchedulerWorker_PollOnce_ShutdownFailsUnstartedClaimedRuns(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			// Shutdown lands between the claim and the processing loop.
			cancel()
			return []db.WorkflowRun{
				{ID: 71, RepositoryID: 100, WorkflowDefinitionID: 7, TriggerRef: "main"},
				{ID: 72, RepositoryID: 100, WorkflowDefinitionID: 7, TriggerRef: "main"},
			}, nil
		},
	}
	sandboxClient := &mockWorkflowSandboxVMClient{}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)

	err := worker.PollOnce(ctx)
	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, []int64{71, 72}, queries.markFailureIDs, "claimed-but-unstarted runs must be terminalized on shutdown")
	assert.Empty(t, sandboxClient.createCalls, "no VM may be created after shutdown")
}

func TestWorkflowSandboxSchedulerWorker_LostLeaseCancelsStaleExecution(t *testing.T) {
	t.Parallel()

	renewed := make(chan runtimeports.RenewWorkflowSandboxClaimParams, 1)
	queries := newSandboxSchedulerRunQuerier(53, 17)
	queries.renewWorkflowSandboxClaimFn = func(_ context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
		select {
		case renewed <- arg:
		default:
		}
		return pgtype.Timestamptz{}, pgx.ErrNoRows
	}
	queries.markWorkflowRunFailureFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	sandboxClient := &mockWorkflowSandboxVMClient{
		execAwaitFn: func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			<-ctx.Done()
			return sandbox.ExecResult{}, ctx.Err()
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	worker.claimHeartbeat = time.Millisecond

	require.NoError(t, worker.PollOnce(context.Background()))
	select {
	case arg := <-renewed:
		assert.Equal(t, int64(53), arg.ID)
		assert.Equal(t, "00000000-0000-4000-8000-000000000001", arg.ClaimToken)
		assert.Equal(t, int64(1), arg.ClaimGeneration)
	default:
		t.Fatal("expected the worker to renew and detect its lost claim")
	}
	assert.Equal(t, []string{"vm-1"}, sandboxClient.deleteCalls, "a stale worker must tear down its VM")
	require.Len(t, queries.markFailureParams, 1)
	assert.Equal(t, int64(1), queries.markFailureParams[0].ClaimGeneration)
}

func TestWorkflowSandboxSchedulerWorker_RenewalErrorsCancelAtClaimExpiry(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(54, 18)
	queries.claimLeaseExpiresAt = time.Now().Add(500 * time.Millisecond)
	queries.renewWorkflowSandboxClaimFn = func(_ context.Context, _ runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
		return pgtype.Timestamptz{}, errors.New("database unavailable")
	}
	queries.markWorkflowRunFailureFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	sandboxClient := &mockWorkflowSandboxVMClient{
		execAwaitFn: func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			<-ctx.Done()
			return sandbox.ExecResult{}, ctx.Err()
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	worker.claimHeartbeat = 50 * time.Millisecond

	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Greater(t, len(queries.renewClaimParams), 1, "transient renewal failures should retry while the confirmed lease remains valid")
	assert.Equal(t, []string{"vm-1"}, sandboxClient.deleteCalls, "expiry of the last confirmed lease must tear down the VM")
}

func TestWorkflowSandboxSchedulerWorker_BlockedRenewalCannotOutliveClaim(t *testing.T) {
	t.Parallel()

	renewalCanceled := make(chan struct{}, 1)
	queries := newSandboxSchedulerRunQuerier(55, 19)
	queries.claimLeaseExpiresAt = time.Now().Add(500 * time.Millisecond)
	queries.renewWorkflowSandboxClaimFn = func(ctx context.Context, _ runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
		<-ctx.Done()
		renewalCanceled <- struct{}{}
		return pgtype.Timestamptz{}, ctx.Err()
	}
	queries.markWorkflowRunFailureFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	sandboxClient := &mockWorkflowSandboxVMClient{
		execAwaitFn: func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			<-ctx.Done()
			return sandbox.ExecResult{}, ctx.Err()
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	worker.claimHeartbeat = 50 * time.Millisecond

	require.NoError(t, worker.PollOnce(context.Background()))
	select {
	case <-renewalCanceled:
	default:
		t.Fatal("the in-flight renewal must be cancelled at the confirmed lease deadline")
	}
	assert.Equal(t, []string{"vm-1"}, sandboxClient.deleteCalls, "a blocked renewal must not keep the VM alive past ownership expiry")
}

// TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsSuccessFinalization
// pins the lost terminal-state race: when MarkWorkflowRunSuccess matches no row
// (a concurrent cancel already terminalized the run), the worker must not mark
// the step success, cancel tasks, or emit a terminal sandbox event.
func TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsSuccessFinalization(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(51, 14)
	queries.markWorkflowRunSuccessFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		&mockWorkflowSandboxVMClient{},
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)
	assert.Empty(t, queries.terminalSteps, "step status must not be overwritten after losing the terminal race")
	assert.Empty(t, queries.cancelTaskIDs, "tasks must not be cancelled after losing the terminal race")
	for _, notify := range queries.runNotifies {
		assert.NotContains(t, notify.Payload, "workflow_sandbox.success",
			"no terminal sandbox event may be emitted after a concurrent cancel")
		assert.NotContains(t, notify.Payload, "workflow_sandbox.failure",
			"no terminal sandbox event may be emitted after a concurrent cancel")
	}
}

// TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsFailureFinalization is
// the failure-path twin: an exec failure racing a concurrent cancel must not
// overwrite the cancelled run's step or emit workflow_sandbox.failure.
func TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsFailureFinalization(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(52, 16)
	queries.markWorkflowRunFailureFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	sandboxClient := &mockWorkflowSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			exitCode := int32(1)
			return sandbox.ExecResult{Stdout: "boom\n", StatusCode: &exitCode}, nil
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "per-run failure must not fail the poll")
	assert.Empty(t, queries.terminalSteps, "step status must not be overwritten after losing the terminal race")
	assert.Empty(t, queries.cancelTaskIDs, "tasks must not be cancelled after losing the terminal race")
	for _, notify := range queries.runNotifies {
		assert.NotContains(t, notify.Payload, "workflow_sandbox.success",
			"no terminal sandbox event may be emitted after a concurrent cancel")
		assert.NotContains(t, notify.Payload, "workflow_sandbox.failure",
			"no terminal sandbox event may be emitted after a concurrent cancel")
	}
}

// TestWorkflowSandboxSchedulerWorker_RedactsSecretsInRunLogs mirrors
// RunnerService.StreamEvents_RedactsRepoSecretsBeforeInsert for the sandbox
// path: repository secrets, the per-run jjhub API token, and the clone token
// must never reach workflow_run_logs (or the SSE notify payload) verbatim,
// while non-sensitive repository variables are left readable.
func TestWorkflowSandboxSchedulerWorker_RedactsSecretsInRunLogs(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   99,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{
				ID:     id,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 21, WorkflowRunID: 99, Status: "queued"}}, nil
		},
	}

	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{
				{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("sk-ant-super-secret")},
			}, nil
		},
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "PUBLIC_VAR", Value: "public-variable-value"}}, nil
		},
	}, webhook.NoopSecretCodec{})

	sandboxClient := &mockWorkflowSandboxVMClient{}
	sandboxClient.execAwaitFn = func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
		require.NotEmpty(t, sandboxClient.createCalls)
		created := sandboxClient.createCalls[0]

		// Recover the injected per-run jjhub token from the operation-scoped
		// service environment, and the clone token from the git URL.
		require.NotNil(t, created.Init)
		require.Len(t, created.Init.Services, 1)
		jjhubToken := created.Init.Services[0].Env["SMITHERS_JJHUB_TOKEN"]
		require.NotEmpty(t, jjhubToken)
		require.NotEmpty(t, created.GitRepos)
		cloneURL, err := url.Parse(created.GitRepos[0].Repo)
		require.NoError(t, err)
		cloneToken, _ := cloneURL.User.Password()
		require.NotEmpty(t, cloneToken)

		exitCode := int32(0)
		return sandbox.ExecResult{
			Stdout:     "repo secret: sk-ant-super-secret\njjhub token: " + jjhubToken + "\npublic: public-variable-value\n",
			Stderr:     "clone token: " + cloneToken + "\n",
			StatusCode: &exitCode,
		}, nil
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
		WithWorkflowSandboxSchedulerSecretInjector(injector),
	)
	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	require.NotEmpty(t, queries.logInserts)
	var sawRedactedSecret, sawRedactedJJHub, sawRedactedClone, sawPublicVariable bool
	for _, insert := range queries.logInserts {
		assert.NotContains(t, insert.Entry, "sk-ant-super-secret")
		assert.NotRegexp(t, `smithers_[0-9a-f]{40}`, insert.Entry)
		switch {
		case strings.HasPrefix(insert.Entry, "repo secret:"):
			sawRedactedSecret = strings.Contains(insert.Entry, "********")
		case strings.HasPrefix(insert.Entry, "jjhub token:"):
			sawRedactedJJHub = strings.Contains(insert.Entry, "********")
		case strings.HasPrefix(insert.Entry, "clone token:"):
			sawRedactedClone = strings.Contains(insert.Entry, "********")
		case strings.HasPrefix(insert.Entry, "public:"):
			sawPublicVariable = strings.Contains(insert.Entry, "public-variable-value")
		}
	}
	assert.True(t, sawRedactedSecret, "repository secret value must be masked in run logs")
	assert.True(t, sawRedactedJJHub, "per-run jjhub token must be masked in run logs")
	assert.True(t, sawRedactedClone, "clone token must be masked in run logs")
	assert.True(t, sawPublicVariable, "non-sensitive repository variables must remain readable")

	for _, notify := range queries.logNotifies {
		assert.NotContains(t, notify.Payload, "sk-ant-super-secret")
	}
}

func TestWorkflowSandboxSchedulerWorker_PollOnce_TimeoutMarksFailureWithFinalizationContext(t *testing.T) {
	t.Parallel()

	failureCtxErrs := make([]error, 0, 1)
	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   96,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     100,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 15, WorkflowRunID: 96, Status: "queued"}}, nil
		},
		markWorkflowRunFailureFn: func(ctx context.Context, id int64) (db.WorkflowRun, error) {
			failureCtxErrs = append(failureCtxErrs, ctx.Err())
			return db.WorkflowRun{ID: id, Status: "failure"}, nil
		},
	}

	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-timeout"}, nil
		},
		execAwaitFn: func(ctx context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			<-ctx.Done()
			return sandbox.ExecResult{}, ctx.Err()
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	worker.timeout = 20 * time.Millisecond

	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll should continue after per-run timeout failures")

	assert.Equal(t, []int64{96}, queries.markFailureIDs)
	assert.Len(t, failureCtxErrs, 1)
	assert.NoError(t, failureCtxErrs[0], "terminal failure updates must not use canceled run context")
	assert.Equal(t, []string{"vm-timeout"}, sandboxClient.deleteCalls)

	var foundTimeoutLog bool
	for _, logInsert := range queries.logInserts {
		if strings.Contains(logInsert.Entry, "exceeded timeout") {
			foundTimeoutLog = true
			break
		}
	}
	assert.True(t, foundTimeoutLog, "timeout should be reflected in persisted run logs")
}

func TestNewWorkflowSandboxSchedulerWorker_ClampsTimeoutToMax(t *testing.T) {
	t.Setenv("SMITHERS_WORKFLOW_SANDBOX_TIMEOUT", "45m")
	worker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{}, &mockWorkflowSandboxVMClient{})
	assert.Equal(t, maxWorkflowSandboxTimeout, worker.timeout)
}

func TestWorkflowSandboxSchedulerWorker_PollOnce_ClaimError(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return nil, errors.New("db unavailable")
		},
	}
	worker := NewWorkflowSandboxSchedulerWorker(queries, &mockWorkflowSandboxVMClient{})

	err := worker.PollOnce(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "db unavailable")
}

func TestClampWorkflowSandboxTimeout_DefaultAndMax(t *testing.T) {
	t.Parallel()

	assert.Equal(t, defaultWorkflowSandboxTimeout, clampWorkflowSandboxTimeout(0))
	assert.Equal(t, maxWorkflowSandboxTimeout, clampWorkflowSandboxTimeout(2*time.Hour))
	assert.Equal(t, 5*time.Minute, clampWorkflowSandboxTimeout(5*time.Minute))
}

func TestWorkflowSandboxFirewallPolicy_EmptyAllowListStillDeniesEgress(t *testing.T) {
	t.Parallel()

	worker := &WorkflowSandboxSchedulerWorker{}
	policy := worker.buildFirewallPolicy()

	require.NotNil(t, policy)
	assert.Equal(t, "deny", policy.DefaultEgressAction)
	assert.Empty(t, policy.EgressAllow)
}

func TestWorkflowSandboxExecCommand_ProducesValidMultilineScript(t *testing.T) {
	t.Parallel()

	cmd := workflowSandboxExecCommand()
	assert.Contains(t, cmd, "systemctl start")
	assert.Contains(t, cmd, "\nif systemctl is-failed --quiet")
	assert.NotContains(t, cmd, "then &&")
	assert.NotContains(t, cmd, "fi &&")
}

func TestWorkflowSandboxRunnerScript_UsesNpmCLI(t *testing.T) {
	t.Parallel()
	script := workflowSandboxRunnerScript(42, "flows/ci/flow.ts")
	assert.Contains(t, script, `exec node "$cli_dir/node_modules/@smthrs/cli/bin/smithers.mjs" flow start 'ci' --root '/workspace/repo'`)
	assert.NotContains(t, script, "smithers-orchestrator")
	assert.NotContains(t, script, "bun x")
}

func TestWorkflowSandboxRunnerScript_ExportsRunMetadata(t *testing.T) {
	t.Parallel()

	script := workflowSandboxRunnerScript(42, "flows/ci/flow.ts")
	assert.Contains(t, script, `SMITHERS_WORKFLOW_RUN_ID='42'`)
	assert.Contains(t, script, `SMITHERS_WORKFLOW_ROOT='/workspace/repo'`)
	assert.Contains(t, script, `SMITHERS_WORKFLOW_PATH='/workspace/repo/flows/ci/flow.ts'`)
}

func TestWorkflowSandboxRunnerScript_QuotesWorkflowPath(t *testing.T) {
	t.Parallel()

	workflowPath := ".smithers/workflows/o'clock$(printf injected >&2)`printf backtick >&2`\\slash\nci.tsx"
	expectedPath := path.Join(defaultWorkflowSandboxWorkdir, workflowPath)

	script := workflowSandboxRunnerScript(42, workflowPath)

	assert.Contains(t, script, "export SMITHERS_WORKFLOW_PATH="+shellQuote(expectedPath))
}

func TestShellQuote_PreservesBashMetacharacters(t *testing.T) {
	t.Parallel()

	value := "o'clock$(printf injected >&2)`printf backtick >&2`\\slash\nnext"
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd := exec.Command("bash", "-c", "set -euo pipefail\nvalue="+shellQuote(value)+"\nprintf '%s' \"$value\"")
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	require.NoError(t, cmd.Run())
	assert.Equal(t, value, stdout.String())
	assert.Empty(t, stderr.String())
}

func TestWorkflowSandboxRunnerScript_InstallsNpmCLIBeforeRun(t *testing.T) {
	t.Parallel()

	script := workflowSandboxRunnerScript(42, "flows/ci/flow.ts")

	// The oneshot runs as user `smithers`; HOME may be unset under systemd.
	assert.Contains(t, script, `export HOME="${HOME:-/home/smithers}"`)

	assert.Contains(t, script, "test -s '/tmp/smithers-workspace-cli-package.b64.part0000'")
	assert.Contains(t, script, `exec node "$cli_dir/node_modules/@smthrs/cli/bin/smithers.mjs" flow start`)
	assert.NotContains(t, script, "bun x")
	assert.NotContains(t, script, "init --global")
	assert.NotContains(t, script, "--run-id")

	// The script stays fail-fast for everything else.
	assert.Contains(t, script, "set -euo pipefail")
}

// TestWorkflowSandboxRunnerScript_ScrubsCloneCredential verifies the runner
// script strips the token userinfo Microsandbox's GitRepos clone leaves in
// remote.origin.url before the workflow runs, and does so best-effort (the
// scrub must not kill the run under `set -euo pipefail`). The sed itself is
// exercised against a real shell to prove it removes exactly the userinfo.
func TestWorkflowSandboxRunnerScript_ScrubsCloneCredential(t *testing.T) {
	t.Parallel()

	script := workflowSandboxRunnerScript(42, "flows/ci/flow.ts")
	assert.Contains(t, script, "git remote get-url origin")
	assert.Contains(t, script, "git remote set-url origin")

	// Ordering: scrub happens after cd into the repo, before the runner starts.
	scrubIdx := strings.Index(script, "git remote set-url origin")
	runIdx := strings.Index(script, "exec node")
	require.GreaterOrEqual(t, scrubIdx, 0)
	require.GreaterOrEqual(t, runIdx, 0)
	assert.Less(t, scrubIdx, runIdx, "credential scrub must run before the workflow runner")

	// Prove the embedded sed strips userinfo and leaves clean URLs untouched.
	for input, want := range map[string]string{
		"https://x-access-token:smithers_deadbeef@api.smithers.test/alice/demo.git": "https://api.smithers.test/alice/demo.git",
		"https://api.smithers.test/alice/demo.git":                                  "https://api.smithers.test/alice/demo.git",
	} {
		var stdout bytes.Buffer
		cmd := exec.Command("bash", "-c",
			`printf '%s' `+shellQuote(input)+` | sed -E 's#^([a-z][a-z0-9+.-]*://)[^@/]+@#\1#'`)
		cmd.Stdout = &stdout
		require.NoError(t, cmd.Run())
		assert.Equal(t, want, stdout.String())
	}
}

func TestWorkflowSandboxFinalizeContext_IgnoresParentCancellation(t *testing.T) {
	t.Parallel()

	worker := NewWorkflowSandboxSchedulerWorker(&mockWorkflowSandboxSchedulerQuerier{}, &mockWorkflowSandboxVMClient{})
	parentCtx, cancel := context.WithCancel(context.Background())
	cancel()
	finalizeCtx, finalizeCancel := worker.finalizeContext(parentCtx)
	defer finalizeCancel()

	select {
	case <-finalizeCtx.Done():
		t.Fatalf("finalize context should ignore parent cancellation")
	default:
	}
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_LongRunStillFinalizes pins the fix
// for the finalize-context regression: the finalize budget must be minted AFTER
// the exec, not at run start. With a run that outlives the finalize budget, the
// old code (finalize context created at executeRun entry) marked neither success
// nor logs because the budget had already expired by the time exec returned.
//
// Both durations live on synctest's fake clock. The exec's Sleep advances it;
// the finalize writes never block, so it stands still while they run and the
// finalize deadline can lapse only if the product minted it before the exec.
// On the wall clock the same 20ms budget also bounded how long the host could
// stall this goroutine between minting and the success write, which is why
// the test failed once inside a loaded full-package run (#2259).
func TestWorkflowSandboxSchedulerWorker_PollOnce_LongRunStillFinalizes(t *testing.T) {
	t.Parallel()

	synctest.Test(t, testWorkflowSandboxSchedulerWorkerLongRunStillFinalizes)
}

func testWorkflowSandboxSchedulerWorkerLongRunStillFinalizes(t *testing.T) {
	var successCtxErr error
	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{
				ID:                   77,
				RepositoryID:         100,
				WorkflowDefinitionID: 7,
				TriggerRef:           "main",
			}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{ID: 100, Name: "demo", UserID: pgtype.Int8{Int64: 11, Valid: true}}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 11, Username: "alice"}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 18, WorkflowRunID: 77, Status: "queued"}}, nil
		},
		markWorkflowRunSuccessFn: func(ctx context.Context, id int64) (db.WorkflowRun, error) {
			successCtxErr = ctx.Err()
			return db.WorkflowRun{ID: id, Status: "success"}, nil
		},
	}

	sandboxClient := &mockWorkflowSandboxVMClient{
		createVMFn: func(_ context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-long"}, nil
		},
		execAwaitFn: func(_ context.Context, _ string, _ sandbox.ExecRequest) (sandbox.ExecResult, error) {
			// Run outlives the finalize budget set below. Inside the bubble this
			// advances the fake clock by 60ms instead of sleeping on the wall clock.
			time.Sleep(60 * time.Millisecond)
			success := int32(0)
			return sandbox.ExecResult{Stdout: "done\n", StatusCode: &success}, nil
		},
	}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
	)
	// A finalize budget far shorter than the exec duration: with the entry-time
	// bug it would be exhausted before finalization; minted post-exec it is fresh.
	worker.finalizeTimeout = 20 * time.Millisecond

	err := worker.PollOnce(context.Background())
	require.NoError(t, err)

	assert.NoError(t, successCtxErr, "finalize context must be unexpired when marking success")
	assert.Equal(t, []int64{77}, queries.markSuccessIDs, "long run must still be marked success")
	require.NotEmpty(t, queries.terminalSteps)
	assert.Equal(t, "success", queries.terminalSteps[len(queries.terminalSteps)-1].Status)
	assert.NotEmpty(t, queries.logInserts, "output logs must be persisted after a long run")
}

func (m *mockWorkflowSandboxSchedulerQuerier) ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error) {
	if m.listTaskStepInfoForRunFn != nil {
		return m.listTaskStepInfoForRunFn(ctx, workflowRunID)
	}
	return nil, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) GetWorkflowTask(ctx context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error) {
	if m.getWorkflowTaskFn != nil {
		return m.getWorkflowTaskFn(ctx, arg)
	}
	return db.WorkflowTask{}, pgx.ErrNoRows
}

func (m *mockWorkflowSandboxSchedulerQuerier) MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error) {
	m.mu.Lock()
	m.taskVMRunning = append(m.taskVMRunning, arg)
	m.mu.Unlock()
	if m.markWorkflowTaskVMRunningFn != nil {
		return m.markWorkflowTaskVMRunningFn(ctx, arg)
	}
	return 1, nil
}

func (m *mockWorkflowSandboxSchedulerQuerier) MarkWorkflowTaskTerminalByID(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
	m.mu.Lock()
	m.terminalTasks = append(m.terminalTasks, arg)
	m.mu.Unlock()
	if m.markWorkflowTaskTerminalByIDFn != nil {
		return m.markWorkflowTaskTerminalByIDFn(ctx, arg)
	}
	return arg.ID, nil
}

func TestWorkflowSandboxSchedulerWorker_OrgOwnedRepoClonesWithRepoBoundCredential(t *testing.T) {
	t.Parallel()

	var minted []db.CreateAccessTokenParams
	queries := &mockWorkflowSandboxSchedulerQuerier{
		claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{ID: 77, RepositoryID: 300, WorkflowDefinitionID: 7, TriggerRef: "main"}}, nil
		},
		getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 7, RepositoryID: 300, Path: "flows/ci/flow.ts"}, nil
		},
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "infra", OrgID: pgtype.Int8{Int64: 44, Valid: true}}, nil
		},
		getOrgByIDFn: func(_ context.Context, id int64) (db.Organization, error) {
			return db.Organization{ID: id, Name: "acme"}, nil
		},
		getOrgCredentialOwnerIDFn: func(_ context.Context, organizationID int64) (int64, error) {
			assert.Equal(t, int64(44), organizationID)
			return 5, nil
		},
		createAccessTokenFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			minted = append(minted, arg)
			return db.AccessToken{ID: int64(900 + len(minted))}, nil
		},
		listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
			return []db.WorkflowStep{{ID: 31, WorkflowRunID: 77, Status: "queued"}}, nil
		},
	}
	sandboxClient := &mockWorkflowSandboxVMClient{}

	worker := NewWorkflowSandboxSchedulerWorker(
		queries,
		sandboxClient,
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{77}, queries.markSuccessIDs)

	require.Len(t, sandboxClient.createCalls, 1)
	created := sandboxClient.createCalls[0]
	require.NotEmpty(t, created.GitRepos)
	cloneURL, err := url.Parse(created.GitRepos[0].Repo)
	require.NoError(t, err)
	assert.Equal(t, "/acme/infra.git", cloneURL.Path)
	require.NotNil(t, cloneURL.User, "an org-owned private repository must not be cloned anonymously")
	password, ok := cloneURL.User.Password()
	require.True(t, ok)
	assert.NotEmpty(t, password)

	require.Len(t, minted, 1, "org repositories mint only the clone credential, never the per-run api token")
	assert.Equal(t, int64(5), minted[0].UserID)
	scopes := strings.Split(minted[0].Scopes, ",")
	assert.ElementsMatch(t, []string{"read:repository", middleware.RepositoryRestrictionScope(300)}, scopes)
	require.NotNil(t, created.Init)
	require.Len(t, created.Init.Services, 1)
	assert.NotContains(t, created.Init.Services[0].Env, "SMITHERS_JJHUB_TOKEN")

	assert.Contains(t, queries.deleteAccessTokenCalls, db.DeleteAccessTokenParams{ID: 901, UserID: 5},
		"the clone credential is revoked when the run ends")
}

func TestWorkflowSandboxLogStoresBinaryOutputAsText(t *testing.T) {
	var stored string
	queries := &mockWorkflowSandboxSchedulerQuerier{
		insertWorkflowRunLogNextSequenceFn: func(_ context.Context, arg db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error) {
			stored = arg.Entry
			return db.InsertWorkflowRunLogNextSequenceRow{Entry: arg.Entry}, nil
		},
	}
	worker := &WorkflowSandboxSchedulerWorker{queries: queries}
	require.NoError(t, worker.appendLog(context.Background(), 1, 2, "stdout", "ok\x00\xff done"))
	assert.Equal(t, "ok\uFFFD\uFFFD done", stored)
}

// A main-only repository secret (D-24) reaches a sandbox run only when its
// claimed trigger is a trusted one on exactly the default bookmark.
func TestWorkflowSandboxSchedulerInjectsMainOnlySecretsOnlyIntoTrustedMainRuns(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		event, ref string
		trusted    bool
	}{
		{"push", "refs/heads/main", true},
		{"schedule", "main", true},
		{"push", "refs/heads/feature", false},
		{"landing_request", "main", false},
		{"", "main", false},
	} {
		queries := &mockWorkflowSandboxSchedulerQuerier{
			claimQueuedWorkflowRunsFn: func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
				return []db.WorkflowRun{{ID: 99, RepositoryID: 100, WorkflowDefinitionID: 7, TriggerRef: tc.ref, TriggerEvent: tc.event}}, nil
			},
			getWorkflowDefinitionFn: func(_ context.Context, _ db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
				return db.WorkflowDefinition{ID: 7, RepositoryID: 100, Path: ".smithers/workflows/ci.tsx"}, nil
			},
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				return db.Repository{ID: id, Name: "demo", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 11, Valid: true}}, nil
			},
			getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) { return db.User{ID: 11, Username: "alice"}, nil },
			listWorkflowStepsByRunIDFn: func(_ context.Context, _ int64) ([]db.WorkflowStep, error) {
				return []db.WorkflowStep{{ID: 21, WorkflowRunID: 99, Status: "queued"}}, nil
			},
		}
		injector := NewSecretInjector(&mockSecretInjectionQuerier{
			getRepoFn: func(_ context.Context, id int64) (db.Repository, error) { return db.Repository{ID: id}, nil },
			listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
				return []db.ListSecretValuesRow{{Name: "DEPLOY_TOKEN", ValueEncrypted: []byte("deploy"), MainOnly: true}, {Name: "LINT_TOKEN", ValueEncrypted: []byte("lint")}}, nil
			},
		}, webhook.NoopSecretCodec{})
		sandboxClient := &mockWorkflowSandboxVMClient{}
		worker := NewWorkflowSandboxSchedulerWorker(queries, sandboxClient,
			WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
			WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
			WithWorkflowSandboxSchedulerSecretInjector(injector))
		require.NoError(t, worker.PollOnce(context.Background()))
		require.NotEmpty(t, sandboxClient.createCalls, "%s on %q", tc.event, tc.ref)
		require.NotNil(t, sandboxClient.createCalls[0].Init)
		env := sandboxClient.createCalls[0].Init.Services[0].Env
		assert.Equal(t, "lint", env["LINT_TOKEN"], "%s on %q", tc.event, tc.ref)
		_, got := env["DEPLOY_TOKEN"]
		assert.Equal(t, tc.trusted, got, "%s on %q", tc.event, tc.ref)
	}
}
