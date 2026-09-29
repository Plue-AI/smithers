package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

var (
	agentDispatchJSONMarshal  = json.Marshal
	agentDispatchListMessages = func(s *AgentService, ctx context.Context, sessionID string, page, perPage int) ([]AgentMessageResponse, error) {
		return s.ListMessages(ctx, sessionID, page, perPage)
	}
)

// agentDispatch encapsulates the state accumulated during agent run dispatch.
// Each step method populates fields that subsequent steps depend on.
type agentDispatch struct {
	sandboxConfig          AgentSandboxConfig
	sandboxStartAuthorized bool
	svc                    *AgentService
	ctx                    context.Context
	input                  DispatchAgentRunInput

	// Accumulated state from each step
	wfDef          db.WorkflowDefinition
	run            db.WorkflowRun
	step           db.WorkflowStep
	plaintext      string
	tokenHash      string
	payload        []byte
	repositoryPath string
	task           db.WorkflowTask

	// Clone token state
	gitRepos       []sandbox.GitRepositorySpec
	tempCloneToken temporaryRepoCloneToken
	hasCloneToken  bool

	// Per-run scoped jjhub API token (write:repository) injected into the VM so
	// runner tools can call the REST API as the user. Survives the whole run and
	// is revoked at run end (never in createVM like the clone token).
	jjhubToken    temporaryRepoCloneToken
	hasJJHubToken bool

	// triggerText is the exact text of the admitted message this run
	// answers (TriggerMessageID), empty when the window does not hold it.
	triggerText string

	// Egress-proxy state: secrets the guest must never hold. egressSecrets is
	// handed to the provider once in createVM; egressNames lets the
	// credential guard recognize a placeholder. Both are empty when the
	// deployment runs with the legacy in-guest path.
	egressSecrets []sandbox.EgressProxySecret
	// repositorySeats are platform model providers the repository keys itself.
	repositorySeats map[string]struct{}
	// secretsInjected is set once repository secrets are in the service env.
	secretsInjected bool
	egressNames     map[string]struct{}

	// VM state
	agentServiceSpec sandbox.ServiceSpec
	vmReq            sandbox.CreateRequest
	vmCreateDuration time.Duration
	vm               sandbox.CreateResult
	vmCreated        bool
	watchdogStarted  bool
	// RFD-004: the workspace this run executes in ("" on the ephemeral
	// path) and whether its agent unit was started (decides fail vs suspend
	// in cleanup).
	workspaceID     string
	serviceStarted  bool
	flowOperationID string

	// infraFailedMarked is set to true when markAgentDispatchInfrastructureFailed
	// has already been called for this dispatch, to prevent double-calling during
	// cleanup() after a step that already called markInfraFailed.
	infraFailedMarked bool
	// A failed admission COMMIT may still have persisted the run and session
	// link. Cleanup must fail that run without mutating a later session retry.
	runAdmissionUncertain bool
}

// agentTaskPayload is the JSON structure persisted in workflow_tasks.payload for agent runs.
// It contains only non-sensitive routing metadata. Credentials (agent_token) are
// intentionally absent — they are injected into the sandbox provider VM systemd environment
// directly at dispatch time and are never written to durable storage.
type agentTaskPayload struct {
	Kind           string                    `json:"kind"`
	SessionID      string                    `json:"session_id"`
	RepositoryID   int64                     `json:"repository_id"`
	WorkflowRunID  int64                     `json:"workflow_run_id"`
	APIBaseURL     string                    `json:"api_base_url"`
	RepoOwner      string                    `json:"repo_owner"`
	RepoName       string                    `json:"repo_name"`
	AgentProvider  string                    `json:"agent_provider"`
	AgentTransport string                    `json:"agent_transport"`
	MessageHistory []agentTaskPayloadMessage `json:"message_history"`
	RepositoryPath string                    `json:"repository_path,omitempty"`
}

// execute runs all dispatch steps in sequence. If any step fails, cleanup is
// called and the error is returned.
func (d *agentDispatch) execute() (DispatchAgentRunResult, error) {
	steps := []func() error{
		d.authorize,
		d.ensureNoActiveRun,
		d.enforceConcurrencyCap,
		d.upsertWorkflowDefinition,
		d.createWorkflowRun,
		d.createWorkflowStep,
		d.generateToken,
		d.storeTokenHash,
		d.loadMessageHistory,
		d.createWorkflowTask,
		d.admitCodingTurn,
		d.refuseRetiredAgentLoop,
		d.prepareRepoClone,
		d.mintJJHubToken,
		d.buildServiceSpec,
		d.injectSecrets,
		d.requireProviderCredential,
		d.reserveFleetSlot,
		d.createVM,
	}
	// What actually runs the turn. On the coding path the workspace's own
	// `smithers-coding-host serve` runs it, so no second unit is started —
	// and in particular the command-less agent unit buildServiceSpec still
	// assembles (for its env, its credential guard and its egress bindings)
	// is never handed to the box. On every other path the loop is still
	// retired, which refuseRetiredAgentLoop already refused above.
	if d.codingDispatchEnabled() {
		steps = append(steps, d.markTaskRunning)
	} else {
		steps = append(steps, d.startService, d.markTaskRunning)
	}
	for _, step := range steps {
		if err := step(); err != nil {
			d.cleanup()
			return DispatchAgentRunResult{}, err
		}
	}

	d.recordSuccess()

	return DispatchAgentRunResult{
		WorkflowRunID:  d.run.ID,
		WorkflowTaskID: d.task.ID,
		OperationID:    d.flowOperationID,
		AgentToken:     d.plaintext,
	}, nil
}

