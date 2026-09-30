package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// NixOS CI execution. A sandbox-plane run that carries a rendered job graph
// (workflow_tasks rows) executes each job in its own kind=vm NixOS guest
// booted from the repository's closure image — the same machine a workspace
// boots. The Debian smithers-runner OCI image is not involved.
//
// Owner decision (2026-09-15): Smithers Cloud machines are NixOS, built from
// nix/ plus each repository's .smithers/environment.nix. ResolveCIExecutionPlane
// routes a repository that declares and has built its environment here.

const (
	// nixCITaskWorkdir is where the repository is checked out in the guest. It
	// matches the workspace clone path so a CI failure can be reproduced by
	// opening a workspace and running the same command in the same directory.
	nixCITaskWorkdir = "/workspace/repo"
	// nixCITaskLogDir holds the per-task command log the poller tails. It lives
	// on the guest's own disk, never on a shared volume.
	nixCITaskLogDir  = "/var/log/smithers-ci"
	nixCITaskLogPath = nixCITaskLogDir + "/task.log"
	// nixCITaskExitPath appears only once the command has exited; its presence
	// is the completion signal, and its contents the exit status.
	nixCITaskExitPath   = nixCITaskLogDir + "/task.exit"
	nixCITaskScriptPath = nixCITaskLogDir + "/task.sh"
	// nixCITaskExitMarker is emitted on the poll command's STDERR so the poll's
	// STDOUT stays byte-exact log content that can be appended blind.
	nixCITaskExitMarker = "SMITHERS_TASK_EXIT="

	// defaultNixCITaskTimeout matches SMITHERS_RUNNER_TASK_TIMEOUT so a job
	// that fits on the Debian runner also fits in a NixOS guest.
	defaultNixCITaskTimeout = 120 * time.Minute
	// defaultNixCIRunConcurrency bounds how many guests one run boots at once.
	// Parallel jobs are the point of the DAG, but a single run must not be able
	// to consume the whole sandbox fleet.
	defaultNixCIRunConcurrency = 5
	// defaultNixCIProvisionAttempts retries guest PROVISIONING only. A command
	// that ran and failed is a real CI failure and is never retried; a guest
	// that never booted is infrastructure and gets one more chance.
	defaultNixCIProvisionAttempts = 2
	// nixCIPollInterval was chosen to match the deleted 0.x step runner's
	// LOG_FLUSH_INTERVAL_MS so live logs arrived at the same cadence on both
	// planes. That runner is gone; this plane keeps the cadence.
	nixCIPollInterval = 2 * time.Second
	// nixCIPollTimeout bounds one tail exec so a wedged guest cannot stall the
	// poll loop past the task ceiling.
	nixCIPollTimeout        = 30 * time.Second
	nixCIMaxPendingLogBytes = 64 << 10
	// nixCIGuestDeleteTimeout bounds the best-effort teardown of one guest.
	nixCIGuestDeleteTimeout = 30 * time.Second
	// defaultNixCIRunTimeout is the whole-run backstop. Each job already has
	// its own ceiling; this only bounds a graph whose jobs keep succeeding.
	defaultNixCIRunTimeout = 240 * time.Minute
)

// WorkflowCIGuestProvisioner builds the create request for one CI task guest.
// WorkspaceService implements it via CIGuestVMRequest, so CI and workspaces
// share one definition of the machine.
type WorkflowCIGuestProvisioner interface {
	CIGuestVMRequest(ctx context.Context, repositoryID int64, gitRepos []sandbox.GitRepositorySpec) (sandbox.CreateRequest, error)
}

// nixCITaskQuerier is the task-graph surface the NixOS CI executor needs. It is
// a subset of WorkflowSandboxSchedulerQuerier.
type nixCITaskQuerier interface {
	ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	GetWorkflowTask(ctx context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error)
	MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	MarkWorkflowTaskTerminalByID(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error)
	UnblockWorkflowTask(ctx context.Context, id int64) error
	SkipBlockedWorkflowTask(ctx context.Context, id int64) error
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
}

// nixCITaskPayload is the slice of the workflow_tasks payload the NixOS guest
// needs. It is written by createWorkflowRunRows and read by both planes.
type nixCITaskPayload struct {
	Job    string                    `json:"job"`
	Steps  []StepConfig              `json:"steps"`
	Needs  []string                  `json:"needs"`
	If     string                    `json:"if"`
	Event  string                    `json:"event"`
	Inputs map[string]interface{}    `json:"inputs"`
	Cache  []WorkflowCacheDescriptor `json:"cache"`
}

