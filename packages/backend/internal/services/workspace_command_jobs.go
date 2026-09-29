package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const workspaceCommandOperation = "workspace.command"

// Keep even JSON-escaped control bytes below the client response limit.
const workspaceCommandOutputLimit = 256 << 10

// WorkspaceCommandRun exposes only the caller's bounded command receipt.
type WorkspaceCommandRun struct {
	OperationID string                  `json:"operationId"`
	State       jobs.State              `json:"state"`
	Result      *WorkspaceCommandResult `json:"result,omitempty"`
	Error       string                  `json:"error,omitempty"`
}

// PostgreSQL JSONB cannot contain NUL. Byte fields use base64 in durable
// receipts; only this service translates them back to the public strings.
type workspaceCommandStoredResult struct {
	ExitCode        int    `json:"exit_code"`
	Stdout          []byte `json:"stdout"`
	Stderr          []byte `json:"stderr"`
	OutputTruncated bool   `json:"output_truncated"`
}

type workspaceCommandPayload struct {
	WorkspaceID    string
	RepositoryID   int64
	UserID         int64
	EncryptedInput string
}

func WithWorkspaceCommandJobs(store *jobs.Store, codec flowhost.SecretCodec) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.commandJobs = store; s.commandCodec = codec }
}

func (s *WorkspaceService) AdmitWorkspaceCommand(ctx context.Context, workspaceID string, repositoryID, userID int64, input WorkspaceCommandInput) (jobs.RequestReceipt, error) {
	if s.commandJobs == nil || s.commandCodec == nil || !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().Execution {
		return jobs.RequestReceipt{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace execution unavailable")
	}
	if strings.TrimSpace(input.OperationID) == "" || len(input.OperationID) > 128 {
		return jobs.RequestReceipt{}, pkgerrors.BadRequest("operation_id must contain 1 to 128 characters")
	}
	if len(input.Args) == 0 || strings.TrimSpace(input.Args[0]) == "" {
		return jobs.RequestReceipt{}, pkgerrors.BadRequest("command args are required")
	}
	if _, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite); err != nil {
		return jobs.RequestReceipt{}, err
	}
	plaintext, err := json.Marshal(input)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	encrypted, err := s.commandCodec.EncryptString(string(plaintext))
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	payload, err := json.Marshal(workspaceCommandPayload{workspaceID, repositoryID, userID, encrypted})
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	receipt, err := s.commandJobs.Admit(ctx, jobs.Admission{
		Scope: repositoryJobFlowScope(repositoryID, userID), Operation: workspaceCommandOperation,
		RequestID: workspaceID + ":" + input.OperationID, Payload: payload, EffectPolicy: jobs.EffectUnsafe,
	})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		// Encryption is randomized. The existing row wins concurrent admission;
		// compare decrypted canonical input without persisting a plaintext digest.
		existing, readErr := s.commandJobs.GetByRequest(ctx, repositoryJobFlowScope(repositoryID, userID), workspaceCommandOperation, workspaceID+":"+input.OperationID)
		if readErr != nil {
			return receipt, readErr
		}
		var prior workspaceCommandPayload
		if json.Unmarshal(existing.Payload, &prior) != nil {
			return receipt, pkgerrors.Internal("invalid command receipt")
		}
		decoded, decodeErr := s.commandCodec.DecryptString(prior.EncryptedInput)
		if decodeErr != nil {
			return receipt, decodeErr
		}
		if prior.WorkspaceID != workspaceID || prior.RepositoryID != repositoryID || prior.UserID != userID || decoded != string(plaintext) {
			return receipt, pkgerrors.Conflict("operation_id already names a different command")
		}
		if readErr = json.Unmarshal(existing.RequestReceipt, &receipt); readErr != nil {
			return receipt, readErr
		}
		receipt.Joined = true
		return receipt, nil
	}
	return receipt, err
}