// cleanup centralizes all the scattered cleanup logic. It revokes clone tokens,
// cancels watchdogs, deletes VMs, and marks workflow infra as failed when DB
// records were already created. This prevents orphaned run/step/task rows
// that would be left in "queued" or "pending" state after a partial failure.
func (d *agentDispatch) cleanup() {
	// The dispatch context may already be cancelled or expired (that is often
	// exactly why we are cleaning up). Run cleanup on a detached context with
	// its own deadline so VM deletion, token revocation, and status writes
	// still go through.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(d.ctx), 30*time.Second)
	defer cancel()

	d.revokeCloneTokenWithContext(ctx)
	if d.hasJJHubToken {
		revokeTemporaryRepoCloneToken(ctx, d.svc.dispatchQ, d.input.UserID, d.jjhubToken.ID)
		_ = d.svc.dispatchQ.ClearWorkflowRunJJHubTokenID(ctx, d.run.ID)
		d.hasJJHubToken = false
		d.jjhubToken = temporaryRepoCloneToken{}
	}
	if d.watchdogStarted {
		d.svc.cancelAgentRuntimeWatchdogForRun(d.input.SessionID, d.run.ID)
	}
	if d.vmCreated && d.workspaceID != "" {
		// RFD-004: a workspace whose agent never started is failed (quota
		// released); one whose agent ran is suspended and kept.
		logger := middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, d.input.SessionID, d.run.ID)
		if d.serviceStarted {
			if err := d.svc.workspaces.SuspendAgentWorkspace(ctx, d.workspaceID); err != nil {
				logger.Error("failed to suspend agent workspace during dispatch cleanup", "workspace_id", d.workspaceID, "error", err)
			}
		} else if err := d.svc.workspaces.FailAgentWorkspace(ctx, d.workspaceID); err != nil {
			logger.Error("failed to fail agent workspace during dispatch cleanup", "workspace_id", d.workspaceID, "error", err)
		}
	} else if d.vmCreated {
		if err := d.svc.sandbox.DeleteSandbox(ctx, d.vm.ID); err != nil {
			middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, d.input.SessionID, d.run.ID).
				Error("failed to delete sandbox during dispatch cleanup", "vm_id", d.vm.ID, "error", err)
		}
	}
	// Mark workflow infra as failed whenever a run was created but dispatch
	// did not complete successfully and markInfraFailed has not already been
	// called (to prevent double-calling). This handles the window between
	// createWorkflowRun and the first markInfraFailed call site
	// (prepareRepoClone onward) where a failure would otherwise leave DB rows
	// in a stale "queued" or "pending" state.
	if d.run.ID != 0 && !d.infraFailedMarked {
		sessionID := d.input.SessionID
		if d.runAdmissionUncertain {
			sessionID = ""
		}
		d.svc.markAgentDispatchInfrastructureFailed(ctx, d.task.ID, d.step.ID, d.run.ID, sessionID, "dispatch failed")
	}
	if d.flowOperationID != "" {
		d.cancelCodingTurn(ctx)
	}
}

// revokeCloneToken revokes the temporary repo clone token if one was issued.
func (d *agentDispatch) revokeCloneToken() {
	d.revokeCloneTokenWithContext(d.ctx)
}

func (d *agentDispatch) revokeCloneTokenWithContext(ctx context.Context) {
	if !d.hasCloneToken {
		return
	}
	revokeTemporaryRepoCloneToken(ctx, d.svc.dispatchQ, d.input.UserID, d.tempCloneToken.ID)
	d.hasCloneToken = false
	d.tempCloneToken = temporaryRepoCloneToken{}
}

// markInfraFailed marks the dispatch as infrastructure-failed and returns a
// wrapped internal error. This is a convenience for steps that need both.
// It sets infraFailedMarked to prevent a duplicate call from cleanup().
//
// The terminal writes run on a detached bounded context: the dispatch context
// being cancelled/expired is often the very reason a step failed, and using it
// here would silently skip persisting the failure while the flag suppresses
// cleanup()'s retry — leaving the run/task/session stuck in an active state.
func (d *agentDispatch) markInfraFailed(message string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(d.ctx), 30*time.Second)
	defer cancel()
	d.infraFailedMarked = true
	d.svc.markAgentDispatchInfrastructureFailed(ctx, d.task.ID, d.step.ID, d.run.ID, d.input.SessionID, message)
	return pkgerrors.Internal(message)
}

// agentLoopRetiredMessage is the one sentence every refused dispatch carries.
// It names the missing piece rather than the deleted one, because the only
// action that unblocks a dispatch is a Smithers 1.0 entrypoint for a single
// task.
const agentLoopRetiredMessage = "Cloud agent dispatch is disabled: plue's own 0.x agent loop was deleted and Smithers 1.0 has no verb that runs one dispatched task in a box. " +
	"The 1.0 coding host is a long-lived gateway (`smithers-coding-host serve`) whose flows are started over its control RPC, not a per-task process plue can exec. " +
	"Its nearest flow, `coding/Request`, is not a drop-in: it is only registered when the host is launched with SMITHERS_CODING_PROJECT naming a project JSON in the repository, " +
	"its input is a single prompt with no session history, role or model, and its result is a plan plus check receipts rather than the assistant turns this session shows. " +
	"Re-enabling needs a 1.0 flow that runs one dispatched turn, a plue caller that drives it over the workspace gateway, and a poller that streams its progress into this run."

// refuseRetiredAgentLoop fails the dispatch before it mints a clone token, a
// repository API token or a box.
//
// plue must not own an agent loop. The 0.x loop it used to exec in the guest
// (`/usr/local/bin/bun run ./agent.ts` out of cmd/runner/workflow, on the
// retired smithers-orchestrator 0.x library) is deleted, and so is the
// codex-only Go stand-in that shadowed it. Smithers 1.0 ships no replacement
// for "run this one task and report back": its coding host is a server, and
// its CLI has no agent verb. Rather than keep retired code alive, the dispatch
// records a typed failure on the run the caller is watching.
//
// The step runs after the run/step/task rows exist so the session shows the
// refusal, and before prepareRepoClone so nothing is provisioned for a run
// that cannot start.
func (d *agentDispatch) refuseRetiredAgentLoop() error {
	// The dispatched turn is the replacement this refusal names. Where it is
	// wired and the run has a workspace to host it, there is nothing to
	// refuse. Everywhere else the message below is still true.
	if d.svc.guestEntrypointAssumed || d.codingDispatchEnabled() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(d.ctx), 30*time.Second)
	defer cancel()
	d.infraFailedMarked = true
	d.svc.markAgentDispatchInfrastructureFailed(ctx, d.task.ID, d.step.ID, d.run.ID, d.input.SessionID, agentLoopRetiredMessage)
	return &pkgerrors.APIError{
		Status:  http.StatusNotImplemented,
		Code:    pkgerrors.CodeAgentLoopRetired,
		Message: agentLoopRetiredMessage,
	}
}

// --- Step methods ---

func (d *agentDispatch) authorize() error {
	if d.svc.dispatchQ == nil {
		return pkgerrors.Internal("agent dispatch querier unavailable")
	}
	if d.svc.sandbox == nil && !d.codingDispatchEnabled() {
		return pkgerrors.Internal("sandbox provider unavailable")
	}
	if len(d.input.AllowedPaths) > 1024 {
		return pkgerrors.BadRequest("allowed_paths exceeds the maximum of 1024 entries")
	}
	totalAllowedPathBytes := 0
	for _, allowedPath := range d.input.AllowedPaths {
		trimmed := strings.TrimSpace(allowedPath)
		totalAllowedPathBytes += len(trimmed)
		if trimmed == "" || len(trimmed) > 1024 || strings.HasPrefix(trimmed, "/") || strings.Contains(trimmed, "\x00") || path.Clean(trimmed) == ".." || strings.HasPrefix(path.Clean(trimmed), "../") {
			return pkgerrors.BadRequest("allowed_paths must contain safe repository-relative paths or globs")
		}
	}
	if totalAllowedPathBytes > 24*1024 {
		return pkgerrors.BadRequest("allowed_paths exceeds the maximum encoded size")
	}
	return nil
}