// nixCITask couples a persisted task row with its decoded payload.
type nixCITask struct {
	ID            int64
	WorkflowRunID int64
	StepID        int64
	StepName      string
	Status        string
	Job           string
	Steps         []StepConfig
	Needs         []string
	If            string
	Event         TriggerEvent
	Cache         []WorkflowCacheDescriptor
}

// nixCITaskOutcome is the terminal state one task reached.
type nixCITaskOutcome string

const (
	nixCITaskDone      nixCITaskOutcome = "done"
	nixCITaskFailed    nixCITaskOutcome = "failed"
	nixCITaskCancelled nixCITaskOutcome = "cancelled"
	nixCITaskSkipped   nixCITaskOutcome = "skipped"
)

// runHasTaskGraph reports whether a claimed sandbox-plane run carries a
// rendered job graph.
//
// createWorkflowRunRows writes one workflow_step + one workflow_task per job,
// so a run with tasks is a CI DAG whose jobs this executor runs one guest
// each. A sandbox-plane run without tasks has nothing to run and fails;
// invoked flows run on the flow plane instead. A lookup error is returned
// rather than read as "no tasks", so a failed query never fails a CI run as
// empty.
func runHasTaskGraph(ctx context.Context, q nixCITaskQuerier, runID int64) (bool, error) {
	rows, err := q.ListTaskStepInfoForRun(ctx, runID)
	if err != nil {
		return false, err
	}
	return len(rows) > 0, nil
}

// loadNixCITasks reads the run's job graph. Tasks whose payload cannot be
// decoded are an internal defect, not a user error, and fail the run.
func loadNixCITasks(ctx context.Context, q nixCITaskQuerier, runID, repositoryID int64) ([]nixCITask, error) {
	rows, err := q.ListTaskStepInfoForRun(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("list workflow tasks: %w", err)
	}
	tasks := make([]nixCITask, 0, len(rows))
	for _, row := range rows {
		task, err := q.GetWorkflowTask(ctx, db.GetWorkflowTaskParams{ID: row.ID, RepositoryID: repositoryID})
		if err != nil {
			return nil, fmt.Errorf("load workflow task %d: %w", row.ID, err)
		}
		var payload nixCITaskPayload
		if err := json.Unmarshal(task.Payload, &payload); err != nil {
			return nil, fmt.Errorf("decode workflow task %d payload: %w", row.ID, err)
		}
		job := strings.TrimSpace(payload.Job)
		if job == "" {
			job = row.StepName
		}
		tasks = append(tasks, nixCITask{
			ID:            task.ID,
			WorkflowRunID: task.WorkflowRunID,
			StepID:        task.WorkflowStepID,
			StepName:      row.StepName,
			Status:        task.Status,
			Job:           job,
			Steps:         payload.Steps,
			Needs:         payload.Needs,
			If:            payload.If,
			Event:         TriggerEvent{Type: payload.Event, Inputs: payload.Inputs},
			Cache:         payload.Cache,
		})
	}
	return tasks, nil
}

// nixCITaskCommand renders one job's steps into a single guest script.
//
// `set -euo pipefail` plus one `cd` gives the step ordering and failure
// semantics the deleted 0.x step runner had: the first failing step ends the
// job. `uses:` steps are not supported on this plane yet and fail loudly
// rather than being silently skipped.
//
// The job's `cache:` descriptors are restored before the first step and saved
// only after every step succeeded, as the runner did; the smithers-ci helper
// on PATH also serves `smithers-ci artifact upload|download` to the steps.
func nixCITaskCommand(task nixCITask) (string, error) {
	lines := []string{
		"set -euo pipefail",
		"export PATH=" + shellQuote(nixCIToolBinDir) + `:"$PATH"`,
		"cd " + shellQuote(nixCITaskWorkdir),
	}
	if nixCIHasCacheAction(task, "restore") {
		lines = append(lines, "smithers-ci cache restore "+shellQuote(nixCICacheDescriptors)+" "+shellQuote(nixCICacheState))
	}
	ran := 0
	for i, step := range task.Steps {
		if strings.TrimSpace(step.Uses) != "" {
			return "", fmt.Errorf("job %s step %d uses %q, which NixOS CI guests do not support yet", task.Job, i+1, step.Uses)
		}
		run := strings.TrimSpace(step.Run)
		if run == "" {
			continue
		}
		name := strings.TrimSpace(step.Name)
		if name == "" {
			name = "step " + strconv.Itoa(i+1)
		}
		lines = append(lines, "printf '::step %s\\n' "+shellQuote(name), run)
		ran++
	}
	if ran == 0 {
		return "", fmt.Errorf("job %s declares no run steps", task.Job)
	}
	if nixCIHasCacheAction(task, "save") {
		lines = append(lines, "smithers-ci cache save "+shellQuote(nixCICacheDescriptors)+" "+shellQuote(nixCICacheState))
	}
	return strings.Join(lines, "\n") + "\n", nil
}

