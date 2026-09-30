package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
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
	renewWorkflowSandboxClaimFn        func(ctx context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error)
	getRepoByIDFn                      func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn                      func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                       func(ctx context.Context, id int64) (db.Organization, error)
	getOrgCredentialOwnerIDFn          func(ctx context.Context, id int64) (int64, error)
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
	// graph and fails without booting anything.
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
	// Each CI guest revokes its own clone token from its job goroutine.
	m.mu.Lock()
	m.deleteAccessTokenCalls = append(m.deleteAccessTokenCalls, arg)
	m.mu.Unlock()
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
	if isWorkspaceArtifactCommand(req.Command) {
		code := int32(0)
		return sandbox.ExecResult{StatusCode: &code}, nil
	}
	m.mu.Lock()
	m.execCalls = append(m.execCalls, req)
	m.mu.Unlock()
	// Like the Microsandbox worker, refuse the exec-environment secret
	// channel before running anything: it persists plaintext (plue#621).
	if len(req.Secrets) > 0 {
		return sandbox.ExecResult{}, errors.New("secret_delivery_unavailable: operation-scoped secret delivery is unavailable")
	}
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

// newSandboxSchedulerRunQuerier builds a querier mock that claims a single
// sandbox-plane run whose job graph is one "build" job on the given step.
func newSandboxSchedulerRunQuerier(runID, stepID int64) *mockWorkflowSandboxSchedulerQuerier {
	task := nixCITaskRow(1, stepID, "build", nil)
	task.WorkflowRunID = runID
	queries := nixCIQuerier([]db.WorkflowTask{task})
	claim := queries.claimQueuedWorkflowRunsFn
	queries.claimQueuedWorkflowRunsFn = func(ctx context.Context, limit int32) ([]db.WorkflowRun, error) {
		runs, err := claim(ctx, limit)
		for i := range runs {
			runs[i].ID = runID
		}
		return runs, err
	}
	return queries
}

// sandboxSchedulerGuests is a fake guest fleet whose "build" job prints the
// chunks and then exits with exitCode.
func sandboxSchedulerGuests(exitCode string, chunks ...string) *fakeNixCIGuests {
	return &fakeNixCIGuests{
		polls:   map[string]int{},
		scripts: map[string]nixCIGuestScript{"build": {chunks: chunks, exitCode: exitCode}},
	}
}

func newSandboxSchedulerNixCIWorker(
	queries WorkflowSandboxSchedulerQuerier,
	client *mockWorkflowSandboxVMClient,
	opts ...WorkflowSandboxSchedulerOption,
) *WorkflowSandboxSchedulerWorker {
	return NewWorkflowSandboxSchedulerWorker(queries, client, append([]WorkflowSandboxSchedulerOption{
		WithWorkflowSandboxSchedulerGitBaseURL("https://api.smithers.test"),
		WithWorkflowSandboxSchedulerCIGuests(&fakeNixCIGuests{}),
		WithWorkflowSandboxSchedulerCIPollInterval(time.Millisecond),
	}, opts...)...)
}

// blockingNixCIGuestClient starts every job and then never reports an exit:
// each log poll blocks until the job's context ends.
func blockingNixCIGuestClient() *mockWorkflowSandboxVMClient {
	return &mockWorkflowSandboxVMClient{
		execAwaitFn: func(ctx context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
				ok := int32(0)
				return sandbox.ExecResult{StatusCode: &ok}, nil
			}
			<-ctx.Done()
			return sandbox.ExecResult{}, ctx.Err()
		},
	}
}