// ensureNoActiveRun rejects the dispatch when the session already has an
// active (queued/running) run. Without this, every role=user message would
// re-point agent_sessions.workflow_run_id at a fresh run, 401-locking the
// still-running agent's callbacks and leaking its VM.
func (d *agentDispatch) ensureNoActiveRun() error {
	return d.svc.EnsureSessionDispatchable(d.ctx, d.input.SessionID)
}

// enforceConcurrencyCap fast-fails a NEW agent dispatch when the fleet is
// already at its active-agent-VM cap. It is the largest cost-elasticity guard
// in the stack: without it a runaway agent loop provisions sandbox provider VMs
// without bound (max_agent_session_duration only caps each VM's lifetime, not
// how many spawn).
//
// It runs BEFORE any DB row or VM is created (right after ensureNoActiveRun),
// so the current session is not yet counted and a plain current >= max
// comparison is correct.
//
// The count is a fleet-wide DB COUNT (CountActiveAgentSessionVMs), so it is
// correct across all API pods — an in-process atomic counter would undercount
// with 2-12 replicas.
//
// Fails OPEN on a counter error: the cap is a sandbox provider-spend guard, not a
// security boundary, and a transient DB blip must not wedge every agent run.
//
// This precheck is a SOFT read: concurrent dispatches can all observe the same
// below-cap count. The HARD gate is reserveFleetSlot, which atomically
// re-counts and stamps started_at (making the session count immediately) just
// before the slow CreateSandbox call. This step exists only to reject cap-exceeded
// dispatches cheaply, before any run/step/task rows or tokens are created.
func (d *agentDispatch) enforceConcurrencyCap() error {
	if err := authorizeSandboxStartForUser(d.ctx, d.svc.billing, d.input.UserID); err != nil {
		return err
	}
	d.sandboxConfig = d.svc.sandboxConfig
	if d.svc.billing != nil {
		entitlement, err := sandboxEntitlementForUser(d.ctx, d.svc.billing, d.input.UserID)
		if err != nil {
			return err
		}
		d.sandboxStartAuthorized = true
		if entitlement.IdleTimeoutSecs != 0 {
			d.sandboxConfig.IdleTimeout = time.Duration(entitlement.IdleTimeoutSecs) * time.Second
		}
	}

	if d.svc.concurrencyCounter == nil || d.svc.concurrencyMax <= 0 {
		return nil
	}
	current, err := d.svc.concurrencyCounter.CountActiveAgentSessionVMs(d.ctx)
	if err != nil {
		middleware.LoggerWithAgentSession(d.ctx, d.input.SessionID).
			Warn("agent concurrency count failed; allowing dispatch", "error", err)
		return nil
	}
	if current >= d.svc.concurrencyMax {
		return pkgerrors.QuotaExceeded("concurrent agent session limit reached")
	}
	return nil
}

func (d *agentDispatch) upsertWorkflowDefinition() error {
	wfDef, err := d.svc.dispatchQ.UpsertAgentWorkflowDefinition(d.ctx, d.input.RepositoryID)
	if err != nil {
		return pkgerrors.Internal("upsert agent workflow definition: " + err.Error())
	}
	d.wfDef = wfDef
	return nil
}

func (d *agentDispatch) createWorkflowRun() error {
	commit := func(ctx context.Context, conn db.DBTX) error {
		queries := d.svc.dispatchQ
		if conn != nil {
			queries = db.New(conn)
		}
		run, err := queries.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
			RepositoryID:         d.input.RepositoryID,
			WorkflowDefinitionID: d.wfDef.ID,
			Status:               "queued",
			TriggerEvent:         "agent_message",
			TriggerRef:           "",
			TriggerCommitSha:     "",
			// Agent runs are driven end-to-end by this dispatch: the agent plane
			// keeps both queue consumers (gVisor task runner and sandbox
			// whole-workflow scheduler) from claiming the run or its task.
			ExecutionPlane: WorkflowRunPlaneAgent,
		})
		if err != nil {
			return pkgerrors.Internal("create workflow run: " + err.Error())
		}
		// Claim in the admission transaction so a crash cannot leave an
		// unlinked monthly reservation. The session reaper can recover a linked
		// run even when no task was created. The claim also fences concurrent
		// dispatches that both passed ensureNoActiveRun's unlocked precheck.
		claimed, err := queries.ClaimAgentSessionForDispatch(ctx, d.input.SessionID, run.ID)
		if err != nil || !claimed {
			if conn == nil {
				// An unlimited policy may use ordinary queries instead of an
				// admission transaction. Its insert is already durable; fail only
				// that run, never the session held by the winning dispatch.
				cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
				d.svc.markAgentDispatchInfrastructureFailed(cleanupCtx, 0, 0, run.ID, "", "session claim failed")
				cancel()
			}
			if err != nil {
				return pkgerrors.Internal("link session to workflow run: " + err.Error())
			}
			return pkgerrors.Conflict("agent session already has an active run")
		}
		// Retain the identity before COMMIT: a lost commit acknowledgment must
		// not make cleanup forget a run that the database already persisted.
		d.run = run
		return nil
	}
	if d.svc.billing != nil {
		if err := d.svc.billing.AuthorizeAgentRunCommitted(d.ctx, d.input.RepositoryID, commit); err != nil {
			d.runAdmissionUncertain = d.run.ID != 0
			return err
		}
	} else if err := commit(d.ctx, nil); err != nil {
		return err
	}
	return nil
}

func (d *agentDispatch) createWorkflowStep() error {
	step, err := d.svc.dispatchQ.CreateWorkflowStep(d.ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: d.run.ID,
		Name:          "agent",
		Position:      0,
		Status:        "queued",
	})
	if err != nil {
		return pkgerrors.Internal("create workflow step: " + err.Error())
	}
	d.step = step
	return nil
}

func (d *agentDispatch) generateToken() error {
	plaintext, tokenHash, err := generateAgentToken()
	if err != nil {
		return pkgerrors.Internal("generate agent token: " + err.Error())
	}
	d.plaintext = plaintext
	d.tokenHash = tokenHash
	return nil
}

func (d *agentDispatch) storeTokenHash() error {
	_, err := d.svc.dispatchQ.UpdateWorkflowRunAgentToken(d.ctx, db.UpdateWorkflowRunAgentTokenParams{
		AgentTokenHash: pgtype.Text{String: d.tokenHash, Valid: true},
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Time:  time.Now().Add(24 * time.Hour),
			Valid: true,
		},
		ID: d.run.ID,
	})
	if err != nil {
		return pkgerrors.Internal("store agent token hash: " + err.Error())
	}
	return nil
}

// agentDispatchHistoryWindow bounds how many messages are shipped to the
// runner in the task payload. It must not exceed ListMessages' 200 per-page
// clamp.
const agentDispatchHistoryWindow = 200