func (s *WorkspaceService) workspaceCommandRun(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string, access WorkspaceAccessLevel) (jobs.Operation, error) {
	if s.commandJobs == nil {
		return jobs.Operation{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace execution unavailable")
	}
	if _, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, access); err != nil {
		return jobs.Operation{}, err
	}
	if _, err := uuid.Parse(operationID); err != nil {
		return jobs.Operation{}, pkgerrors.NotFound("command not found")
	}
	operation, err := s.commandJobs.Get(ctx, repositoryJobFlowScope(repositoryID, userID), operationID)
	if errors.Is(err, jobs.ErrNotFound) {
		return operation, pkgerrors.NotFound("command not found")
	}
	if err != nil {
		return operation, err
	}
	var input workspaceCommandPayload
	if json.Unmarshal(operation.Payload, &input) != nil || operation.Operation != workspaceCommandOperation || input.WorkspaceID != workspaceID || input.RepositoryID != repositoryID || input.UserID != userID {
		return jobs.Operation{}, pkgerrors.NotFound("command not found")
	}
	return operation, nil
}

func commandRunReceipt(operation jobs.Operation) (WorkspaceCommandRun, error) {
	run := WorkspaceCommandRun{OperationID: operation.ID, State: operation.State}
	if operation.State == jobs.StateCompleted {
		var result workspaceCommandStoredResult
		if err := json.Unmarshal(operation.TerminalReceipt, &result); err != nil {
			return run, fmt.Errorf("invalid command receipt: %w", err)
		}
		run.Result = &WorkspaceCommandResult{ExitCode: result.ExitCode, Stdout: string(result.Stdout), Stderr: string(result.Stderr), OutputTruncated: result.OutputTruncated}
	} else if operation.State == jobs.StateFailed || operation.State == jobs.StateUncertain {
		var failure struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(operation.TerminalReceipt, &failure); err != nil {
			return run, fmt.Errorf("invalid failure receipt: %w", err)
		}
		run.Error = "command failed"
		switch failure.Code {
		case "command_permission_denied":
			run.Error = "command permission denied"
		case "command_timeout":
			run.Error = "command exceeded its 60-minute limit"
		case "invalid_command":
			run.Error = "command input could not be recovered"
		}
		if operation.State == jobs.StateUncertain {
			run.Error = "command outcome is unknown; it will not be retried"
		}
	}
	return run, nil
}

func (s *WorkspaceService) GetWorkspaceCommandRun(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string) (WorkspaceCommandRun, error) {
	operation, err := s.workspaceCommandRun(ctx, workspaceID, repositoryID, userID, operationID, WorkspaceAccessRead)
	if err != nil {
		return WorkspaceCommandRun{}, err
	}
	return commandRunReceipt(operation)
}

func (s *WorkspaceService) CancelWorkspaceCommandRun(ctx context.Context, workspaceID string, repositoryID, userID int64, operationID string) (WorkspaceCommandRun, error) {
	operation, err := s.workspaceCommandRun(ctx, workspaceID, repositoryID, userID, operationID, WorkspaceAccessWrite)
	if err != nil {
		return WorkspaceCommandRun{}, err
	}
	operation, err = s.commandJobs.RequestCancellation(ctx, operation.Scope, operation.ID)
	if err != nil {
		return WorkspaceCommandRun{}, err
	}
	return commandRunReceipt(operation)
}

func (s *WorkspaceService) RunWorkspaceCommandWorker(ctx context.Context, config jobs.WorkerConfig) error {
	if s.commandJobs == nil || s.commandCodec == nil {
		return errors.New("workspace command store unavailable")
	}
	config.Operations = []string{workspaceCommandOperation}
	return s.commandJobs.RunWorker(ctx, config, s.handleWorkspaceCommand)
}

// Recheck account, repository and workspace authority after admission. Runtime
// adapters own workspace placement; hosted adapters route to the owning VM.
func (s *WorkspaceService) authorizeWorkspaceCommand(ctx context.Context, input workspaceCommandPayload) error {
	store, ok := s.q.(workspacePreviewAuthorizationQuerier)
	if !ok {
		return pkgerrors.Forbidden("command authorization unavailable")
	}
	user, err := store.GetUserByID(ctx, input.UserID)
	if err != nil {
		return err
	}
	if !user.IsActive || user.ProhibitLogin || user.DeletedAt.Valid {
		return pkgerrors.Forbidden("access denied")
	}
	repo, err := store.GetRepoByID(ctx, input.RepositoryID)
	if err != nil {
		return err
	}
	permission, permissionErr := middleware.ResolveRepoPermission(ctx, store, repo, &user)
	if permissionErr != nil {
		return permissionErr
	}
	if !permission.Satisfies(middleware.PermissionWrite) {
		return pkgerrors.Forbidden("access denied")
	}
	_, err = s.loadWorkspaceWithAccess(ctx, input.WorkspaceID, input.RepositoryID, input.UserID, WorkspaceAccessWrite)
	return err
}