// nixCIStartExec returns the exec that started the job: the one carrying the
// rendered job script and the job's secrets.
func nixCIStartExec(t *testing.T, client *mockWorkflowSandboxVMClient) sandbox.ExecRequest {
	t.Helper()
	client.mu.Lock()
	defer client.mu.Unlock()
	for _, req := range client.execCalls {
		if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
			return req
		}
	}
	require.FailNow(t, "no job was started")
	return sandbox.ExecRequest{}
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_JobFailureRevokesCredentials pins
// issue #178: finalizeFailure must revoke the run's live agent token and any
// persisted per-run jjhub API token, not just terminalize the run.
func TestWorkflowSandboxSchedulerWorker_PollOnce_JobFailureRevokesCredentials(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(84, 12)
	queries.markWorkflowRunFailureFn = func(_ context.Context, id int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{ID: id, RepositoryID: 100, Status: "failure"}, nil
	}
	queries.getWorkflowRunJJHubTokenIDFn = func(_ context.Context, _ int64) (pgtype.Int8, error) {
		return pgtype.Int8{Int64: 555, Valid: true}, nil
	}
	guests := sandboxSchedulerGuests("1", "boom\n")
	worker := newSandboxSchedulerNixCIWorker(queries, guests.client(t), WithWorkflowSandboxSchedulerCIGuests(guests))

	require.NoError(t, worker.PollOnce(context.Background()), "poll should continue after per-run failures")

	assert.Equal(t, []int64{84}, queries.markFailureIDs)
	require.NotEmpty(t, queries.updateAgentTokenCalls)
	last := queries.updateAgentTokenCalls[len(queries.updateAgentTokenCalls)-1]
	assert.False(t, last.AgentTokenHash.Valid)
	assert.Equal(t, int64(84), last.ID)

	// The scheduler also revokes its own short-lived clone and per-run tokens
	// (each id=1 from the mock's CreateAccessToken) during teardown; assert
	// that RevokeWorkflowRunCredentials revoked the persisted jjhub_token_id
	// (555) for the repository owner.
	require.NotEmpty(t, queries.deleteAccessTokenCalls)
	var revokedPersistedToken bool
	for _, call := range queries.deleteAccessTokenCalls {
		assert.Equal(t, int64(9), call.UserID)
		if call.ID == 555 {
			revokedPersistedToken = true
		}
	}
	assert.True(t, revokedPersistedToken, "expected the persisted jjhub_token_id (555) to be revoked")
	assert.Contains(t, queries.clearJJHubTokenIDCalls, int64(84))
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_PanicDuringRunMarksFailure pins
// per-run panic recovery: a panic while executing one claimed run terminalizes
// that run as failed instead of propagating (which would both skip the rest of
// the batch and leave the run stuck 'running').
func TestWorkflowSandboxSchedulerWorker_PollOnce_PanicDuringRunMarksFailure(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(61, 13)
	queries.getWorkflowTaskFn = func(_ context.Context, _ db.GetWorkflowTaskParams) (db.WorkflowTask, error) {
		panic("malformed workflow task")
	}
	client := &mockWorkflowSandboxVMClient{}
	worker := newSandboxSchedulerNixCIWorker(queries, client)

	err := worker.PollOnce(context.Background())
	require.NoError(t, err, "poll must survive a per-run panic")
	assert.Equal(t, []int64{61}, queries.markFailureIDs, "panicked run must be terminalized as failure")
	assert.Empty(t, queries.markSuccessIDs)
	assert.Empty(t, client.createCalls)
}

func TestWorkflowSandboxSchedulerWorker_LostLeaseCancelsStaleExecution(t *testing.T) {
	t.Parallel()

	renewed := make(chan runtimeports.RenewWorkflowSandboxClaimParams, 1)
	jobStarted := make(chan struct{})
	queries := newSandboxSchedulerRunQuerier(53, 17)
	queries.renewWorkflowSandboxClaimFn = func(_ context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error) {
		// Keep the claim until the job is running, so the loss lands mid-job.
		select {
		case <-jobStarted:
		default:
			return pgtype.Timestamptz{Time: time.Now().Add(2 * time.Minute), Valid: true}, nil
		}
		select {
		case renewed <- arg:
		default:
		}
		return pgtype.Timestamptz{}, pgx.ErrNoRows
	}
	queries.markWorkflowRunFailureFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	client := blockingNixCIGuestClient()
	blockingExec := client.execAwaitFn
	var startOnce sync.Once
	client.execAwaitFn = func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
			startOnce.Do(func() { close(jobStarted) })
		}
		return blockingExec(ctx, vmID, req)
	}
	worker := newSandboxSchedulerNixCIWorker(queries, client)
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
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls, "a stale worker must tear down its guest")
	assert.Equal(t, map[int64]string{1: "cancelled"}, nixCITaskStatuses(queries))
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
	client := blockingNixCIGuestClient()
	worker := newSandboxSchedulerNixCIWorker(queries, client)
	worker.claimHeartbeat = 50 * time.Millisecond

	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Greater(t, len(queries.renewClaimParams), 1, "transient renewal failures should retry while the confirmed lease remains valid")
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls, "expiry of the last confirmed lease must tear down the guest")
	assert.Equal(t, map[int64]string{1: "cancelled"}, nixCITaskStatuses(queries))
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
	client := blockingNixCIGuestClient()
	worker := newSandboxSchedulerNixCIWorker(queries, client)
	worker.claimHeartbeat = 50 * time.Millisecond

	require.NoError(t, worker.PollOnce(context.Background()))
	select {
	case <-renewalCanceled:
	default:
		t.Fatal("the in-flight renewal must be cancelled at the confirmed lease deadline")
	}
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls, "a blocked renewal must not keep the guest alive past ownership expiry")
}