// nixCIStartCommand stages the job script and detaches it, so the exec that
// starts the job returns immediately and the poll loop owns the wait. Writing
// the exit status to a file only after the command exits makes that file's
// existence the single completion signal — no process table scraping, which is
// what made the Debian runner image need `ps` in the first place.
func nixCIStartCommand(task nixCITask, script string) string {
	return strings.Join([]string{
		"set -euo pipefail",
		"mkdir -p " + shellQuote(nixCITaskLogDir) + " " + shellQuote(nixCIToolBinDir),
		"rm -f " + shellQuote(nixCITaskLogPath) + " " + shellQuote(nixCITaskExitPath) + " " + shellQuote(nixCICacheState),
		"cat > " + shellQuote(nixCIToolHelperPath) + " <<'SMITHERS_CI_HELPER_EOF'",
		strings.TrimRight(nixCIGuestHelper, "\n"),
		"SMITHERS_CI_HELPER_EOF",
		"chmod 0755 " + shellQuote(nixCIToolHelperPath),
		"cat > " + shellQuote(nixCICacheDescriptors) + " <<'SMITHERS_CI_CACHE_EOF'",
		nixCICacheDescriptorsJSON(task),
		"SMITHERS_CI_CACHE_EOF",
		"cat > " + shellQuote(nixCITaskScriptPath) + " <<'SMITHERS_CI_EOF'",
		strings.TrimRight(script, "\n"),
		"SMITHERS_CI_EOF",
		"chmod +x " + shellQuote(nixCITaskScriptPath),
		"touch " + shellQuote(nixCITaskLogPath),
		"nohup sh -c " + shellQuote(
			"bash "+shellQuote(nixCITaskScriptPath)+" >"+shellQuote(nixCITaskLogPath)+" 2>&1; "+
				"printf '%s' \"$?\" > "+shellQuote(nixCITaskExitPath),
		) + " >/dev/null 2>&1 &",
		"exit 0",
	}, "\n")
}

// nixCIPollCommand tails the log from a byte offset and reports completion.
// STDOUT carries only new log bytes so the caller can advance the offset by
// their length; the exit marker goes to STDERR.
func nixCIPollCommand(offset int64) string {
	if offset < 1 {
		offset = 1
	}
	return strings.Join([]string{
		"tail -c +" + strconv.FormatInt(offset, 10) + " " + shellQuote(nixCITaskLogPath) + " 2>/dev/null || true",
		"if [ -f " + shellQuote(nixCITaskExitPath) + " ]; then",
		"  printf '" + nixCITaskExitMarker + "%s' \"$(cat " + shellQuote(nixCITaskExitPath) + ")\" >&2",
		"fi",
	}, "\n")
}

// parseNixCIExitMarker extracts the job's exit status from a poll's STDERR.
// The second return value is false while the job is still running.
func parseNixCIExitMarker(stderr string) (int32, bool) {
	idx := strings.LastIndex(stderr, nixCITaskExitMarker)
	if idx < 0 {
		return 0, false
	}
	raw := strings.TrimSpace(stderr[idx+len(nixCITaskExitMarker):])
	if raw == "" {
		return 0, false
	}
	code, err := strconv.ParseInt(raw, 10, 32)
	if err != nil {
		// The file exists but holds garbage: the job is over and its result is
		// unknowable, which is a failure.
		return 1, true
	}
	return int32(code), true
}

// nixCIReadyTasks waits for every need to settle, then applies the same
// implicit success() rule as the runner plane.
func nixCIReadyTasks(tasks []nixCITask, outcomes map[string]nixCITaskOutcome, started map[int64]bool) (ready []nixCITask, skip []nixCITask) {
	for _, task := range tasks {
		if started[task.ID] || outcomes[task.Job] != "" {
			continue
		}
		settled := true
		needsResults := make(map[string]string, len(task.Needs))
		for _, need := range task.Needs {
			switch outcomes[strings.TrimSpace(need)] {
			case nixCITaskDone:
				needsResults[strings.TrimSpace(need)] = "success"
			case "":
				settled = false
			case nixCITaskFailed:
				needsResults[strings.TrimSpace(need)] = "failure"
			default:
				needsResults[strings.TrimSpace(need)] = string(outcomes[strings.TrimSpace(need)])
			}
		}
		if !settled {
			continue
		}
		shouldRun, err := DependentJobShouldRun(task.If, task.Event, needsResults)
		if err != nil || !shouldRun {
			skip = append(skip, task)
		} else {
			ready = append(ready, task)
		}
	}
	return ready, skip
}

