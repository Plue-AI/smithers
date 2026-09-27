package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func invokeTestDefinition(id int64, name, path string, active bool) db.WorkflowDefinition {
	return db.WorkflowDefinition{
		ID:           id,
		RepositoryID: 7,
		Name:         name,
		Path:         path,
		Config:       json.RawMessage(`{"on":{}}`),
		IsActive:     active,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
}

func invokeTestService(defs []db.WorkflowDefinition, captured *db.CreateWorkflowRunParams) WorkflowAPIService {
	querier := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return defs, nil
		},
		createWorkflowRunFn: func(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			*captured = arg
			return db.WorkflowRun{
				ID:                   42,
				RepositoryID:         arg.RepositoryID,
				WorkflowDefinitionID: arg.WorkflowDefinitionID,
				Status:               arg.Status,
				TriggerEvent:         arg.TriggerEvent,
				TriggerRef:           arg.TriggerRef,
				DispatchInputs:       arg.DispatchInputs,
				ExecutionPlane:       arg.ExecutionPlane,
				CreatedAt:            time.Now(),
				UpdatedAt:            time.Now(),
			}, nil
		},
	}
	return NewWorkflowAPIService(querier, nil)
}

func TestInvokeWorkflowCreatesSandboxPlaneRun(t *testing.T) {
	defs := []db.WorkflowDefinition{invokeTestDefinition(11, "echo", ".smithers/workflows/echo.tsx", true)}
	var captured db.CreateWorkflowRunParams
	svc := invokeTestService(defs, &captured)

	result, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{
		RepositoryID: 7,
		Identifier:   "echo",
		Input:        map[string]interface{}{"goal": "hello"},
		TriggerRef:   "main",
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, int64(42), result.Run.ID)
	assert.Equal(t, "queued", result.Run.Status)
	assert.Equal(t, "echo", result.Definition.Name)

	assert.Equal(t, int64(7), captured.RepositoryID)
	assert.Equal(t, int64(11), captured.WorkflowDefinitionID)
	assert.Equal(t, "queued", captured.Status)
	assert.Equal(t, WorkflowRunPlaneSandbox, captured.ExecutionPlane)
	assert.Equal(t, "invoke", captured.TriggerEvent)
	assert.Equal(t, "main", captured.TriggerRef)
	assert.JSONEq(t, `{"goal":"hello"}`, string(captured.DispatchInputs))
}

func TestInvokeWorkflowBillingDeniedCreatesNoRun(t *testing.T) {
	policy := &denyWorkflowDispatchBillingPolicy{}
	created := false
	querier := &mockWorkflowAPIQuerier{
		listDefsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{invokeTestDefinition(11, "echo", ".smithers/workflows/echo.tsx", true)}, nil
		},
		createWorkflowRunFn: func(context.Context, db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			created = true
			return db.WorkflowRun{}, nil
		},
	}
	svc := NewWorkflowAPIService(querier, nil, WithWorkflowAPIBillingPolicy(policy))
	_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{RepositoryID: 7, Identifier: "echo"})
	require.Error(t, err)
	assert.Equal(t, 1, policy.dispatchCalls)
	assert.False(t, created, "billing refusal must precede run creation")
}

func TestInvokeWorkflowMatchesPathAndBasename(t *testing.T) {
	defs := []db.WorkflowDefinition{invokeTestDefinition(11, "echo", ".smithers/workflows/echo.tsx", true)}
	for _, identifier := range []string{".smithers/workflows/echo.tsx", "Echo"} {
		var captured db.CreateWorkflowRunParams
		svc := invokeTestService(defs, &captured)
		_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{
			RepositoryID: 7,
			Identifier:   identifier,
		})
		require.NoError(t, err, "identifier %q", identifier)
		assert.Equal(t, int64(11), captured.WorkflowDefinitionID)
	}
}

func TestInvokeWorkflowRejectsUnknownFlow(t *testing.T) {
	defs := []db.WorkflowDefinition{invokeTestDefinition(11, "echo", ".smithers/workflows/echo.tsx", true)}
	var captured db.CreateWorkflowRunParams
	svc := invokeTestService(defs, &captured)

	_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{
		RepositoryID: 7,
		Identifier:   "missing",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
	assert.Equal(t, int64(0), captured.WorkflowDefinitionID)
}

func TestInvokeWorkflowRejectsInactiveDefinition(t *testing.T) {
	defs := []db.WorkflowDefinition{invokeTestDefinition(11, "echo", ".smithers/workflows/echo.tsx", false)}
	var captured db.CreateWorkflowRunParams
	svc := invokeTestService(defs, &captured)

	_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{
		RepositoryID: 7,
		Identifier:   "echo",
	})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}

func TestInvokeWorkflowValidatesInput(t *testing.T) {
	defs := []db.WorkflowDefinition{invokeTestDefinition(11, "echo", ".smithers/workflows/echo.tsx", true)}
	var captured db.CreateWorkflowRunParams
	svc := invokeTestService(defs, &captured)

	_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{RepositoryID: 7, Identifier: "  "})
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 400, apiErr.Status)
}