func (d *agentDispatch) loadMessageHistory() error {
	messageHistory, err := d.loadLatestMessageWindow(agentDispatchHistoryWindow)
	if err != nil {
		// Dispatching with silently empty history would make the agent lose all
		// prior conversation context; fail the dispatch instead.
		return pkgerrors.Internal("load agent message history: " + err.Error())
	}
	if messageHistory == nil {
		messageHistory = []AgentMessageResponse{}
	}

	d.repositoryPath = ""
	serializedHistory := serializeAgentTaskMessageHistory(messageHistory)
	d.triggerText = agentTriggerMessageText(messageHistory, d.input.TriggerMessageID)

	payload, err := agentDispatchJSONMarshal(agentTaskPayload{
		Kind:           "agent",
		SessionID:      d.input.SessionID,
		RepositoryID:   d.input.RepositoryID,
		WorkflowRunID:  d.run.ID,
		APIBaseURL:     d.svc.apiBaseURL,
		RepoOwner:      d.input.RepoOwner,
		RepoName:       d.input.RepoName,
		AgentProvider:  normalizeAgentProvider(d.input.AgentProvider),
		AgentTransport: normalizeAgentTransport(d.input.AgentTransport),
		MessageHistory: serializedHistory,
		RepositoryPath: d.repositoryPath,
		// AgentToken intentionally omitted — injected into the sandbox provider VM systemd
		// environment at dispatch time; never persisted in the DB task payload.
	})
	if err != nil {
		return pkgerrors.Internal("marshal task payload: " + err.Error())
	}
	d.payload = payload
	return nil
}

// loadLatestMessageWindow returns the most recent `window` messages of the
// session in ascending sequence order. ListMessages pages oldest-first, so a
// plain page-1 read returns the OLDEST messages of a long session and silently
// drops the newest — including the user message that triggered this dispatch.
// Count first, then read the tail page (plus the one before it when the tail
// is short) and keep the last `window` messages.
func (d *agentDispatch) loadLatestMessageWindow(window int) ([]AgentMessageResponse, error) {
	total, err := d.svc.q.CountAgentMessagesBySession(d.ctx, d.input.SessionID)
	if err != nil {
		return nil, err
	}
	if total <= int64(window) {
		return agentDispatchListMessages(d.svc, d.ctx, d.input.SessionID, 1, window)
	}

	lastPage := int((total + int64(window) - 1) / int64(window))
	tail, err := agentDispatchListMessages(d.svc, d.ctx, d.input.SessionID, lastPage, window)
	if err != nil {
		return nil, err
	}
	if len(tail) >= window || lastPage < 2 {
		return tail, nil
	}
	previous, err := agentDispatchListMessages(d.svc, d.ctx, d.input.SessionID, lastPage-1, window)
	if err != nil {
		return nil, err
	}
	combined := append(previous, tail...)
	if len(combined) > window {
		combined = combined[len(combined)-window:]
	}
	return combined, nil
}

func (d *agentDispatch) createWorkflowTask() error {
	task, err := d.svc.dispatchQ.CreateWorkflowTask(d.ctx, db.CreateWorkflowTaskParams{
		WorkflowRunID:  d.run.ID,
		WorkflowStepID: d.step.ID,
		RepositoryID:   d.input.RepositoryID,
		Status:         "pending",
		Priority:       3,
		Payload:        d.payload,
		AvailableAt:    time.Now(),
		VmID:           pgtype.Text{Valid: false},
	})
	if err != nil {
		return pkgerrors.Internal("create workflow task: " + err.Error())
	}
	d.task = task
	return nil
}

func (d *agentDispatch) prepareRepoClone() error {
	if strings.TrimSpace(d.input.RepoOwner) == "" || strings.TrimSpace(d.input.RepoName) == "" {
		return nil
	}

	tempCloneToken, err := issueTemporaryRepoCloneToken(d.ctx, d.svc.dispatchQ, d.input.UserID, "sandbox-agent-clone")
	if err != nil {
		return d.markInfraFailed("create repo clone token: " + err.Error())
	}
	d.tempCloneToken = tempCloneToken
	d.hasCloneToken = true

	cloneURL, cloneErr := buildAuthenticatedRepoCloneURL(d.svc.gitBaseURL, d.input.RepoOwner, d.input.RepoName, d.tempCloneToken.Plaintext)
	if cloneErr != nil {
		return d.markInfraFailed("build repo clone url: " + cloneErr.Error())
	}

	d.repositoryPath = "/workspace"
	if d.workspaceMode() {
		// RFD-004: the workspace service clones as the workspace user into
		// the workspace's own checkout path.
		d.repositoryPath = defaultWorkspaceClonePath
	}
	d.gitRepos = []sandbox.GitRepositorySpec{
		{
			Repo: cloneURL,
			Path: d.repositoryPath,
		},
	}

	// A changeset run also materializes every member repository at the commit
	// the changeset pinned, laid out as /workspace/<org>/<repo>, so the agent
	// sees the same revision vector the reviewer will see.
	if d.input.ChangesetID > 0 {
		if d.svc.changesetMaterializer == nil {
			return d.markInfraFailed("changeset materialization is not available on this deployment")
		}
		members, err := d.svc.changesetMaterializer.MaterializeChangeset(d.ctx, d.input.UserID, d.input.ChangesetID)
		if err != nil {
			return d.markInfraFailed("materialize changeset: " + err.Error())
		}
		for _, member := range members {
			memberURL, urlErr := buildAuthenticatedRepoCloneURL(d.svc.gitBaseURL, member.Owner, member.Repo, d.tempCloneToken.Plaintext)
			if urlErr != nil {
				return d.markInfraFailed("build changeset member clone url: " + urlErr.Error())
			}
			d.gitRepos = append(d.gitRepos, sandbox.GitRepositorySpec{
				Repo: memberURL,
				Path: d.repositoryPath + "/" + member.Owner + "/" + member.Repo,
				Rev:  member.CommitID,
			})
		}
	}
	return nil
}

// mintJJHubToken issues a per-run write-scoped jjhub API token so the agent's
// runner tools can call the REST API (landings/bookmarks/issues) as the owning
// user, and persists its id on the workflow run so terminal paths can revoke it.
// Unlike the clone token it is NOT revoked in createVM — it must survive the run.
func (d *agentDispatch) mintJJHubToken() error {
	if strings.TrimSpace(d.input.RepoOwner) == "" || strings.TrimSpace(d.input.RepoName) == "" {
		return nil
	}

	tok, err := issueTemporaryAgentRepoAPIToken(d.ctx, d.svc.dispatchQ, d.input.UserID, d.input.RepositoryID, fmt.Sprintf("sandbox-run-%d", d.run.ID), d.input.SessionID, d.input.AllowedPaths...)
	if err != nil {
		return d.markInfraFailed("create repo api token: " + err.Error())
	}
	d.jjhubToken = tok
	d.hasJJHubToken = true

	if err := d.svc.dispatchQ.UpdateWorkflowRunJJHubTokenID(d.ctx, db.UpdateWorkflowRunJJHubTokenIDParams{
		JjhubTokenID: pgtype.Int8{Int64: tok.ID, Valid: true},
		ID:           d.run.ID,
	}); err != nil {
		return d.markInfraFailed("persist repo api token id: " + err.Error())
	}
	return nil
}

