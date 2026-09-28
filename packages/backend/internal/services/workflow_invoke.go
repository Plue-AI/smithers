package services

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// InvokeWorkflowInput is the input for InvokeWorkflow: one durable run of a
// repository file flow (`flows/<name>/flow.ts`) on the canonical Flow
// runtime, hosted on the invoker's box.
type InvokeWorkflowInput struct {
	RepositoryID int64
	// UserID is the person invoking the flow; the run's host runs as them.
	UserID int64
	// Identifier is the flow name (`echo`) or its path (`flows/echo/flow.ts`).
	Identifier string
	// Input is the flow's payload, persisted as dispatch_inputs.
	Input map[string]interface{}
	// TriggerRef is the bookmark the run records (the repo default).
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

// invokeFlowName is a file flow's name: `flows/<name>/flow.ts`.
var invokeFlowName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// invokeFlowID reads a flow name or its `flows/<name>/flow.ts` path.
func invokeFlowID(identifier string) (string, bool) {
	name := strings.TrimSpace(identifier)
	if inner, ok := strings.CutPrefix(name, "flows/"); ok {
		if name, ok = strings.CutSuffix(inner, "/flow.ts"); !ok {
			return "", false
		}
	}
	return name, invokeFlowName.MatchString(name)
}

// InvokedFlowInvoker admits an invoked run on the canonical Flow runtime
// (InvokedFlowService).
type InvokedFlowInvoker interface {
	Invoke(context.Context, InvokedFlowLaunch) (db.WorkflowRun, db.WorkflowDefinition, error)
}

// InvokeWorkflow creates one queued flow-plane run and admits its Flow
// launch in the same transaction. The Flow worker resolves the host later,
// so the returned run is honestly queued.
func (s *workflowAPIService) InvokeWorkflow(ctx context.Context, input InvokeWorkflowInput) (*InvokeWorkflowResult, error) {
	if strings.TrimSpace(input.Identifier) == "" {
		return nil, pkgerrors.BadRequest("a flow name is required")
	}
	flowID, ok := invokeFlowID(input.Identifier)
	if !ok {
		return nil, pkgerrors.BadRequest("flow must name a file flow: flows/<name>/flow.ts")
	}
	if input.UserID <= 0 {
		return nil, pkgerrors.Unauthorized("a person must invoke a flow")
	}
	if s.invoker == nil {
		return nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "the Flow runtime is not configured on this deployment")
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
	run, def, err := s.invoker.Invoke(ctx, InvokedFlowLaunch{
		RepositoryID: input.RepositoryID, UserID: input.UserID, FlowID: flowID,
		Input: dispatchInputs, TriggerRef: triggerRef,
	})
	if err != nil {
		return nil, err
	}
	return &InvokeWorkflowResult{Run: run, Definition: def}, nil
}
