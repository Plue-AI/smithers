package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Every CI run is created on the sandbox plane, where the sandbox scheduler
// runs each job in a NixOS guest; agent runs are created on the agent plane.
// The plane is immutable after creation, so exactly one executor ever claims
// a run.

func dispatchExecutionPlaneRun(t *testing.T, config string) db.CreateWorkflowRunParams {
	t.Helper()
	mock := &mockWorkflowRunQuerier{
		listDefsFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, config)}, nil
		},
	}
	svc := newCurrentPushTestService(mock)
	results, err := svc.DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42,
		Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "cafebabe"},
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Len(t, mock.createRunCalls, 1)
	return mock.createRunCalls[0]
}

// A repository needs neither .smithers/environment.nix nor a registered
// closure image to run CI: its guests boot the platform base closure.
func TestDispatchForEvent_CIRunIsSandboxPlane(t *testing.T) {
	t.Parallel()
	created := dispatchExecutionPlaneRun(t, `{"on":{"push":{}},"jobs":{"build":{"steps":[{"run":"make"}]}}}`)
	assert.Equal(t, WorkflowRunPlaneSandbox, created.ExecutionPlane)
}

func TestDispatchForEvent_RunsOnCannotSelectAPlane(t *testing.T) {
	t.Parallel()
	for _, config := range []string{
		`{"on":{"push":{}},"jobs":{"build":{"runs-on":"agent"}}}`,
		`{"on":{"push":{}},"jobs":{"build":{"runs-on":"runner"},"test":{}}}`,
	} {
		created := dispatchExecutionPlaneRun(t, config)
		assert.Equal(t, WorkflowRunPlaneSandbox, created.ExecutionPlane, config)
	}
}

func TestDispatchAgentRun_CreatesAgentPlaneRun(t *testing.T) {
	t.Parallel()

	var created *db.CreateWorkflowRunParams
	dq := &mockAgentDispatchQuerier{
		createWorkflowRunFn: func(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			created = &arg
			return db.WorkflowRun{ID: 10, RepositoryID: arg.RepositoryID, Status: arg.Status, ExecutionPlane: arg.ExecutionPlane}, nil
		},
	}
	svc := newTestDispatchService(dq, nil)
	svc.q = &mockAgentQuerier{
		getAgentSessionWorkflowRunIDFn: func(_ context.Context, _ string) (pgtype.Int8, error) {
			return pgtype.Int8{}, nil
		},
	}

	_, _ = svc.DispatchAgentRun(context.Background(), DispatchAgentRunInput{
		SessionID:    "sess-plane",
		RepositoryID: 101,
		UserID:       7,
	})

	require.NotNil(t, created, "agent dispatch must create a workflow run")
	assert.Equal(t, WorkflowRunPlaneAgent, created.ExecutionPlane,
		"agent runs must never be claimed by the sandbox scheduler")
}