// assertNoTerminalRunSideEffects checks that a worker which lost the run's
// terminal race left the run to its new owner: no task sweep, no credential
// revocation, and no terminal sandbox event. Each job's own step settles when
// the job ends, before the run-level race is decided.
func assertNoTerminalRunSideEffects(t *testing.T, queries *mockWorkflowSandboxSchedulerQuerier) {
	t.Helper()
	assert.Empty(t, queries.cancelTaskIDs, "tasks must not be cancelled after losing the terminal race")
	assert.Empty(t, queries.updateAgentTokenCalls, "credentials must not be revoked after losing the terminal race")
	for _, notify := range queries.runNotifies {
		assert.NotContains(t, notify.Payload, "workflow_sandbox.success",
			"no terminal sandbox event may be emitted after a concurrent cancel")
		assert.NotContains(t, notify.Payload, "workflow_sandbox.failure",
			"no terminal sandbox event may be emitted after a concurrent cancel")
	}
}

// TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsSuccessFinalization
// pins the lost terminal-state race: when MarkWorkflowRunSuccess matches no row
// (a concurrent cancel already terminalized the run), the worker must not
// cancel tasks, revoke credentials, or emit a terminal sandbox event.
func TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsSuccessFinalization(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(51, 14)
	queries.markWorkflowRunSuccessFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	guests := sandboxSchedulerGuests("0")
	worker := newSandboxSchedulerNixCIWorker(queries, guests.client(t), WithWorkflowSandboxSchedulerCIGuests(guests))

	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{51}, queries.markSuccessIDs)
	assert.Empty(t, queries.markFailureIDs)
	assertNoTerminalRunSideEffects(t, queries)
}

// TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsFailureFinalization is
// the failure-path twin: a job failure racing a concurrent cancel must not
// sweep the cancelled run's tasks or emit workflow_sandbox.failure.
func TestWorkflowSandboxSchedulerWorker_ConcurrentCancelSkipsFailureFinalization(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(52, 16)
	queries.markWorkflowRunFailureFn = func(_ context.Context, _ int64) (db.WorkflowRun, error) {
		return db.WorkflowRun{}, pgx.ErrNoRows
	}
	guests := sandboxSchedulerGuests("1", "boom\n")
	worker := newSandboxSchedulerNixCIWorker(queries, guests.client(t), WithWorkflowSandboxSchedulerCIGuests(guests))

	require.NoError(t, worker.PollOnce(context.Background()), "per-run failure must not fail the poll")
	assert.Equal(t, []int64{52}, queries.markFailureIDs)
	assert.Empty(t, queries.markSuccessIDs)
	assertNoTerminalRunSideEffects(t, queries)
}