// nixCIRunOutcome folds per-task outcomes into the run's terminal status, using
// the same precedence as UpdateWorkflowRunStatusBasedOnTasks: any failure wins,
// then cancellation, then success.
func nixCIRunOutcome(outcomes map[string]nixCITaskOutcome) nixCITaskOutcome {
	cancelled := false
	for _, outcome := range outcomes {
		switch outcome {
		case nixCITaskFailed:
			return nixCITaskFailed
		case nixCITaskCancelled:
			cancelled = true
		}
	}
	if cancelled {
		return nixCITaskCancelled
	}
	return nixCITaskDone
}

// executeNixCIRun runs one sandbox-plane CI run's whole job graph, one NixOS
// guest per task, and finalizes the run under the caller's claim fence.
func (w *WorkflowSandboxSchedulerWorker) executeNixCIRun(
	ctx context.Context,
	claim workflowSandboxRunClaim,
	env nixCIRunEnvironment,
) error {
	run := claim.Run
	logger := w.logger.With("run_id", run.ID)

	tasks, err := loadNixCITasks(ctx, w.queries, run.ID, run.RepositoryID)
	if err != nil {
		logger.Error("failed to load NixOS CI task graph", "error", err)
		return w.failRun(ctx, claim, 0, "failed to load workflow task graph")
	}

	outcomes := map[string]nixCITaskOutcome{}
	started := map[int64]bool{}
	var mu sync.Mutex
	for _, task := range tasks {
		switch outcome := nixCITaskOutcome(task.Status); outcome {
		case nixCITaskDone, nixCITaskFailed, nixCITaskCancelled, nixCITaskSkipped:
			started[task.ID] = true
			outcomes[task.Job] = outcome
		case "running":
			// A prior claim may have executed side effects before it died.
			started[task.ID] = true
			outcomes[task.Job] = nixCITaskFailed
			w.finalizeNixCITask(ctx, task, nixCITaskFailed, "job was interrupted when its scheduler lost the run")
		}
	}

	concurrency := w.nixCIConcurrency()
	for {
		mu.Lock()
		ready, skip := nixCIReadyTasks(tasks, outcomes, started)
		for _, task := range skip {
			started[task.ID] = true
			outcomes[task.Job] = nixCITaskSkipped
		}
		mu.Unlock()

		for _, task := range skip {
			if err := w.queries.SkipBlockedWorkflowTask(ctx, task.ID); err != nil {
				return w.failRun(ctx, claim, 0, "failed to skip blocked workflow task")
			}
			w.finalizeNixCITask(ctx, task, nixCITaskSkipped, "a job it needs did not succeed")
		}
		if len(skip) > 0 && len(ready) == 0 {
			continue
		}
		if len(ready) == 0 {
			mu.Lock()
			pending := len(started) < len(tasks)
			mu.Unlock()
			if pending {
				// Every remaining task waits on a dependency that will never
				// resolve. Treat the cycle as a run failure rather than
				// spinning.
				logger.Error("NixOS CI task graph has unreachable jobs", "tasks", len(tasks), "started", len(started))
				return w.failRun(ctx, claim, 0, "workflow task graph has unreachable jobs")
			}
			break
		}

		if len(ready) > concurrency {
			ready = ready[:concurrency]
		}
		var wg sync.WaitGroup
		for _, task := range ready {
			if len(task.Needs) > 0 {
				if err := w.queries.UnblockWorkflowTask(ctx, task.ID); err != nil {
					return w.failRun(ctx, claim, 0, "failed to unblock workflow task")
				}
			}
			mu.Lock()
			started[task.ID] = true
			mu.Unlock()
			wg.Add(1)
			go func(task nixCITask) {
				defer wg.Done()
				outcome := w.executeNixCITask(ctx, task, env)
				mu.Lock()
				outcomes[task.Job] = outcome
				mu.Unlock()
			}(task)
		}
		wg.Wait()
	}

	finalizeCtx, cancel := w.finalizeContext(ctx)
	defer cancel()
	switch nixCIRunOutcome(outcomes) {
	case nixCITaskFailed:
		return w.finalizeFailure(finalizeCtx, claim, 0, "workflow execution failed")
	case nixCITaskCancelled:
		return w.finalizeFailure(finalizeCtx, claim, 0, "workflow execution was cancelled")
	}
	terminal, err := w.queries.MarkWorkflowRunSuccess(finalizeCtx, claim.successParams())
	if err != nil {
		return err
	}
	RevokeWorkflowRunCredentials(finalizeCtx, w.queries, run.ID, run.RepositoryID)
	NotifyWorkflowRunEvent(finalizeCtx, w.queries, run.ID, "workflow_sandbox.success")
	w.publishTerminal(finalizeCtx, terminal)
	return nil
}

