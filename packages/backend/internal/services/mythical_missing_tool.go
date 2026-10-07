package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// CertifyFlowFailure reads the last command on the attempt's machine. Only a
// completed, server-certified exit 127 may offer an image repair. Guest error
// prose, older machines, successful later commands and transport failures cannot.
func (s *MythicalService) CertifyFlowFailure(ctx context.Context, update flowdispatch.ProjectionUpdate) (*flowdispatch.CertifiedMissingTool, error) {
	var projection mythicalProjection
	if json.Unmarshal(update.Checkpoint.Projection, &projection) != nil || projection.Kind != mythicalBindingKind || projection.Phase != "todo" || update.State != jobs.StateFailed {
		return nil, nil
	}
	run := update.Checkpoint.Run
	if run == nil || run.Status != "failed" || (run.FailureFault != "factory" && !(run.FailureFault == "user" && strings.HasSuffix(run.FailureTag, "/missing_machine_tool"))) || run.RunID != update.Checkpoint.RunID || run.FailureTag == "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey" {
		return nil, nil
	}
	id, err := uuid.Parse(projection.ItemID)
	if err != nil {
		return nil, nil
	}
	item, err := s.queries().GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pin, pinned := mythicalPinOf(item)
	if !pinned || projection.Attempt != item.Attempt || item.RequestRunID != run.RunID || item.WorkspaceID == "" || item.WorkspaceID != update.Checkpoint.Target.WorkspaceID || !item.LaneStartedAt.Valid || projection.FlowDigest != pin.ExecutionDigest || projection.FlowSource != pin.SourceCommit {
		return nil, nil
	}
	var operation string
	var raw []byte
	// The latest command wins even when it is still running or failed at the
	// transport boundary: never reach backwards for a convenient old exit.
	err = s.store.QueryRow(ctx, `SELECT id::text, CASE WHEN state='completed' THEN terminal_receipt ELSE NULL END FROM product_job_requests WHERE operation='workspace.command' AND payload->>'WorkspaceID'=$1 AND payload->>'RepositoryID'=$2 AND created_at >= $3 AND tenant_id=$4 AND principal_id=$5 ORDER BY created_at DESC,id DESC LIMIT 1`, item.WorkspaceID, strconv.FormatInt(item.RepositoryID, 10), item.LaneStartedAt.Time, update.Scope.TenantID, update.Scope.PrincipalID).Scan(&operation, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var receipt workspaceCommandStoredResult
	if json.Unmarshal(raw, &receipt) != nil || receipt.ExitCode != 127 || receipt.Error == nil || receipt.Error.Code != "missing_machine_tool" || receipt.Error.Class != "user" || receipt.Error.MissingTool == nil {
		return nil, nil
	}
	// Recheck the persisted diagnostic against the same package-name rule. This
	// also leaves legacy exit-only receipts unannotated.
	diagnostic := microsandbox.MissingToolError(workspaceapi.Command{Args: []string{"sh"}}, workspaceapi.CommandResult{ExitCode: receipt.ExitCode, Stderr: string(receipt.Stderr)})
	var verified *microsandbox.RecipeError
	if !errors.As(diagnostic, &verified) || verified.MissingTool == nil || *verified.MissingTool != *receipt.Error.MissingTool {
		return nil, nil
	}
	return &flowdispatch.CertifiedMissingTool{Name: verified.MissingTool.Name, File: verified.MissingTool.File, OperationID: operation}, nil
}