// TestWorkflowSandboxSchedulerWorker_RedactsSecretsInRunLogs: the per-run
// jjhub API token and the guest's clone token must never reach
// workflow_run_logs (or the SSE notify payload) verbatim, while
// non-sensitive repository variables are left readable. The jjhub token
// reaches the guest only through its egress proxy: the job environment holds
// its placeholder and the start exec carries no secret.
func TestWorkflowSandboxSchedulerWorker_RedactsSecretsInRunLogs(t *testing.T) {
	t.Parallel()

	queries := newSandboxSchedulerRunQuerier(99, 21)
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listVariablesFn: func(_ context.Context, _ int64) ([]db.RepositoryVariable, error) {
			return []db.RepositoryVariable{{Name: "PUBLIC_VAR", Value: "public-variable-value"}}, nil
		},
	}, webhook.NoopSecretCodec{})

	var mu sync.Mutex
	var cloneToken, jjhubToken string
	var start sandbox.ExecRequest
	polled := false
	client := &mockWorkflowSandboxVMClient{}
	client.createVMFn = func(_ context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		require.NotEmpty(t, req.GitRepos)
		cloneURL, err := url.Parse(req.GitRepos[0].Repo)
		require.NoError(t, err)
		mu.Lock()
		defer mu.Unlock()
		cloneToken, _ = cloneURL.User.Password()
		require.NotNil(t, req.EgressProxy)
		for _, secret := range req.EgressProxy.Secrets {
			if secret.Name == "SMITHERS_JJHUB_TOKEN" {
				jjhubToken = secret.Value
				assert.Equal(t, []string{"api.smithers.test"}, secret.Hosts)
				assert.Equal(t, []string{"authorization"}, secret.MatchHeaders)
			}
		}
		return sandbox.CreateResult{ID: "vm-1"}, nil
	}
	client.execAwaitFn = func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		mu.Lock()
		defer mu.Unlock()
		ok := int32(0)
		if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
			start = req
			return sandbox.ExecResult{StatusCode: &ok}, nil
		}
		if polled {
			return sandbox.ExecResult{Stderr: nixCITaskExitMarker + "0", StatusCode: &ok}, nil
		}
		polled = true
		// The job echoes every credential that exists for it.
		return sandbox.ExecResult{
			Stdout: "jjhub token: " + jjhubToken + "\nclone token: " + cloneToken + "\npublic: public-variable-value\n",
			StatusCode: &ok,
		}, nil
	}

	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
		WithWorkflowSandboxSchedulerSecretInjector(injector),
	)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{99}, queries.markSuccessIDs)

	require.NotEmpty(t, cloneToken, "the guest clones with a credential")
	require.NotEmpty(t, jjhubToken, "the guest's egress proxy carries the per-run jjhub token")
	assert.Empty(t, start.Secrets, "the start exec carries no secret")
	assert.NotContains(t, start.Command, jjhubToken)
	assert.Contains(t, start.Command, "export SMITHERS_JJHUB_TOKEN='\\''SMITHERS_JJHUB_TOKEN'\\''", "the job sees only the placeholder")
	assert.Contains(t, start.Command, "export SMITHERS_JJHUB_API_URL='\\''https://api.smithers.test/api'\\''")
	assert.Contains(t, start.Command, "export PUBLIC_VAR='\\''public-variable-value'\\''")

	require.NotEmpty(t, queries.logInserts)
	var sawRedactedJJHub, sawRedactedClone, sawPublicVariable bool
	for _, insert := range queries.logInserts {
		assert.NotContains(t, insert.Entry, jjhubToken)
		assert.NotContains(t, insert.Entry, cloneToken)
		switch {
		case strings.HasPrefix(insert.Entry, "jjhub token:"):
			sawRedactedJJHub = strings.Contains(insert.Entry, redactedSecretValue)
		case strings.HasPrefix(insert.Entry, "clone token:"):
			sawRedactedClone = strings.Contains(insert.Entry, redactedSecretValue)
		case strings.HasPrefix(insert.Entry, "public:"):
			sawPublicVariable = strings.Contains(insert.Entry, "public-variable-value")
		}
	}
	assert.True(t, sawRedactedJJHub, "per-run jjhub token must be masked in run logs")
	assert.True(t, sawRedactedClone, "clone token must be masked in run logs")
	assert.True(t, sawPublicVariable, "non-sensitive repository variables must remain readable")

	for _, notify := range queries.logNotifies {
		assert.NotContains(t, notify.Payload, jjhubToken)
	}
}