// nixCIRunEnvironment carries the per-run values every task guest needs: the
// repository identity, the workflow secrets, and the redaction table. Each
// guest receives its own short-lived clone credential when it boots.
type nixCIRunEnvironment struct {
	RepositoryID   int64
	Owner          string
	RepositoryName string
	CloneUserID    int64
	Revision       string
	Secrets        map[string]string
	RedactEnv      map[string]string
}

// executeNixCITask boots one guest, runs one job in it, streams its output, and
// destroys the guest. It returns the task's terminal outcome; every database
// write is already done when it returns.
func (w *WorkflowSandboxSchedulerWorker) executeNixCITask(
	ctx context.Context,
	task nixCITask,
	env nixCIRunEnvironment,
) nixCITaskOutcome {
	logger := w.logger.With("task_id", task.ID, "job", task.Job)

	script, err := nixCITaskCommand(task)
	if err != nil {
		w.appendNixCILog(ctx, task, "system", err.Error())
		w.finalizeNixCITask(ctx, task, nixCITaskFailed, err.Error())
		return nixCITaskFailed
	}

	taskCtx, cancel := context.WithTimeout(ctx, w.nixCITaskTimeout())
	defer cancel()

	vmID, cloneToken, err := w.provisionNixCIGuest(taskCtx, task, env)
	if err != nil {
		message := "failed to provision NixOS CI guest"
		logger.Error(message, "error", err)
		w.appendNixCILog(ctx, task, "system", message)
		outcome := nixCITaskFailed
		if ctx.Err() != nil {
			outcome = nixCITaskCancelled
		}
		w.finalizeNixCITask(ctx, task, outcome, message)
		return outcome
	}
	if cloneToken != "" {
		redactEnv := make(map[string]string, len(env.RedactEnv)+1)
		for name, value := range env.RedactEnv {
			redactEnv[name] = value
		}
		redactEnv["SMITHERS_REPO_CLONE_TOKEN"] = cloneToken
		env.RedactEnv = redactEnv
	}
	defer func() {
		deleteCtx, deleteCancel := context.WithTimeout(context.WithoutCancel(ctx), nixCIGuestDeleteTimeout)
		defer deleteCancel()
		if err := w.sandbox.DeleteSandbox(deleteCtx, vmID); err != nil {
			logger.Warn("failed to delete NixOS CI guest", "vm_id", vmID, "error", err)
		}
	}()

	_, _ = w.queries.MarkWorkflowTaskVMRunning(ctx, db.MarkWorkflowTaskVMRunningParams{
		VmID: pgtype.Text{String: vmID, Valid: true},
		ID:   task.ID,
	})
	_, _ = w.queries.UpdateWorkflowStepStatusRunning(ctx, task.StepID)

	// The job token reaches only this guest, only through the job's exec
	// environment, and is deleted when the job ends (the deferred revoke runs
	// before the guest is destroyed and after the task is terminal).
	jobEnv, revokeJobToken, err := w.issueNixCIJobToken(ctx, task, env.RepositoryID)
	defer revokeJobToken()
	if err != nil {
		logger.Warn("failed to issue NixOS CI job token", "error", err)
	}
	if len(jobEnv) == 0 && len(task.Cache) > 0 {
		w.appendNixCILog(ctx, task, "system", "[cache] unavailable")
	}
	if len(jobEnv) > 0 {
		secrets := make(map[string]string, len(env.Secrets)+len(jobEnv))
		for name, value := range env.Secrets {
			secrets[name] = value
		}
		redactEnv := make(map[string]string, len(env.RedactEnv)+1)
		for name, value := range env.RedactEnv {
			redactEnv[name] = value
		}
		for name, value := range jobEnv {
			secrets[name] = value
		}
		redactEnv["SMITHERS_CI_JOB_TOKEN"] = jobEnv["SMITHERS_CI_JOB_TOKEN"]
		env.Secrets = secrets
		env.RedactEnv = redactEnv
	}

	startTimeout := int64(nixCIPollTimeout / time.Millisecond)
	if _, err := w.sandbox.Execute(taskCtx, vmID, sandbox.ExecRequest{
		Command:   nixCIStartCommand(task, script),
		TimeoutMS: &startTimeout,
		Secrets:   env.Secrets,
	}); err != nil {
		message := "failed to start job in NixOS CI guest"
		logger.Error(message, "error", err)
		w.appendNixCILog(ctx, task, "system", message)
		w.finalizeNixCITask(ctx, task, nixCITaskFailed, message)
		return nixCITaskFailed
	}

	exitCode, outcome := w.streamNixCITask(taskCtx, vmID, task, env)
	switch outcome {
	case nixCITaskCancelled:
		w.finalizeNixCITask(ctx, task, nixCITaskCancelled, "run cancelled")
		return nixCITaskCancelled
	case nixCITaskFailed:
		w.finalizeNixCITask(ctx, task, nixCITaskFailed, "job did not complete")
		return nixCITaskFailed
	}
	if exitCode != 0 {
		message := fmt.Sprintf("job %s exited with status %d", task.Job, exitCode)
		w.appendNixCILog(ctx, task, "system", message)
		w.finalizeNixCITask(ctx, task, nixCITaskFailed, message)
		return nixCITaskFailed
	}
	w.finalizeNixCITask(ctx, task, nixCITaskDone, "")
	return nixCITaskDone
}