func (d *agentDispatch) buildServiceSpec() error {
	provider := normalizeAgentProvider(d.input.AgentProvider)
	transport := normalizeAgentTransport(d.input.AgentTransport)
	// The unit has no command. plue owned the agent loop this used to exec and
	// no longer does; refuseRetiredAgentLoop fails every dispatch before this
	// spec is ever started. Everything below — the box's identity, the
	// credential boundary, the egress bindings, the per-run repository token —
	// is loop-independent and is what a Smithers 1.0 entrypoint will inherit,
	// so it is kept and exercised rather than deleted alongside the loop.
	// Whoever wires that entrypoint sets Exec here and drops the refusal step.
	d.agentServiceSpec = sandbox.ServiceSpec{
		Name: "smithers-agent",
		Mode: sandbox.ServiceModeService,
		Exec: nil,
		Env: map[string]string{
			"HOME":                      d.agentHome(),
			"SMITHERS_AGENT_SESSION_ID": d.input.SessionID,
			"SMITHERS_AGENT_TOKEN":      d.plaintext,
			"SMITHERS_API_BASE_URL":     normalizePublicBaseURL(d.svc.apiBaseURL),
			"SMITHERS_AGENT_PROVIDER":   provider,
			"SMITHERS_AGENT_TRANSPORT":  transport,
			"SMITHERS_REPOSITORY_PATH":  d.repositoryPath,
			"SMITHERS_WORKFLOW_RUN_ID":  fmt.Sprint(d.run.ID),
			"PATH":                      d.agentPath(),
			"SMITHERS_DEBUG":            "1",
		},
		// SMITHERS_TASK_PAYLOAD is gone with the loop that read it: the message
		// history reached the guest as that env var in the 0.x shape, and
		// Smithers 1.0 reads no such name. The history still lives on the
		// workflow task row, which is where a 1.0 entrypoint will read it.
		// The workdir is the checkout rather than the deleted loop's install
		// directory.
		Workdir: d.repositoryPath,
	}
	// Reserved runtime env (agent callback token + API base, and the per-run
	// scoped jjhub API token + base) is applied for the base spec here and
	// re-applied after injectSecrets — a repo secret must never override it.
	if d.workspaceMode() {
		// RFD-004: the run works in the human's computer as the workspace
		// user, so everything it writes stays usable by the human afterwards.
		d.agentServiceSpec.User = defaultWorkspaceUser
		d.agentServiceSpec.Env["USER"] = defaultWorkspaceUser
		d.agentServiceSpec.Env["LOGNAME"] = defaultWorkspaceUser
	}
	d.applyReservedRuntimeEnv()
	return nil
}

// workspaceMode reports whether this run executes in a workspace (RFD-004):
// the backend is wired and the run names a repository.
func (d *agentDispatch) workspaceMode() bool {
	return d.svc.workspaces != nil &&
		strings.TrimSpace(d.input.RepoOwner) != "" &&
		strings.TrimSpace(d.input.RepoName) != ""
}

func (d *agentDispatch) agentHome() string {
	if d.workspaceMode() {
		return defaultWorkspaceHome
	}
	return "/root"
}

func (d *agentDispatch) agentPath() string {
	if d.workspaceMode() {
		return "/usr/local/bin:" + defaultWorkspaceHome + "/.bun/bin:" + defaultWorkspaceHome + "/.local/bin:/usr/bin:/bin"
	}
	return "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin"
}

// createAgentWorkspaceVM is the workspace-mode createVM (RFD-004): the run's
// computer is a kind=agent workspace provisioned by the workspace service
// with the run's egress bindings merged into the VM's proxy policy.
func (d *agentDispatch) createAgentWorkspaceVM() error {
	d.vmReq = sandbox.CreateRequest{}
	quota, quotaErr := egressQuotaForUser(d.ctx, d.svc.billing, d.input.UserID)
	if quotaErr != nil {
		return quotaErr
	}
	d.vmReq.EgressProxy = &sandbox.EgressProxyPolicy{Enabled: true, Quota: quota, Secrets: append([]sandbox.EgressProxySecret(nil), d.egressSecrets...)}
	if err := d.vmReq.EgressProxy.Validate(); err != nil {
		return d.markInfraFailed("egress proxy bindings: " + err.Error())
	}
	d.recordSecretDelivery(secretDeliveryPathEgressProxy, len(d.egressSecrets))
	var members []sandbox.GitRepositorySpec
	if len(d.gitRepos) > 1 {
		members = append(members, d.gitRepos[1:]...)
	}
	title := ""
	if d.svc.q != nil {
		if session, err := d.svc.q.GetAgentSession(d.ctx, d.input.SessionID); err == nil {
			title = session.Title
		}
	}
	vmCreateStartedAt := time.Now()
	provisionCtx := d.ctx
	if d.sandboxStartAuthorized {
		provisionCtx = context.WithValue(provisionCtx, sandboxStartAdmissionKey{}, d.input.UserID)
	}
	result, err := d.svc.workspaces.CreateAgentWorkspace(provisionCtx, CreateAgentWorkspaceInput{
		RepositoryID:   d.input.RepositoryID,
		UserID:         d.input.UserID,
		SessionID:      d.input.SessionID,
		Title:          title,
		RepoOwner:      d.input.RepoOwner,
		RepoName:       d.input.RepoName,
		SourceBookmark: d.input.SourceBookmark,
		EgressSecrets:  append([]sandbox.EgressProxySecret(nil), d.egressSecrets...),
		Members:        members,
	})
	d.vmCreateDuration = time.Since(vmCreateStartedAt)
	if err != nil {
		middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID).
			Error("agent workspace creation failed", "error", err, "type", "agent")
		var apiErr *pkgerrors.APIError
		if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodePlanLimitExceeded {
			return err
		}
		return d.markInfraFailed("create agent workspace: " + err.Error())
	}
	d.workspaceID = result.WorkspaceID
	d.vm = sandbox.CreateResult{ID: result.VMID}
	d.vmCreated = true
	d.svc.startAgentRuntimeWatchdog(d.input.SessionID, d.vm.ID, d.run.ID, d.input.UserID)
	d.watchdogStarted = true
	middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID).
		Info("agent workspace ready", "workspace_id", result.WorkspaceID, "vm_id", result.VMID,
			"forked", result.Forked, "source_workspace_id", result.SourceWorkspaceID,
			"duration_ms", d.vmCreateDuration.Milliseconds())
	d.revokeCloneToken()
	return nil
}

