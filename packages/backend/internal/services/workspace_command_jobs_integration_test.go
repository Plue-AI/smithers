package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func workspaceCommandTestCodec(t *testing.T) flowhost.SecretCodec {
	t.Helper()
	codec, err := webhook.NewSecretCodec("workspace-command-integration-key")
	require.NoError(t, err)
	return codec
}

// A real process runtime handles repository commands; only the command whose
// guest kill cannot be confirmed is injected at the runtime boundary.
type unconfirmedCommandRuntime struct {
	workspaceapi.WorkspaceRuntime
	started        chan struct{}
	successStarted chan struct{}
	once           sync.Once
	successOnce    sync.Once
}

func (r *unconfirmedCommandRuntime) ExecuteCommand(ctx context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(command.Args) == 3 && command.Args[0] == "/bin/sh" && command.Args[2] == "__unconfirmed__" {
		r.once.Do(func() { close(r.started) })
		<-ctx.Done()
		return workspaceapi.CommandResult{}, workspaceapi.ErrCommandTerminationUnconfirmed
	}
	if len(command.Args) == 3 && command.Args[0] == "/bin/sh" && command.Args[2] == "__completed_at_cancel__" {
		r.successOnce.Do(func() { close(r.successStarted) })
		<-ctx.Done()
		return workspaceapi.CommandResult{ExitCode: 13, Stdout: "completed"}, nil
	}
	return r.WorkspaceRuntime.ExecuteCommand(ctx, workspaceID, command)
}