// A repository secret has no host binding, so no supported channel reaches a
// NixOS CI guest: the job fails before any guest boots, naming the secret and
// never logging its value.
func TestWorkflowSandboxSchedulerRefusesRepositorySecretsWithoutAChannel(t *testing.T) {
	t.Parallel()
	queries := newSandboxSchedulerRunQuerier(98, 22)
	injector := NewSecretInjector(&mockSecretInjectionQuerier{
		listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
			return []db.ListSecretValuesRow{{Name: "ANTHROPIC_AUTH_TOKEN", ValueEncrypted: []byte("sk-ant-super-secret")}}, nil
		},
	}, webhook.NoopSecretCodec{})
	guests := sandboxSchedulerGuests("0")
	client := guests.client(t)
	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
		WithWorkflowSandboxSchedulerSecretInjector(injector))

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.Equal(t, []int64{98}, queries.markFailureIDs)
	assert.Empty(t, client.createCalls, "no guest boots for a job whose secrets cannot reach it")
	assert.Empty(t, client.execCalls)
	var system []string
	for _, insert := range queries.logInserts {
		assert.NotContains(t, insert.Entry, "sk-ant-super-secret")
		if insert.Stream == "system" {
			system = append(system, insert.Entry)
		}
	}
	require.Len(t, system, 1)
	assert.True(t, strings.HasPrefix(system[0], "ANTHROPIC_AUTH_TOKEN cannot reach the NixOS CI guest: "), system[0])
	err := nixCIUnboundSecretsError(map[string]string{"B": "value-of-b", "A": "value-of-a"})
	assert.ErrorIs(t, err, ErrCISecretChannelUnavailable)
	var typed *CISecretChannelError
	require.ErrorAs(t, err, &typed)
	assert.Equal(t, []string{"A", "B"}, typed.Names, "names are reported sorted, values never")
	assert.NotContains(t, err.Error(), "value-of")
	assert.NoError(t, nixCIUnboundSecretsError(nil))
}

// The whole-run backstop expiring mid-job fails the run, and the terminal
// write runs on a fresh finalize context rather than the expired run context.
func TestWorkflowSandboxSchedulerWorker_PollOnce_TimeoutMarksFailureWithFinalizationContext(t *testing.T) {
	t.Setenv("SMITHERS_WORKFLOW_NIX_CI_RUN_TIMEOUT", "50ms")

	failureCtxErrs := make([]error, 0, 1)
	queries := newSandboxSchedulerRunQuerier(96, 15)
	queries.markWorkflowRunFailureFn = func(ctx context.Context, id int64) (db.WorkflowRun, error) {
		failureCtxErrs = append(failureCtxErrs, ctx.Err())
		return db.WorkflowRun{ID: id, Status: "failure"}, nil
	}
	client := blockingNixCIGuestClient()
	worker := newSandboxSchedulerNixCIWorker(queries, client)

	require.NoError(t, worker.PollOnce(context.Background()), "poll should continue after per-run timeout failures")

	assert.Equal(t, []int64{96}, queries.markFailureIDs)
	require.Len(t, failureCtxErrs, 1)
	assert.NoError(t, failureCtxErrs[0], "terminal failure updates must not use the expired run context")
	assert.Equal(t, []string{"vm-1"}, client.deleteCalls)
	assert.Equal(t, map[int64]string{1: "failed"}, nixCITaskStatuses(queries), "a timed-out job fails; it was not cancelled")
	assert.Equal(t, map[int64]string{15: "failure"}, nixCIStepStatuses(queries))
}