// provisionNixCIGuest boots one kind=vm guest with the repository checked out
// at the run's trigger revision. Provisioning — and only provisioning — is
// retried: a guest that never booted is infrastructure, while a command that
// ran and failed is a real CI result.
func (w *WorkflowSandboxSchedulerWorker) provisionNixCIGuest(
	ctx context.Context,
	task nixCITask,
	env nixCIRunEnvironment,
) (string, string, error) {
	if w.ciGuests == nil {
		return "", "", fmt.Errorf("NixOS CI guest provisioner is not wired")
	}
	cloneURL, cloneToken, revokeCloneToken, err := w.buildCloneURLWithToken(ctx, env.Owner, env.RepositoryName, env.CloneUserID, func() (temporaryRepoCloneToken, error) {
		return issueTemporaryBoundRepoCloneToken(ctx, w.queries, env.CloneUserID, env.RepositoryID, "workflow-ci-guest-clone")
	})
	if err != nil {
		return "", "", err
	}
	defer revokeCloneToken()
	req, err := w.ciGuests.CIGuestVMRequest(ctx, env.RepositoryID, []sandbox.GitRepositorySpec{
		{Repo: cloneURL, Path: nixCITaskWorkdir, Rev: env.Revision},
	})
	if err != nil {
		return "", "", err
	}
	w.applyNixCISizing(&req)

	var lastErr error
	for attempt := 1; attempt <= defaultNixCIProvisionAttempts; attempt++ {
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
		createCtx := sandboxProvisionContext(ctx, "create", "workflow_task", fmt.Sprint(task.ID), "attempt-"+strconv.Itoa(attempt))
		vm, err := createWorkspaceSandbox(createCtx, w.sandbox, req)
		if err == nil {
			return vm.ID, cloneToken, nil
		}
		if vm.ID != "" {
			deleteCtx, cancelDelete := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			deleteErr := w.sandbox.DeleteSandbox(deleteCtx, vm.ID)
			cancelDelete()
			if deleteErr != nil {
				return "", "", errors.Join(err, fmt.Errorf("clean up failed CI guest %s: %w", vm.ID, deleteErr))
			}
		}
		lastErr = err
		w.logger.Warn("NixOS CI guest create failed", "task_id", task.ID, "attempt", attempt, "error", err)
	}
	return "", "", lastErr
}

// applyNixCISizing lets CI guests be sized independently of interactive
// workspaces. Unset, both come from the same SMITHERS_SANDBOX_WORKSPACE_*
// knobs the request already carries.
func (w *WorkflowSandboxSchedulerWorker) applyNixCISizing(req *sandbox.CreateRequest) {
	if vcpu := envInt32("SMITHERS_SANDBOX_CI_VCPU_COUNT", 0); vcpu > 0 {
		value := vcpu
		req.VCPUCount = &value
	}
	if mem := envInt32("SMITHERS_SANDBOX_CI_MEMORY_MB", 0); mem > 0 {
		value := mem
		req.MemSizeMB = &value
	}
}

