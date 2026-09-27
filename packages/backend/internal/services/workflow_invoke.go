package services

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// InvokeWorkflowInput is the input for InvokeWorkflow: one durable run of a
// repo-file workflow (`.smithers/workflows/*.tsx`) on the sandbox execution
// plane, where the in-API scheduler claims it and executes `smithers up`
// inside a one-shot VM. Unlike CI dispatch, invocation does not require the
// definition to declare jobs — the sandbox executor interprets the file.
type InvokeWorkflowInput struct {
	RepositoryID int64
	// Identifier is the flow name (`echo`), its path
	// (`.smithers/workflows/echo.tsx`), or a numeric definition ID.
	Identifier string
	// Input is the workflow's input payload, persisted as dispatch_inputs.
	Input map[string]interface{}
	// TriggerRef is the bookmark the sandbox clones (the repo default).
	TriggerRef string
}

// InvokeWorkflowResult is one freshly created durable workflow run.
type InvokeWorkflowResult struct {
	Run        db.WorkflowRun
	Definition db.WorkflowDefinition
}

// InvokeTriggerEvent is the trigger every invoked run records. A run's
// trigger is provenance the server establishes, never a label the caller
// picks: the scheduler records "schedule" and the push hook "push", and an
// invocation is only ever an invocation (see workflowCachePublisher).
const InvokeTriggerEvent = "invoke"

// invokeDefinitionMatches mirrors the dispatch route's identifier matching:
// exact name, full path, or path basename without extension.
func invokeDefinitionMatches(def db.WorkflowDefinition, identifier string) bool {
	trimmed := strings.TrimSpace(identifier)
	if trimmed == "" {
		return false
	}
	if strings.EqualFold(def.Name, trimmed) {
		return true
	}
	base := strings.TrimSuffix(filepath.Base(def.Path), filepath.Ext(def.Path))
	return strings.EqualFold(base, trimmed) || strings.EqualFold(def.Path, trimmed)
}

// InvokeWorkflow creates one durable sandbox-plane workflow run for a
// repo-file flow and returns it in status queued. The sandbox scheduler
// (WorkflowSandboxSchedulerWorker) claims the run within one poll interval,
// so the returned run is honestly queued — never reported as further along
// than the database says it is.
func (s *workflowAPIService) InvokeWorkflow(ctx context.Context, input InvokeWorkflowInput) (*InvokeWorkflowResult, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow store unavailable")
	}
	identifier := strings.TrimSpace(input.Identifier)
	if identifier == "" {
		return nil, pkgerrors.BadRequest("a workflow name or path is required")
	}

	matched, err := s.findActiveWorkflowDefinition(ctx, input.RepositoryID, identifier)
	if err != nil {
		return nil, err
	}
	if matched == nil {
		return nil, pkgerrors.NotFound("workflow definition not found")
	}

	triggerRef := strings.TrimSpace(input.TriggerRef)
	if triggerRef == "" {
		triggerRef = "main"
	}

	var dispatchInputs []byte
	if input.Input != nil {
		encoded, err := json.Marshal(input.Input)
		if err != nil {
			return nil, pkgerrors.BadRequest("input must be JSON-serializable")
		}
		dispatchInputs = encoded
	}

	if s.billing != nil {
		if err := s.billing.AuthorizeWorkflowDispatch(ctx, input.RepositoryID); err != nil {
			return nil, err
		}
	}
	run, err := s.queries.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
		RepositoryID:         input.RepositoryID,
		WorkflowDefinitionID: matched.ID,
		Status:               "queued",
		TriggerEvent:         InvokeTriggerEvent,
		TriggerRef:           triggerRef,
		TriggerCommitSha:     "",
		DispatchInputs:       dispatchInputs,
		ExecutionPlane:       WorkflowRunPlaneSandbox,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to create workflow run").WithCause(err)
	}
	return &InvokeWorkflowResult{Run: run, Definition: *matched}, nil
}

// findActiveWorkflowDefinition scans every active definition in the
// repository, batch by batch, for the first one matching identifier. Sync
// allows up to 1000 workflow files, more than one listing batch holds.
func (s *workflowAPIService) findActiveWorkflowDefinition(ctx context.Context, repositoryID int64, identifier string) (*db.WorkflowDefinition, error) {
	for offset := 0; ; offset += listWorkflowDefinitionsBatchSize {
		rows, err := s.queries.ListWorkflowDefinitionsByRepo(ctx, db.ListWorkflowDefinitionsByRepoParams{
			RepositoryID: repositoryID,
			PageOffset:   ClampInt32(offset),
			PageSize:     int32(listWorkflowDefinitionsBatchSize),
		})
		if err != nil {
			return nil, err
		}
		for i := range rows {
			if rows[i].IsActive && invokeDefinitionMatches(rows[i], identifier) {
				def := rows[i]
				return &def, nil
			}
		}
		if len(rows) < listWorkflowDefinitionsBatchSize {
			return nil, nil
		}
	}
}