func workspaceCommandGitServer(t *testing.T, q *db.Queries, repositoryID int64) *httptest.Server {
	t.Helper()
	requireExecutable(t, "git")
	requireExecutable(t, "jj")
	slug, err := q.GetRepoOwnerSlugAndNameByID(context.Background(), repositoryID)
	require.NoError(t, err)
	root := t.TempDir()
	seedBareRepository(t, filepath.Join(root, "api", slug.OwnerSlug, slug.RepoName+".git"), "main")
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	backend := &cgi.Handler{Path: gitExecutable, Args: []string{"http-backend"}, Dir: root,
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"}}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
			http.Error(response, "missing repository bearer", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)
	return server
}

// Exercises the public service methods with migrated Postgres, a replacement
// worker service, and a real child process.
func TestWorkspaceCommandJobsProcessRuntime(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	workspaceID := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,kind,status)
		VALUES($1,$2,$3,'command-jobs','container','running')`, workspaceID, repositoryID, userID)
	require.NoError(t, err)
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2, OutputLimit: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	gitServer := workspaceCommandGitServer(t, db.New(pool), repositoryID)
	newService := func() *WorkspaceService {
		return NewWorkspaceService(db.New(pool), WithWorkspaceRuntime(runtime), WithWorkspaceCommandJobs(store, workspaceCommandTestCodec(t)),
			WithWorkspaceGitBaseURL(gitServer.URL+"/api"))
	}
	api := newService()
	unconfirmedRuntime := &unconfirmedCommandRuntime{WorkspaceRuntime: runtime, started: make(chan struct{}), successStarted: make(chan struct{})}
	worker := NewWorkspaceService(db.New(pool), WithWorkspaceRuntime(unconfirmedRuntime),
		WithWorkspaceCommandJobs(store, workspaceCommandTestCodec(t)), WithWorkspaceGitBaseURL(gitServer.URL+"/api"))
	_, err = api.executeWorkspaceCommand(ctx, workspaceID, repositoryID, userID,
		WorkspaceCommandInput{OperationID: "fixture-repository-ready", Args: []string{"/usr/bin/true"}})
	require.NoError(t, err, "real workspace repository must be ready before command jobs")
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- worker.RunWorkspaceCommandWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "workspace-command-integration", Capacity: 2, Lease: 2 * time.Second,
			PollInterval: 10 * time.Millisecond, RetryDelay: 10 * time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		stopWorker()
		select {
		case workerErr := <-workerDone:
			require.NoError(t, workerErr)
		case <-time.After(5 * time.Second):
			t.Error("workspace command worker did not stop")
		}
	})

	t.Run("completed output and retry identity", func(t *testing.T) {
		input := WorkspaceCommandInput{OperationID: uuid.NewString(),
			Args:        []string{"/bin/sh", "-c", `printf 'out:%s' "$VALUE"; printf 'err:%s' "$VALUE" >&2; exit 7`, "command", "argument-secret-2130"},
			Environment: map[string]string{"VALUE": "done", "PRIVATE_TOKEN": "environment-secret-2130"}}
		admitCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		defer cancel()
		receipt, admitErr := api.AdmitWorkspaceCommand(admitCtx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		require.Equal(t, jobs.StateAccepted, receipt.State)
		require.NotEmpty(t, receipt.OperationID)
		stored, getErr := store.Get(ctx, repositoryJobFlowScope(repositoryID, userID), receipt.OperationID)
		require.NoError(t, getErr)
		require.NotContains(t, string(stored.Payload), "argument-secret-2130")
		require.NotContains(t, string(stored.Payload), "environment-secret-2130")
		joined, joinErr := api.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, input)
		require.NoError(t, joinErr)
		require.Equal(t, receipt.OperationID, joined.OperationID)
		var run WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var pollErr error
			run, pollErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return pollErr == nil && run.State.Terminal()
		}, 10*time.Second, 20*time.Millisecond)
		require.Equal(t, jobs.StateCompleted, run.State)
		require.NotNil(t, run.Result)
		require.Equal(t, 7, run.Result.ExitCode)
		require.Equal(t, "out:done", run.Result.Stdout)
		require.Equal(t, "err:done", run.Result.Stderr)
		require.False(t, run.Result.OutputTruncated)
	})

	t.Run("output is bounded", func(t *testing.T) {
		input := WorkspaceCommandInput{OperationID: uuid.NewString(),
			Args: []string{"/bin/sh", "-c", `/usr/bin/yes x | /usr/bin/head -c 300000`}}
		receipt, admitErr := api.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		var run WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var pollErr error
			run, pollErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return pollErr == nil && run.State.Terminal()
		}, 10*time.Second, 20*time.Millisecond)
		require.Equal(t, jobs.StateCompleted, run.State)
		require.NotNil(t, run.Result)
		require.Equal(t, strings.Repeat("x\n", workspaceCommandOutputLimit/2), run.Result.Stdout)
		require.True(t, run.Result.OutputTruncated)
	})

	t.Run("nul bytes survive durable receipt", func(t *testing.T) {
		input := WorkspaceCommandInput{OperationID: uuid.NewString(),
			Args: []string{"/bin/sh", "-c", `printf 'a\000b'; printf 'c\000d' >&2; exit 3`}}
		receipt, admitErr := api.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		var run WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var pollErr error
			run, pollErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return pollErr == nil && run.State.Terminal()
		}, 10*time.Second, 20*time.Millisecond)
		require.Equal(t, jobs.StateCompleted, run.State)
		require.NotNil(t, run.Result)
		require.Equal(t, 3, run.Result.ExitCode)
		require.Equal(t, "a\x00b", run.Result.Stdout)
		require.Equal(t, "c\x00d", run.Result.Stderr)
	})

	t.Run("ten minute command admits immediately and cancellation kills it", func(t *testing.T) {
		pidFile := t.TempDir() + "/pid"
		input := WorkspaceCommandInput{OperationID: uuid.NewString(),
			Args: []string{"/bin/sh", "-c", `sleep 600 & child=$!; printf '%s %s' "$$" "$child" > "$1"; wait "$child"`, "command", pidFile}}
		admitCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		defer cancel()
		started := time.Now()
		receipt, admitErr := api.AdmitWorkspaceCommand(admitCtx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		require.Less(t, time.Since(started), 250*time.Millisecond)
		require.Equal(t, jobs.StateAccepted, receipt.State)
		var leaderPID, childPID int
		require.Eventually(t, func() bool {
			data, readErr := os.ReadFile(pidFile)
			if readErr != nil {
				return false
			}
			parts := strings.Fields(string(data))
			if len(parts) != 2 {
				return false
			}
			leaderPID, readErr = strconv.Atoi(parts[0])
			if readErr != nil {
				return false
			}
			childPID, readErr = strconv.Atoi(parts[1])
			return readErr == nil && leaderPID > 0 && childPID > 0
		}, 10*time.Second, 20*time.Millisecond)
		require.NoError(t, syscall.Kill(childPID, 0))
		running, pollErr := api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
		require.NoError(t, pollErr)
		require.False(t, running.State.Terminal())
		_, cancelErr := api.CancelWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
		require.NoError(t, cancelErr)
		var cancelled WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var getErr error
			cancelled, getErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return getErr == nil && cancelled.State == jobs.StateCancelled
		}, 10*time.Second, 20*time.Millisecond)
		require.Eventually(t, func() bool {
			return errors.Is(syscall.Kill(-leaderPID, 0), syscall.ESRCH) &&
				errors.Is(syscall.Kill(childPID, 0), syscall.ESRCH)
		}, 5*time.Second, 20*time.Millisecond, "cancellation must stop the entire command process group")
	})

	t.Run("unconfirmed guest termination never acknowledges cancellation", func(t *testing.T) {
		input := WorkspaceCommandInput{OperationID: uuid.NewString(), Args: []string{"/bin/sh", "-c", "__unconfirmed__"}}
		receipt, admitErr := api.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		select {
		case <-unconfirmedRuntime.started:
		case <-time.After(10 * time.Second):
			t.Fatal("worker never started the injected guest command")
		}
		_, cancelErr := api.CancelWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
		require.NoError(t, cancelErr)
		var run WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var pollErr error
			run, pollErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return pollErr == nil && run.State.Terminal()
		}, 10*time.Second, 20*time.Millisecond)
		require.Equal(t, jobs.StateUncertain, run.State)
		require.Equal(t, "command outcome is unknown; it will not be retried", run.Error)
	})

	t.Run("completed command receipt wins cancellation race", func(t *testing.T) {
		input := WorkspaceCommandInput{OperationID: uuid.NewString(), Args: []string{"/bin/sh", "-c", "__completed_at_cancel__"}}
		receipt, admitErr := api.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		select {
		case <-unconfirmedRuntime.successStarted:
		case <-time.After(10 * time.Second):
			t.Fatal("worker never started the injected guest command")
		}
		_, cancelErr := api.CancelWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
		require.NoError(t, cancelErr)
		var run WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var pollErr error
			run, pollErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return pollErr == nil && run.State.Terminal()
		}, 10*time.Second, 20*time.Millisecond)
		require.Equal(t, jobs.StateCompleted, run.State)
		require.NotNil(t, run.Result)
		require.Equal(t, 13, run.Result.ExitCode)
		require.Equal(t, "completed", run.Result.Stdout)
	})

	t.Run("ten minute completion acceptance", func(t *testing.T) {
		if os.Getenv("SMITHERS_WORKSPACE_COMMAND_TEN_MINUTES") != "1" {
			t.Skip("set SMITHERS_WORKSPACE_COMMAND_TEN_MINUTES=1 and go test -timeout=12m to run")
		}
		input := WorkspaceCommandInput{OperationID: uuid.NewString(),
			Args: []string{"/bin/sh", "-c", `sleep 600; printf complete; printf warning >&2; exit 9`}}
		admitCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		defer cancel()
		started := time.Now()
		receipt, admitErr := api.AdmitWorkspaceCommand(admitCtx, workspaceID, repositoryID, userID, input)
		require.NoError(t, admitErr)
		require.Less(t, time.Since(started), 250*time.Millisecond)
		var run WorkspaceCommandRun
		require.Eventually(t, func() bool {
			var pollErr error
			run, pollErr = api.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
			return pollErr == nil && run.State.Terminal()
		}, 11*time.Minute, time.Second)
		require.Equal(t, jobs.StateCompleted, run.State)
		require.NotNil(t, run.Result)
		require.Equal(t, 9, run.Result.ExitCode)
		require.Equal(t, "complete", run.Result.Stdout)
		require.Equal(t, "warning", run.Result.Stderr)
	})
}

func TestWorkspaceCommandJobsAdmissionAndUnsafeRecovery(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	otherUserID, _ := setupTestUserAndRepo(t, pool)
	workspaceID := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,kind,status)
		VALUES($1,$2,$3,'command-fences','container','running')`, workspaceID, repositoryID, userID)
	require.NoError(t, err)
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := NewWorkspaceService(db.New(pool), WithWorkspaceRuntime(runtime), WithWorkspaceCommandJobs(store, workspaceCommandTestCodec(t)))
	command := WorkspaceCommandInput{OperationID: uuid.NewString(), Args: []string{"/usr/bin/true"}}

	_, err = service.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, WorkspaceCommandInput{OperationID: uuid.NewString()})
	require.Error(t, err, "empty command must fail before writing an operation")
	_, err = service.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, WorkspaceCommandInput{Args: []string{"/usr/bin/true"}})
	require.Error(t, err, "missing retry identity must fail")
	_, err = NewWorkspaceService(db.New(pool), WithWorkspaceRuntime(runtime)).AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, command)
	require.Error(t, err, "unwired jobs must fail admission")

	receipt, err := service.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, command)
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, receipt.State)
	changed := command
	changed.Args = []string{"/bin/false"}
	_, err = service.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID, changed)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 409, apiErr.Status)
	_, err = service.GetWorkspaceCommandRun(ctx, uuid.NewString(), repositoryID, userID, receipt.OperationID)
	require.Error(t, err)
	_, err = service.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID+999, userID, receipt.OperationID)
	require.Error(t, err)
	_, err = service.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, otherUserID, receipt.OperationID)
	require.Error(t, err)
	_, err = service.CancelWorkspaceCommandRun(ctx, workspaceID, repositoryID, otherUserID, receipt.OperationID)
	require.Error(t, err)

	// Cancellation while queued is durable and never starts a child process.
	queuedMarker := t.TempDir() + "/queued-started"
	queued, err := service.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID,
		WorkspaceCommandInput{OperationID: uuid.NewString(), Args: []string{"/bin/sh", "-c", `printf started > "$1"`, "command", queuedMarker}})
	require.NoError(t, err)
	cancelled, err := service.CancelWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, queued.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateCancelled, cancelled.State)
	persisted, err := service.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, queued.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateCancelled, persisted.State)
	_, err = os.Stat(queuedMarker)
	require.True(t, errors.Is(err, os.ErrNotExist))

	// Once the unsafe external fence is persisted, a lost worker may not rerun
	// the command: recovery marks the outcome uncertain.
	claim, err := store.ClaimForOperations(ctx, "first-command-worker", time.Minute, []string{workspaceCommandOperation})
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, claim.OperationID)
	require.Equal(t, jobs.EffectUnsafe, claim.EffectPolicy)
	_, err = store.BeginExternal(ctx, claim, []byte(`{"phase":"executing"}`))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, claim.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpiredForOperations(ctx, []string{workspaceCommandOperation}, 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	uncertain, err := service.GetWorkspaceCommandRun(ctx, workspaceID, repositoryID, userID, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateUncertain, uncertain.State)
	_, err = store.ClaimForOperations(ctx, "replacement-command-worker", time.Minute, []string{workspaceCommandOperation})
	require.ErrorIs(t, err, jobs.ErrNoWork)
}