// TestWorkflowSandboxSchedulerWorker_PollOnce_LongRunStillFinalizes pins the fix
// for the finalize-context regression: the finalize budget must be minted AFTER
// the job, not at run start. With a job that outlives the finalize budget, a
// budget minted at executeRun entry would already be expired by the time the
// run is marked success.
//
// Both durations live on synctest's fake clock. The poll's Sleep advances it;
// the finalize writes never block, so it stands still while they run and the
// finalize deadline can lapse only if the product minted it before the job.
// On the wall clock the same 20ms budget also bounded how long the host could
// stall this goroutine between minting and the success write, which is why
// the test failed once inside a loaded full-package run (#2259).
func TestWorkflowSandboxSchedulerWorker_PollOnce_LongRunStillFinalizes(t *testing.T) {
	t.Parallel()

	synctest.Test(t, testWorkflowSandboxSchedulerWorkerLongRunStillFinalizes)
}

func testWorkflowSandboxSchedulerWorkerLongRunStillFinalizes(t *testing.T) {
	var successCtxErr error
	queries := newSandboxSchedulerRunQuerier(77, 18)
	queries.markWorkflowRunSuccessFn = func(ctx context.Context, id int64) (db.WorkflowRun, error) {
		successCtxErr = ctx.Err()
		return db.WorkflowRun{ID: id, Status: "success"}, nil
	}
	client := &mockWorkflowSandboxVMClient{
		execAwaitFn: func(_ context.Context, _ string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			ok := int32(0)
			if strings.Contains(req.Command, "SMITHERS_CI_EOF") {
				return sandbox.ExecResult{StatusCode: &ok}, nil
			}
			// The job outlives the finalize budget set below. Inside the bubble
			// this advances the fake clock by 60ms instead of sleeping.
			time.Sleep(60 * time.Millisecond)
			return sandbox.ExecResult{Stdout: "done\n", Stderr: nixCITaskExitMarker + "0", StatusCode: &ok}, nil
		},
	}
	worker := newSandboxSchedulerNixCIWorker(queries, client)
	// A finalize budget far shorter than the job: minted at run start it would
	// be exhausted before finalization; minted after the job it is fresh.
	worker.finalizeTimeout = 20 * time.Millisecond

	require.NoError(t, worker.PollOnce(context.Background()))

	assert.NoError(t, successCtxErr, "finalize context must be unexpired when marking success")
	assert.Equal(t, []int64{77}, queries.markSuccessIDs, "long run must still be marked success")
	assert.Equal(t, map[int64]string{18: "success"}, nixCIStepStatuses(queries))
	assert.Equal(t, []string{"done"}, nixCILogEntriesForStep(queries, 18), "output logs must be persisted after a long job")
}