// applyReservedRuntimeEnv sets the runtime env keys that a repo secret must never
// be able to override: platform provider credentials, the agent's own callback
// token + API base, and the per-run scoped jjhub API token + base. It runs when
// the base spec is built AND again after injectSecrets, because the prod
// SecretInjector path copies repo secrets unconditionally
// (internal/services/secret_injection.go InjectRepositoryEnvironment).
// Without the re-assertion a repo admin who sets e.g. SMITHERS_JJHUB_API_URL could
// redirect the run owner's cross-repo write token to an attacker-controlled host.
func (d *agentDispatch) applyReservedRuntimeEnv() {
	if d.agentServiceSpec.Env == nil {
		return
	}
	d.bindAgentCallbackCredential("SMITHERS_AGENT_TOKEN", d.plaintext)
	d.agentServiceSpec.Env["SMITHERS_API_BASE_URL"] = normalizePublicBaseURL(d.svc.apiBaseURL)
	d.bindModelSeats()
	if d.hasJJHubToken {
		d.bindAgentCallbackCredential("SMITHERS_JJHUB_TOKEN", d.jjhubToken.Plaintext)
		d.agentServiceSpec.Env["SMITHERS_JJHUB_API_URL"] = normalizePublicBaseURL(d.svc.apiBaseURL)
		// The same per-run token reads the repository's build cache. A run
		// credential is never a cache writer (BuildCacheAccess): the run's
		// code is unreviewed, and a publication would be read as green by
		// trusted builds. It is bound to the API host and the authorization
		// header, so the value itself never enters the guest under this name.
		if host := apiHost(d.svc.apiBaseURL); host != "" {
			d.bindEgressSecret(sandbox.EgressProxySecret{
				Name:         "SMITHERS_CACHE_TOKEN",
				Value:        d.jjhubToken.Plaintext,
				Hosts:        []string{host},
				MatchHeaders: []string{"authorization"},
			})
			d.agentServiceSpec.Env["SMITHERS_CACHE_URL"] = normalizePublicBaseURL(d.svc.apiBaseURL) + "/api/repos/" + d.input.RepoOwner + "/" + d.input.RepoName + "/build-cache"
		}
	}
}

// bindAgentCallbackCredential puts a Smithers API credential in the guest as
// an egress-proxy placeholder. Code the agent runs can read the service
// environment through /proc/*/environ; the proxy swaps the real value in only
// on the authorization header of requests to the Smithers API host, so a
// copied placeholder is worthless elsewhere. A dotless dev host
// (localhost) cannot be bound and bypasses the proxy, so only there does the
// value stay plaintext.
func (d *agentDispatch) bindAgentCallbackCredential(name, value string) {
	d.bindAgentCredential(name, value, "authorization")
}

func (d *agentDispatch) bindAgentCredential(name, value string, headers ...string) {
	host := apiHost(d.svc.apiBaseURL)
	if !sandbox.ValidEgressHost(host) || strings.TrimSpace(value) == "" {
		d.unbindEgressSecret(name)
		d.agentServiceSpec.Env[name] = value
		return
	}
	d.bindEgressSecret(sandbox.EgressProxySecret{
		Name:         name,
		Value:        value,
		Hosts:        []string{host},
		MatchHeaders: headers,
	})
}

// carriesAgentToken reports whether name holds the run's agent token, as a
// plaintext value or through an egress binding.
func (d *agentDispatch) carriesAgentToken(name string) bool {
	if d.plaintext == "" {
		return false
	}
	if d.agentServiceSpec.Env[name] == d.plaintext {
		return true
	}
	for _, secret := range d.egressSecrets {
		if secret.Name == name && secret.Value == d.plaintext {
			return true
		}
	}
	return false
}

// bindModelSeats points the platform model seats at the metered proxy with
// the run's agent token, bound at the egress proxy like the callback token.
func (d *agentDispatch) bindModelSeats() {
	for _, name := range []string{modelproxy.URLEnv, modelproxy.ProvidersEnv} {
		delete(d.agentServiceSpec.Env, name)
	}
	for _, seat := range d.svc.sandboxConfig.ModelSeats {
		if d.carriesAgentToken(seat.KeyEnv) {
			d.unbindEgressSecret(seat.KeyEnv)
			delete(d.agentServiceSpec.Env, seat.KeyEnv)
		}
		delete(d.agentServiceSpec.Env, seat.BaseURLEnv)
	}
	proxyURL := modelProxyURL(d.svc.apiBaseURL)
	// Seats are chosen once the repository's own secrets are in place: a
	// provider the repository supplies a key for keeps that key.
	if proxyURL == "" || d.plaintext == "" || !d.secretsInjected {
		return
	}
	var seats []modelproxy.Seat
	for _, seat := range d.svc.sandboxConfig.ModelSeats {
		if d.repositoryDeclares(seat) {
			continue
		}
		seats = append(seats, seat)
	}
	for _, seat := range seats {
		d.unbindEgressSecret(seat.KeyEnv)
		// Model SDKs send the key as a Bearer token or as x-api-key.
		d.bindAgentCredential(seat.KeyEnv, d.plaintext, "authorization", "x-api-key")
	}
	for name, value := range modelproxy.GuestEnvironment(proxyURL, seats) {
		d.agentServiceSpec.Env[name] = value
	}
}

// repositoryDeclares reports whether the repository supplies its own key for
// seat's provider, as a secret, a variable or an egress-bound secret.
func (d *agentDispatch) repositoryDeclares(seat modelproxy.Seat) bool {
	if _, declared := d.repositorySeats[seat.Provider]; declared {
		return true
	}
	for _, name := range workspaceProviderFamily(seat.KeyEnv) {
		value, set := d.agentServiceSpec.Env[name]
		if set && value != "" && !d.carriesAgentToken(name) {
			if d.repositorySeats == nil {
				d.repositorySeats = map[string]struct{}{}
			}
			d.repositorySeats[seat.Provider] = struct{}{}
			return true
		}
	}
	return false
}

// apiHost is the host the per-run credentials are bound to at the proxy.
func apiHost(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func normalizeAgentProvider(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "", "smithers":
		return "smithers"
	case "codex":
		return "codex"
	default:
		return strings.ToLower(strings.TrimSpace(provider))
	}
}

func normalizeAgentTransport(transport string) string {
	switch strings.ToLower(strings.TrimSpace(transport)) {
	case "", "workflow":
		return "workflow"
	case "http":
		return "http"
	default:
		return strings.ToLower(strings.TrimSpace(transport))
	}
}

func (d *agentDispatch) injectSecrets() error {
	before := len(d.agentServiceSpec.Env)
	if err := d.svc.injectAgentRepoSecrets(d.ctx, d.input.RepositoryID, d.agentServiceSpec.Env); err != nil {
		return d.markInfraFailed("load repository secrets: " + err.Error())
	}
	// Repository secrets (the CI secrets table) have no host binding yet, so
	// they still take the legacy in-guest path. Count them: this is the
	// number that has to reach zero before the boundary is complete.
	d.recordSecretDelivery(secretDeliveryPathLegacyEnv, len(d.agentServiceSpec.Env)-before)
	if err := d.injectAgentEnvironmentVariables(); err != nil {
		return err
	}
	if err := d.bindAgentEnvironmentSecrets(); err != nil {
		return err
	}
	// Re-assert reserved runtime env AFTER repo-secret injection so a malicious
	// repo secret cannot redirect/replace the agent token, API base, or the
	// per-run scoped jjhub token. The prod SecretInjector copies secrets
	// unconditionally, so setting these before injection is not sufficient.
	d.secretsInjected = true
	d.applyReservedRuntimeEnv()
	return nil
}