// streamNixCITask polls the guest log from a byte offset and appends new lines
// to workflow_logs until the job exits, the task ceiling expires, or the run is
// cancelled. The cadence mirrors the runner's live flush so both planes feel
// the same while a job runs.
func (w *WorkflowSandboxSchedulerWorker) streamNixCITask(
	ctx context.Context,
	vmID string,
	task nixCITask,
	env nixCIRunEnvironment,
) (int32, nixCITaskOutcome) {
	offset := int64(1)
	pollTimeout := int64(nixCIPollTimeout / time.Millisecond)
	lines := newNixCILogLines(env.RedactEnv)
	defer func() { w.appendNixCILines(ctx, task, lines.flush()) }()

	for {
		resp, err := w.sandbox.Execute(ctx, vmID, sandbox.ExecRequest{
			Command:   nixCIPollCommand(offset),
			TimeoutMS: &pollTimeout,
		})
		if err != nil {
			if ctx.Err() != nil {
				return 0, w.nixCIInterruptOutcome(ctx)
			}
			w.logger.Warn("NixOS CI log poll failed", "task_id", task.ID, "error", err)
		} else {
			if resp.Stdout != "" {
				w.appendNixCILines(ctx, task, lines.push(resp.Stdout))
				offset += int64(len(resp.Stdout))
			}
			if code, done := parseNixCIExitMarker(resp.Stderr); done {
				return code, nixCITaskDone
			}
		}

		select {
		case <-ctx.Done():
			return 0, w.nixCIInterruptOutcome(ctx)
		case <-time.After(w.ciPollIntervalOrDefault()):
		}
	}
}

// nixCIInterruptOutcome distinguishes a cancelled run from an expired task
// ceiling. The claim watchdog cancels the run context when the run leaves
// 'running' (which is what CancelRun does), so a cancellation surfaces here as
// context.Canceled while the per-task ceiling surfaces as DeadlineExceeded.
func (w *WorkflowSandboxSchedulerWorker) nixCIInterruptOutcome(ctx context.Context) nixCITaskOutcome {
	if ctx.Err() == context.DeadlineExceeded {
		return nixCITaskFailed
	}
	return nixCITaskCancelled
}

// finalizeNixCITask writes one task's terminal state and its step's, on a
// context detached from the task's own (which is usually already expired or
// cancelled by the time a terminal state is known).
func (w *WorkflowSandboxSchedulerWorker) finalizeNixCITask(
	ctx context.Context,
	task nixCITask,
	outcome nixCITaskOutcome,
	detail string,
) {
	finalizeCtx, cancel := w.finalizeContext(ctx)
	defer cancel()

	taskStatus := string(outcome)
	stepStatus := "success"
	switch outcome {
	case nixCITaskFailed:
		stepStatus = "failure"
	case nixCITaskCancelled:
		stepStatus = "cancelled"
	case nixCITaskSkipped:
		// workflow_tasks carries 'skipped'; workflow_steps calls it the same.
		stepStatus = "skipped"
	}

	lastError := pgtype.Text{}
	if strings.TrimSpace(detail) != "" {
		lastError = pgtype.Text{String: detail, Valid: true}
	}
	if _, err := w.queries.MarkWorkflowTaskTerminalByID(finalizeCtx, db.MarkWorkflowTaskTerminalByIDParams{
		Status:    taskStatus,
		LastError: lastError,
		ID:        task.ID,
	}); err != nil {
		w.logger.Warn("failed to finalize NixOS CI task", "task_id", task.ID, "status", taskStatus, "error", err)
	}
	if _, err := w.queries.UpdateWorkflowStepStatusTerminal(finalizeCtx, db.UpdateWorkflowStepStatusTerminalParams{
		StepID: task.StepID,
		Status: stepStatus,
	}); err != nil {
		w.logger.Warn("failed to finalize NixOS CI step", "step_id", task.StepID, "status", stepStatus, "error", err)
	}
}

// appendNixCILines appends already-redacted log lines in order. Order matters:
// these rows are what the run's live log SSE stream replays.
func (w *WorkflowSandboxSchedulerWorker) appendNixCILines(ctx context.Context, task nixCITask, lines []string) {
	for _, line := range lines {
		w.appendNixCILog(ctx, task, "stdout", line)
	}
}