func (s *WorkspaceService) handleWorkspaceCommand(ctx context.Context, lease *jobs.Lease) error {
	return s.handleWorkspaceCommandWithTimeout(ctx, lease, time.Hour)
}

// Keep the production guard fixed while allowing deadline behavior to be tested.
func (s *WorkspaceService) handleWorkspaceCommandWithTimeout(ctx context.Context, lease *jobs.Lease, timeout time.Duration) error {
	claim := lease.Claim()
	var input workspaceCommandPayload
	fail := func(code string) error {
		receipt, _ := json.Marshal(map[string]string{"code": code})
		settlement, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		return lease.Fail(settlement, receipt)
	}
	if json.Unmarshal(claim.Payload, &input) != nil || claim.Operation != workspaceCommandOperation || claim.Scope != repositoryJobFlowScope(input.RepositoryID, input.UserID) {
		return fail("invalid_command")
	}
	plaintext, decodeErr := s.commandCodec.DecryptString(input.EncryptedInput)
	var command WorkspaceCommandInput
	if decodeErr != nil || json.Unmarshal([]byte(plaintext), &command) != nil || claim.RequestID != input.WorkspaceID+":"+command.OperationID {
		return fail("invalid_command")
	}
	if err := s.authorizeWorkspaceCommand(ctx, input); err != nil {
		var apiErr *pkgerrors.APIError
		if errors.Is(err, pgx.ErrNoRows) || (errors.As(err, &apiErr) && (apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusNotFound)) {
			return fail("command_permission_denied")
		}
		return err
	}
	// The unsafe fence is persisted before any runtime effect. A crash after
	// this point becomes uncertain, never a second shell execution.
	if err := lease.StartExternal(ctx, json.RawMessage(`{"phase":"executing"}`)); err != nil {
		return err
	}
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := s.executeWorkspaceCommand(commandCtx, input.WorkspaceID, input.RepositoryID, input.UserID, command)
	// A successful result is authoritative even if cancellation races its
	// settlement. A cancelled runtime call only proves termination when the
	// runtime explicitly certifies termination, not just transport cancellation.
	if err != nil {
		if errors.Is(err, workspaceapi.ErrCommandTerminationUnconfirmed) {
			return workspaceapi.ErrCommandTerminationUnconfirmed
		}
		if ctx.Err() != nil {
			settlement, stop := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer stop()
			operation, readErr := s.commandJobs.Get(settlement, claim.Scope, claim.OperationID)
			if readErr != nil {
				return readErr
			}
			if errors.Is(err, workspaceapi.ErrCommandCancelled) {
				if operation.CancellationRequested {
					return lease.Cancelled(settlement, json.RawMessage(`{"kind":"cancelled"}`))
				}
				return lease.ExternalCancelled(settlement, json.RawMessage(`{"kind":"worker-stopped"}`))
			}
			return errors.New("workspace command termination unconfirmed")
		}
		if errors.Is(commandCtx.Err(), context.DeadlineExceeded) && errors.Is(err, workspaceapi.ErrCommandCancelled) {
			return fail("command_timeout")
		}
		// After the external-effect fence, an unknown runtime error cannot
		// certify termination. Do not persist potentially sensitive adapter errors.
		return workspaceapi.ErrCommandTerminationUnconfirmed
	}
	if len(result.Stdout) > workspaceCommandOutputLimit {
		result.Stdout = result.Stdout[:workspaceCommandOutputLimit]
		result.OutputTruncated = true
	}
	if len(result.Stderr) > workspaceCommandOutputLimit {
		result.Stderr = result.Stderr[:workspaceCommandOutputLimit]
		result.OutputTruncated = true
	}
	receipt, err := json.Marshal(workspaceCommandStoredResult{ExitCode: result.ExitCode, Stdout: []byte(result.Stdout), Stderr: []byte(result.Stderr), OutputTruncated: result.OutputTruncated})
	if err != nil {
		return err
	}
	settlement, stop := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer stop()
	return lease.Complete(settlement, receipt)
}