func (d *agentDispatch) injectAgentEnvironmentVariables() error {
	if d.svc.environmentVariables == nil || d.input.RepositoryID <= 0 {
		return nil
	}
	variables, err := d.svc.environmentVariables.LoadVariables(d.ctx, d.input.RepositoryID)
	if err != nil {
		return d.markInfraFailed("load repository agent environment variables: " + err.Error())
	}
	for _, variable := range variables {
		// Preserve the existing runtime/secret owner of a name. Reserved
		// values are re-asserted below as a second defense for injectors that
		// overwrite unconditionally.
		if _, exists := d.agentServiceSpec.Env[variable.Name]; exists {
			continue
		}
		d.agentServiceSpec.Env[variable.Name] = variable.Value
	}
	return nil
}

// unbindEgressSecret drops a bound credential and its placeholder so a
// subscription can replace a platform credential for the same provider.
func (d *agentDispatch) unbindEgressSecret(name string) {
	kept := d.egressSecrets[:0]
	for _, secret := range d.egressSecrets {
		if secret.Name != name {
			kept = append(kept, secret)
		}
	}
	d.egressSecrets = kept
	delete(d.egressNames, name)
	if d.agentServiceSpec.Env[name] == sandbox.EgressProxyPlaceholder(name) {
		delete(d.agentServiceSpec.Env, name)
	}
}

// bindAgentEnvironmentSecrets routes repository agent-environment secrets
// that carry an egress binding through the proxy. They are never written to
// the guest environment: the guest gets the placeholder.
func (d *agentDispatch) bindAgentEnvironmentSecrets() error {
	if d.svc.boundSecrets == nil || d.input.RepositoryID <= 0 {
		return nil
	}
	bound, err := d.svc.boundSecrets.LoadProxyBoundSecrets(d.ctx, d.input.RepositoryID)
	if err != nil {
		return d.markInfraFailed("load bound agent environment secrets: " + err.Error())
	}
	for _, secret := range bound {
		if _, reserved := d.agentServiceSpec.Env[secret.Name]; reserved && !d.isEgressName(secret.Name) {
			// A repository secret or reserved runtime key already owns this
			// name in the guest; a bound secret must not shadow it.
			continue
		}
		d.bindEgressSecret(secret)
	}
	return nil
}

// bindEgressSecret records secret for the proxy and puts its placeholder in
// the guest environment. Re-binding the same name replaces the earlier value
// so applyReservedRuntimeEnv stays idempotent.
func (d *agentDispatch) bindEgressSecret(secret sandbox.EgressProxySecret) {
	if d.egressNames == nil {
		d.egressNames = map[string]struct{}{}
	}
	replaced := false
	for index := range d.egressSecrets {
		if d.egressSecrets[index].Name == secret.Name {
			d.egressSecrets[index] = secret
			replaced = true
		}
	}
	if !replaced {
		d.egressSecrets = append(d.egressSecrets, secret)
	}
	d.egressNames[secret.Name] = struct{}{}
	d.agentServiceSpec.Env[secret.Name] = sandbox.EgressProxyPlaceholder(secret.Name)
}

func (d *agentDispatch) isEgressName(name string) bool {
	_, ok := d.egressNames[name]
	return ok
}

func (d *agentDispatch) recordSecretDelivery(path string, count int) {
	if count <= 0 || d.svc.sandboxMetrics == nil {
		return
	}
	if recorder, ok := d.svc.sandboxMetrics.(SecretDeliveryMetricsRecorder); ok {
		recorder.AddAgentSecretDelivery(path, count)
	}
}

// requireProviderCredential refuses the run when the VM would boot with no
// AI-provider credential it could actually authenticate with.
//
// Without this the dispatch reported success, the VM booted, its agent picked
// the first provider whose env var was merely PRESENT, and every model call
// came back 401. Nothing surfaced: no assistant message, no transcript entry,
// no run failure — the session sat "active" until the caller gave up.
// Production ran this way with
// ANTHROPIC_API_KEY=placeholder-pending-h1-credential-seed injected into every
// agent VM. A refusal the user can read beats a VM that silently cannot think.
func (d *agentDispatch) requireProviderCredential() error {
	if d.codingDispatchEnabled() {
		return nil
	}
	if HasUsableProviderCredentialWithPlaceholders(d.agentServiceSpec.Env, d.egressNames) {
		return nil
	}
	return d.markInfraFailed(
		"no AI-provider credential is configured for agent runs on this deployment; " +
			"set one of " + strings.Join(AgentProviderCredentialEnvNames, ", ") +
			" as a platform provider credential or a repository secret")
}