func TestWorkspaceCommandJobRechecksRevokedAccountBeforeExecution(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	workspaceID := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,kind,status)
		VALUES($1,$2,$3,'command-revoked','container','running')`, workspaceID, repositoryID, userID)
	require.NoError(t, err)
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := NewWorkspaceService(db.New(pool), WithWorkspaceRuntime(runtime), WithWorkspaceCommandJobs(store, workspaceCommandTestCodec(t)))
	marker := t.TempDir() + "/should-not-run"
	receipt, err := service.AdmitWorkspaceCommand(ctx, workspaceID, repositoryID, userID,
		WorkspaceCommandInput{OperationID: uuid.NewString(), Args: []string{"/bin/sh", "-c", `printf executed > "$1"`, "command", marker}})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, userID)
	require.NoError(t, err)
	workerCtx, stopWorker := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- service.RunWorkspaceCommandWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "revoked-command-worker", Capacity: 1, Lease: time.Second,
			PollInterval: 10 * time.Millisecond, RetryDelay: 10 * time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		stopWorker()
		select {
		case workerErr := <-done:
			require.NoError(t, workerErr)
		case <-time.After(5 * time.Second):
			t.Error("revoked command worker did not stop")
		}
	})
	var operation jobs.Operation
	require.Eventually(t, func() bool {
		var getErr error
		operation, getErr = store.Get(ctx, repositoryJobFlowScope(repositoryID, userID), receipt.OperationID)
		return getErr == nil && operation.State.Terminal()
	}, 10*time.Second, 20*time.Millisecond)
	require.Equal(t, jobs.StateFailed, operation.State)
	require.JSONEq(t, `{"code":"command_permission_denied"}`, string(operation.TerminalReceipt))
	_, err = os.Stat(marker)
	require.True(t, errors.Is(err, os.ErrNotExist), "revoked account must never launch the process")
}

func TestWorkspaceCommandRunReceiptProjectsTerminalStates(t *testing.T) {
	for _, tc := range []struct {
		name      string
		state     jobs.State
		receipt   string
		wantCode  int
		wantError string
		invalid   bool
	}{
		{name: "completed exit", state: jobs.StateCompleted, receipt: `{"exit_code":7,"stdout":"b3V0"}`, wantCode: 7},
		{name: "failed hides internal receipt", state: jobs.StateFailed, receipt: `{"code":"command_execution_failed"}`, wantError: "command failed"},
		{name: "permission failure", state: jobs.StateFailed, receipt: `{"code":"command_permission_denied"}`, wantError: "command permission denied"},
		{name: "timeout failure", state: jobs.StateFailed, receipt: `{"code":"command_timeout"}`, wantError: "command exceeded its 60-minute limit"},
		{name: "uncertain forbids retry claim", state: jobs.StateUncertain, receipt: `{"code":"unknown"}`, wantError: "command outcome is unknown; it will not be retried"},
		{name: "malformed completed receipt", state: jobs.StateCompleted, receipt: `{`, invalid: true},
		{name: "malformed failure receipt", state: jobs.StateFailed, receipt: `{`, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run, err := commandRunReceipt(jobs.Operation{ID: "operation", State: tc.state, TerminalReceipt: []byte(tc.receipt)})
			if tc.invalid {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, "operation", run.OperationID)
			require.Equal(t, tc.state, run.State)
			require.Equal(t, tc.wantError, run.Error)
			if tc.state == jobs.StateCompleted {
				require.NotNil(t, run.Result)
				require.Equal(t, tc.wantCode, run.Result.ExitCode)
				require.Equal(t, "out", run.Result.Stdout)
			} else {
				require.Nil(t, run.Result)
			}
		})
	}
}