func TestWorkflowSandboxSchedulerWorker_OrgOwnedRepoClonesWithRepoBoundCredential(t *testing.T) {
	t.Parallel()

	var mintMu sync.Mutex
	var minted []db.CreateAccessTokenParams
	queries := newSandboxSchedulerRunQuerier(77, 31)
	queries.getRepoByIDFn = func(_ context.Context, id int64) (db.Repository, error) {
		return db.Repository{ID: id, Name: "infra", OrgID: pgtype.Int8{Int64: 44, Valid: true}}, nil
	}
	queries.getOrgByIDFn = func(_ context.Context, id int64) (db.Organization, error) {
		return db.Organization{ID: id, Name: "acme"}, nil
	}
	queries.getOrgCredentialOwnerIDFn = func(_ context.Context, organizationID int64) (int64, error) {
		assert.Equal(t, int64(44), organizationID)
		return 5, nil
	}
	queries.createAccessTokenFn = func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
		mintMu.Lock()
		defer mintMu.Unlock()
		minted = append(minted, arg)
		return db.AccessToken{ID: int64(900 + len(minted))}, nil
	}
	guests := sandboxSchedulerGuests("0")
	client := guests.client(t)
	worker := newSandboxSchedulerNixCIWorker(queries, client,
		WithWorkflowSandboxSchedulerCIGuests(guests),
		WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
	)

	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Equal(t, []int64{77}, queries.markSuccessIDs)

	require.Len(t, client.createCalls, 1)
	created := client.createCalls[0]
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
	assert.ElementsMatch(t, []string{"read:repository", middleware.RepositoryRestrictionScope(100)}, scopes)
	assert.Empty(t, created.EgressProxy.SecretNames(), "an org repository binds no per-run api token")
	assert.NotContains(t, nixCIStartExec(t, client).Command, "SMITHERS_JJHUB_TOKEN")

	assert.Contains(t, queries.deleteAccessTokenCalls, db.DeleteAccessTokenParams{ID: 901, UserID: 5},
		"the clone credential is revoked once the guest has cloned")
}

// A main-only repository secret (D-24) is bound for a sandbox run only when
// its claimed trigger is a trusted one on exactly the default bookmark. No
// NixOS CI channel carries an unbound secret, so the refusal names exactly the
// secrets the run was given.
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
		queries := newSandboxSchedulerRunQuerier(99, 21)
		queries.claimQueuedWorkflowRunsFn = func(_ context.Context, _ int32) ([]db.WorkflowRun, error) {
			return []db.WorkflowRun{{ID: 99, RepositoryID: 100, WorkflowDefinitionID: 7, TriggerRef: tc.ref, TriggerEvent: tc.event}}, nil
		}
		queries.getRepoByIDFn = func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 9, Valid: true}}, nil
		}
		injector := NewSecretInjector(&mockSecretInjectionQuerier{
			getRepoFn: func(_ context.Context, id int64) (db.Repository, error) { return db.Repository{ID: id}, nil },
			listSecretValuesFn: func(_ context.Context, _ int64) ([]db.ListSecretValuesRow, error) {
				return []db.ListSecretValuesRow{{Name: "DEPLOY_TOKEN", ValueEncrypted: []byte("deploy"), MainOnly: true}, {Name: "LINT_TOKEN", ValueEncrypted: []byte("lint")}}, nil
			},
		}, webhook.NoopSecretCodec{})
		guests := sandboxSchedulerGuests("0")
		client := guests.client(t)
		worker := newSandboxSchedulerNixCIWorker(queries, client,
			WithWorkflowSandboxSchedulerCIGuests(guests),
			WithWorkflowSandboxSchedulerAPIBaseURL("https://api.smithers.test/api"),
			WithWorkflowSandboxSchedulerSecretInjector(injector))
		require.NoError(t, worker.PollOnce(context.Background()))
		want := "LINT_TOKEN cannot reach the NixOS CI guest"
		if tc.trusted {
			want = "DEPLOY_TOKEN, LINT_TOKEN cannot reach the NixOS CI guest"
		}
		var system []string
		for _, insert := range queries.logInserts {
			if insert.Stream == "system" {
				system = append(system, insert.Entry)
			}
		}
		require.Len(t, system, 1, "%s on %q", tc.event, tc.ref)
		assert.True(t, strings.HasPrefix(system[0], want+": "), "%s on %q: %s", tc.event, tc.ref, system[0])
		assert.Empty(t, client.createCalls)
	}
}

func (m *mockWorkflowSandboxVMClient) WriteFile(context.Context, string, string, sandbox.WriteFileRequest) error {
	return nil
}