// nixCILogLines turns a task's polled log bytes into redacted log lines. Polls
// cut the log at arbitrary byte offsets, so it redacts only complete lines and
// carries the unterminated tail into the next poll; redacting each poll's
// fragment on its own would let a secret split across two polls escape
// RedactSecretValues in both halves.
type nixCILogLines struct {
	redactEnv map[string]string
	// longestSecret is the byte length of the longest value RedactSecretValues
	// masks: a forced flush keeps at least longestSecret-1 bytes back.
	longestSecret int
	pending       string
}

func newNixCILogLines(redactEnv map[string]string) *nixCILogLines {
	longest := 0
	for _, value := range redactEnv {
		longest = max(longest, len(strings.TrimSpace(value)))
	}
	return &nixCILogLines{redactEnv: redactEnv, longestSecret: longest}
}

// push adds one poll's bytes and returns the lines they completed.
func (l *nixCILogLines) push(chunk string) []string {
	// Normalize after joining so a CRLF split across polls still collapses.
	text := strings.ReplaceAll(l.pending+chunk, "\r\n", "\n")
	cut := strings.LastIndex(text, "\n") + 1
	if tail := text[cut:]; len(tail) > nixCIMaxPendingLogBytes+l.longestSecret {
		cut += l.safeCut(tail)
	}
	l.pending = text[cut:]
	return l.redactLines(text[:cut])
}

// flush returns whatever is still held back, for when the log ends.
func (l *nixCILogLines) flush() []string {
	text := l.pending
	l.pending = ""
	return l.redactLines(text)
}

// safeCut picks where to break an oversized unterminated line: far enough
// from its end that a secret still being written cannot straddle the break,
// and never inside a secret or a UTF-8 sequence already in the line.
func (l *nixCILogLines) safeCut(line string) int {
	cut := len(line) - max(l.longestSecret-1, 0)
	for moved := true; moved; {
		moved = false
		for cut > 0 && cut < len(line) && !utf8.RuneStart(line[cut]) {
			cut--
			moved = true
		}
		for _, value := range l.redactEnv {
			secret := strings.TrimSpace(value)
			if secret == "" {
				continue
			}
			for start := max(cut-len(secret)+1, 0); start < cut; start++ {
				if strings.HasPrefix(line[start:], secret) {
					cut = start
					moved = true
					break
				}
			}
		}
	}
	if cut == 0 {
		// Back-to-back secrets fill the whole line; flushing it all still
		// redacts every complete one.
		return len(line)
	}
	return cut
}

func (l *nixCILogLines) redactLines(text string) []string {
	redacted := RedactSecretValues(l.redactEnv, text)
	lines := []string{}
	for _, line := range strings.Split(redacted, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func (w *WorkflowSandboxSchedulerWorker) appendNixCILog(ctx context.Context, task nixCITask, stream, entry string) {
	logCtx, cancel := w.finalizeContext(ctx)
	defer cancel()
	if err := w.appendLog(logCtx, task.WorkflowRunID, task.StepID, stream, entry); err != nil {
		w.logger.Warn("failed to append NixOS CI log", "task_id", task.ID, "error", err)
	}
}

func (w *WorkflowSandboxSchedulerWorker) nixCITaskTimeout() time.Duration {
	timeout := envDuration("SMITHERS_WORKFLOW_NIX_CI_TASK_TIMEOUT",
		envDuration("SMITHERS_RUNNER_TASK_TIMEOUT", defaultNixCITaskTimeout))
	if timeout <= 0 {
		return defaultNixCITaskTimeout
	}
	return timeout
}

func (w *WorkflowSandboxSchedulerWorker) ciPollIntervalOrDefault() time.Duration {
	if w.ciPollInterval > 0 {
		return w.ciPollInterval
	}
	return nixCIPollInterval
}

func (w *WorkflowSandboxSchedulerWorker) nixCIRunTimeout() time.Duration {
	timeout := envDuration("SMITHERS_WORKFLOW_NIX_CI_RUN_TIMEOUT", defaultNixCIRunTimeout)
	if timeout <= 0 {
		return defaultNixCIRunTimeout
	}
	return timeout
}

func (w *WorkflowSandboxSchedulerWorker) nixCIConcurrency() int {
	limit := int(envInt32("SMITHERS_WORKFLOW_NIX_CI_CONCURRENCY", int32(defaultNixCIRunConcurrency)))
	if limit <= 0 {
		return defaultNixCIRunConcurrency
	}
	return limit
}