func (d *agentDispatch) createVM() error {
	if d.workspaceMode() {
		return d.createAgentWorkspaceVM()
	}
	const defaultAgentIdleTimeout = 5 * time.Minute
	agentIdleTimeoutDuration := d.svc.sandboxConfig.IdleTimeout
	if d.sandboxConfig.IdleTimeout != 0 {
		agentIdleTimeoutDuration = d.sandboxConfig.IdleTimeout
	}
	if agentIdleTimeoutDuration <= 0 {
		// Keep direct/test-created AgentService instances safe when they do not
		// provide the server's fully loaded configuration.
		agentIdleTimeoutDuration = defaultAgentIdleTimeout
	}
	agentIdleTimeout := int64(agentIdleTimeoutDuration / time.Second)
	waitForReady := false
	deleteOnStop := sandbox.DeleteOnStop

	d.vmReq = sandbox.CreateRequest{
		SnapshotID:         d.svc.agentSnapshotID,
		GitRepos:           d.gitRepos,
		IdleTimeoutSeconds: &agentIdleTimeout,
		Persistence: &sandbox.PersistencePolicy{
			Type:        sandbox.PersistenceEphemeral,
			DeleteEvent: &deleteOnStop,
		},
		Workdir:      d.repositoryPath,
		WaitForReady: &waitForReady,
	}
	if d.svc.sandboxConfig.MemoryMB > 0 {
		d.vmReq.MemSizeMB = &d.svc.sandboxConfig.MemoryMB
	}
	if d.svc.sandboxConfig.VCPUCount > 0 {
		d.vmReq.VCPUCount = &d.svc.sandboxConfig.VCPUCount
	}
	if d.svc.sandboxConfig.RootfsSizeMB > 0 {
		d.vmReq.RootfsSizeMB = &d.svc.sandboxConfig.RootfsSizeMB
	}
	// Every agent sandbox gets its per-sandbox egress proxy; there is no
	// deployment without the boundary. A worker that cannot start the proxy
	// refuses the sandbox (egress_proxy_unavailable) rather than booting it
	// with an open network. The bound values travel once, inside this
	// request, to the worker that seeds the proxy process. The controller
	// redacts them before any durable write (SanitizeCreateRequest); the
	// guest never sees them.
	quota, quotaErr := egressQuotaForUser(d.ctx, d.svc.billing, d.input.UserID)
	if quotaErr != nil {
		return quotaErr
	}
	d.vmReq.EgressProxy = &sandbox.EgressProxyPolicy{Enabled: true, Quota: quota, Secrets: append([]sandbox.EgressProxySecret(nil), d.egressSecrets...)}
	if err := d.vmReq.EgressProxy.Validate(); err != nil {
		return d.markInfraFailed("egress proxy bindings: " + err.Error())
	}
	d.recordSecretDelivery(secretDeliveryPathEgressProxy, len(d.egressSecrets))

	vmCreateStartedAt := time.Now()
	createCtx := sandboxProvisionContext(d.ctx, "create", "agent_session", d.input.SessionID, fmt.Sprintf("workflow-run-%d", d.run.ID))
	vm, err := d.svc.sandbox.CreateSandbox(createCtx, d.vmReq)
	d.vmCreateDuration = time.Since(vmCreateStartedAt)

	if d.svc.sandboxMetrics != nil {
		status := "success"
		if err != nil {
			status = "error"
		}
		d.svc.sandboxMetrics.ObserveSandboxVMCreate("agent", status, d.vmCreateDuration.Seconds())
	}
	if err != nil {
		middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID).
			Error("sandbox creation failed", "error", err, "type", "agent")
		return d.markInfraFailed("create sandbox: " + err.Error())
	}

	d.vm = vm
	d.vmCreated = true
	d.svc.startAgentRuntimeWatchdog(d.input.SessionID, d.vm.ID, d.run.ID, d.input.UserID)
	d.watchdogStarted = true

	// The sandbox clones repositories during VM creation. Revoke the token immediately after the VM is created.
	d.revokeCloneToken()
	return nil
}

// reserveFleetSlot stamps the session's started_at BEFORE the slow CreateSandbox
// call so a provisioning session is immediately visible to the fleet cap
// (CountActiveAgentSessionVMs counts started_at IS NOT NULL). Stamping only
// after VM creation let a burst of concurrent dispatches all observe the same
// below-cap count and overshoot the cap without bound.
//
// When the cap is enabled, the stamp happens inside an advisory-locked atomic
// count+reserve (ReserveAgentSessionVMSlot) — the hard gate behind the
// enforceConcurrencyCap fast precheck. A reservation error fails the dispatch
// closed because a plain stamp cannot prove that the fleet slot was reserved.
// When the cap is disabled, only the plain stamp runs.
//
// A reserved slot is released whenever the session leaves status='active':
// markInfraFailed/cleanup on any later dispatch failure, the normal terminal
// transition on 'done', or the session reaper.
func (d *agentDispatch) reserveFleetSlot() (retErr error) {
	defer func() { d.meterReservedAgentUsage(retErr) }()
	if d.svc.concurrencyCounter == nil || d.svc.concurrencyMax <= 0 {
		return d.setSessionStartedAt()
	}
	reserved, err := d.svc.concurrencyCounter.ReserveAgentSessionVMSlot(d.ctx, d.input.SessionID, d.svc.concurrencyMax)
	if err != nil {
		middleware.LoggerWithAgentSession(d.ctx, d.input.SessionID).
			Error("agent fleet slot reservation failed; rejecting dispatch", "error", err)
		return d.markInfraFailed("reserve agent fleet slot: " + err.Error())
	}
	if !reserved {
		return pkgerrors.QuotaExceeded("concurrent agent session limit reached")
	}
	return nil
}

func (d *agentDispatch) setSessionStartedAt() error {
	startedAt := time.Now().UTC()
	if _, err := d.svc.dispatchQ.UpdateAgentSessionStartedAt(d.ctx, db.UpdateAgentSessionStartedAtParams{
		ID:        d.input.SessionID,
		StartedAt: pgtype.Timestamptz{Time: startedAt, Valid: true},
	}); err != nil {
		return d.markInfraFailed("set agent session start time: " + err.Error())
	}
	return nil
}

func (d *agentDispatch) startService() error {
	serviceResp, err := d.svc.sandbox.CreateService(d.ctx, d.vm.ID, d.agentServiceSpec)
	if err != nil {
		middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID).
			Error("failed to create microsandbox systemd service", "vm_id", d.vm.ID, "type", "agent", "error", err)
		return d.markInfraFailed("create microsandbox systemd service: " + err.Error())
	}
	if err == nil && !serviceResp.Success {
		serviceErr := "unknown error"
		if strings.TrimSpace(serviceResp.Message) != "" {
			serviceErr = serviceResp.Message
		}
		middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID).
			Error("microsandbox systemd service creation failed", "vm_id", d.vm.ID, "type", "agent", "error", serviceErr)
		return d.markInfraFailed("create microsandbox systemd service: " + serviceErr)
	}
	d.serviceStarted = true
	return nil
}

func (d *agentDispatch) markTaskRunning() error {
	if _, err := d.svc.dispatchQ.MarkWorkflowTaskVMRunning(d.ctx, db.MarkWorkflowTaskVMRunningParams{
		ID:   d.task.ID,
		VmID: optionalVMID(d.vm.ID),
	}); err != nil {
		return d.markInfraFailed("mark workflow task running: " + err.Error())
	}
	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID)
	if _, err := d.svc.dispatchQ.UpdateWorkflowStepStatusRunning(d.ctx, d.step.ID); err != nil {
		logger.Warn("failed to mark workflow step running after agent dispatch", "step_id", d.step.ID, "error", err)
	}
	if _, err := d.svc.dispatchQ.UpdateWorkflowRunStatusBasedOnTasks(d.ctx, d.run.ID); err != nil {
		logger.Warn("failed to update workflow run status after agent dispatch", "error", err)
	}
	NotifyWorkflowRunEvent(d.ctx, d.svc.dispatchQ, d.run.ID, "agent.task_running")
	return nil
}

// recordSuccess logs and records metrics after a successful dispatch.
func (d *agentDispatch) recordSuccess() {
	// Workspace-backed agents are already counted by WorkspaceService.
	if d.workspaceID == "" && d.svc.sandboxMetrics != nil {
		d.svc.sandboxMetrics.AddSandboxActiveVMs("agent", 1)
	}
	middleware.LoggerWithAgentSessionAndWorkflowRun(d.ctx, d.input.SessionID, d.run.ID).
		Info("sandbox created", "vm_id", d.vm.ID, "type", "agent", "duration_ms", d.vmCreateDuration.Milliseconds())
}
