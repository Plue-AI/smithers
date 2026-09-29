package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type recordingAgentFlowDispatcher struct {
	launches []flowdispatch.LaunchRequest
	cancels  []struct {
		scope     jobs.Scope
		requestID string
	}
}

func (dispatcher *recordingAgentFlowDispatcher) Admit(_ context.Context, request flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	dispatcher.launches = append(dispatcher.launches, request)
	return jobs.RequestReceipt{OperationID: "operation-1", RequestID: request.RequestID, State: jobs.StateAccepted}, nil
}

func (dispatcher *recordingAgentFlowDispatcher) CancelRequest(_ context.Context, scope jobs.Scope, requestID string) (jobs.Operation, error) {
	dispatcher.cancels = append(dispatcher.cancels, struct {
		scope     jobs.Scope
		requestID string
	}{scope: scope, requestID: requestID})
	return jobs.Operation{ID: "operation-1", Scope: scope, State: jobs.StateWaiting}, nil
}

func TestCodingTurnRequestSplitsTheWindowFromThePrompt(t *testing.T) {
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Where does the greeting live?"},
		{Role: "assistant", Content: "In greeting.mjs."},
		{Role: "assistant", Content: "   "},
		{Role: "user", Content: "Explain what it exports."},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{payload: payload}
	dispatch.run.ID = 77

	turn, err := dispatch.codingTurnRequest()
	require.NoError(t, err)
	assert.Equal(t, "Explain what it exports.", turn.Prompt)
	assert.Equal(t, "run-77", turn.TurnID)
	assert.Equal(t, codingDispatchRole, turn.Role)
	assert.Empty(t, turn.Model)
	assert.Equal(t, []codingTurnMessage{
		{Role: "user", Content: "Where does the greeting live?"},
		{Role: "assistant", Content: "In greeting.mjs."},
	}, turn.History)
}

func TestCodingTurnRequestRefusesAWindowWithNothingToAnswer(t *testing.T) {
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "assistant", Content: "Anything else?"},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{payload: payload}
	_, err = dispatch.codingTurnRequest()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "user message")
}

func TestCodingFlowDispatchAuthorizesWithoutSandboxProvider(t *testing.T) {
	dispatch := &agentDispatch{
		ctx: context.Background(),
		svc: &AgentService{
			dispatchQ:      &mockAgentDispatchQuerier{},
			flowDispatcher: &recordingAgentFlowDispatcher{},
			workspaces:     stubAgentWorkspaceBackend{},
		},
		input: DispatchAgentRunInput{RepoOwner: "owner", RepoName: "repo"},
	}
	require.NoError(t, dispatch.authorize())
	dispatch.svc.flowDispatcher = nil
	require.ErrorContains(t, dispatch.authorize(), "sandbox provider unavailable")
}

func TestAdmitCodingTurnPersistsCanonicalFlowRequestWithoutRuntimeCall(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Explain what greeting.mjs exports."},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{
		svc: &AgentService{
			flowDispatcher: dispatcher,
			workspaces:     stubAgentWorkspaceBackend{},
		},
		ctx: context.Background(),
		input: DispatchAgentRunInput{
			SessionID: "session-1", RepositoryID: 5, UserID: 9,
			RepoOwner: "org", RepoName: "repo",
		},
		payload: payload,
	}
	dispatch.run.ID = 42
	dispatch.task.ID = 43

	require.NoError(t, dispatch.admitCodingTurn())
	require.Len(t, dispatcher.launches, 1)
	launch := dispatcher.launches[0]
	assert.Equal(t, codingDispatchFlowID, launch.FlowID)
	assert.Equal(t, "agent-run:42", launch.RequestID)
	assert.Equal(t, jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, launch.Scope)
	assert.Equal(t, "agent-session", launch.Target.BindingKind)
	assert.Equal(t, "session-1", launch.Target.BindingID)
	assert.Equal(t, flowdispatch.ApprovalAuto, launch.ApprovalPolicy)
	assert.Equal(t, "operation-1", dispatch.flowOperationID)

	var turn codingTurnInput
	require.NoError(t, json.Unmarshal(launch.Payload, &turn))
	assert.Equal(t, "Explain what greeting.mjs exports.", turn.Prompt)
	var projection agentFlowProjection
	require.NoError(t, json.Unmarshal(launch.Projection, &projection))
	assert.Equal(t, agentFlowProjection{
		Kind: "agent-workflow-run", SessionID: "session-1", WorkflowRunID: 42, WorkflowTaskID: 43,
	}, projection)
}

func TestAdmitCodingTurnRecordsTheAuthenticatedMessageTrigger(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	text := "Explain what greeting.mjs exports.\n  Keep it short.  "
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "Earlier question"},
		{Role: "assistant", Content: "Earlier answer"},
		{Role: "user", Content: text},
	}})
	require.NoError(t, err)
	dispatch := &agentDispatch{
		svc: &AgentService{flowDispatcher: dispatcher, workspaces: stubAgentWorkspaceBackend{}},
		ctx: context.Background(),
		input: DispatchAgentRunInput{
			SessionID: "session-1", RepositoryID: 5, UserID: 9, TriggerMessageID: 314,
			MessageAuthor: "alice", RepoOwner: "org", RepoName: "repo",
		},
		payload: payload,
	}
	dispatch.run.ID = 42

	require.NoError(t, dispatch.admitCodingTurn())
	// Admission replay re-derives the same request under the same id.
	require.NoError(t, dispatch.admitCodingTurn())
	require.Len(t, dispatcher.launches, 2)
	assert.Equal(t, dispatcher.launches[0].RequestID, dispatcher.launches[1].RequestID)
	assert.JSONEq(t, string(dispatcher.launches[0].Payload), string(dispatcher.launches[1].Payload))

	var raw map[string]any
	require.NoError(t, json.Unmarshal(dispatcher.launches[0].Payload, &raw))
	assert.Equal(t, map[string]any{
		"kind": "message", "author": "alice", "conversationId": "session-1",
		"messageId": "314", "text": text, "origin": "chat",
	}, raw["trigger"])
}

func TestCodingTurnRecordsNoTriggerWithoutAnAuthenticatedMessage(t *testing.T) {
	payload, err := json.Marshal(agentTaskPayload{MessageHistory: []agentTaskPayloadMessage{
		{Role: "user", Content: "A reviewer returned landing request #3 to you."},
	}})
	require.NoError(t, err)
	for name, input := range map[string]DispatchAgentRunInput{
		"composed turn":    {SessionID: "session-1", TriggerMessageID: 3},
		"blank author":     {SessionID: "session-1", TriggerMessageID: 3, MessageAuthor: "  "},
		"no message":       {SessionID: "session-1", MessageAuthor: "alice"},
		"no conversation":  {TriggerMessageID: 3, MessageAuthor: "alice"},
		"negative message": {SessionID: "session-1", TriggerMessageID: -1, MessageAuthor: "alice"},
	} {
		t.Run(name, func(t *testing.T) {
			dispatch := &agentDispatch{payload: payload, input: input}
			turn, err := dispatch.codingTurnRequest()
			require.NoError(t, err)
			assert.Nil(t, turn.Trigger)
			encoded, err := json.Marshal(turn)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), "trigger")
		})
	}
}

func TestCodingDispatchEnabledNeedsDispatcherAndWorkspace(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	owned := DispatchAgentRunInput{RepoOwner: "org", RepoName: "repo"}
	unwired := &agentDispatch{svc: &AgentService{workspaces: stubAgentWorkspaceBackend{}}, input: owned}
	assert.False(t, unwired.codingDispatchEnabled())
	assert.False(t, unwired.svc.guestEntrypointAssumed)

	ephemeral := &agentDispatch{svc: &AgentService{flowDispatcher: dispatcher}, input: owned}
	assert.False(t, ephemeral.codingDispatchEnabled())

	wired := &agentDispatch{svc: &AgentService{flowDispatcher: dispatcher, workspaces: stubAgentWorkspaceBackend{}}, input: owned}
	assert.True(t, wired.codingDispatchEnabled())
}

func TestCleanupCancellationReconnectsByStableProductRequest(t *testing.T) {
	dispatcher := &recordingAgentFlowDispatcher{}
	dispatch := &agentDispatch{
		svc:   &AgentService{flowDispatcher: dispatcher},
		input: DispatchAgentRunInput{RepositoryID: 5, UserID: 9},
	}
	dispatch.run.ID = 42
	dispatch.cancelCodingTurn(context.Background())
	require.Len(t, dispatcher.cancels, 1)
	assert.Equal(t, jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, dispatcher.cancels[0].scope)
	assert.Equal(t, "agent-run:42", dispatcher.cancels[0].requestID)
}

func TestProjectFlowRuntimeIgnoresSupersededTurn(t *testing.T) {
	projection, err := json.Marshal(agentFlowProjection{Kind: "agent-workflow-run", SessionID: "session-1", WorkflowRunID: 100, WorkflowTaskID: 101})
	require.NoError(t, err)
	terminalCalled := false
	dq := &mockAgentDispatchQuerier{
		getAgentSessionForFlowProjectionFn: func(_ context.Context, arg db.GetAgentSessionForFlowProjectionParams) (db.AgentSession, error) {
			assert.Equal(t, int64(100), arg.WorkflowRunID)
			assert.Equal(t, int64(101), arg.WorkflowTaskID)
			return db.AgentSession{}, pgx.ErrNoRows // session now belongs to run 200
		},
		updateAgentSessionTerminalForFlowFn: func(context.Context, db.UpdateAgentSessionTerminalStatusForFlowParams) (db.AgentSession, error) {
			terminalCalled = true
			return db.AgentSession{}, nil
		},
	}
	service := &AgentService{dispatchQ: dq, workspaces: stubAgentWorkspaceBackend{}}
	require.NoError(t, service.ProjectFlowRuntime(context.Background(), flowdispatch.ProjectionUpdate{
		State:      jobs.StateCompleted,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: "old-host-run", FlowID: codingDispatchFlowID},
	}))
	assert.False(t, terminalCalled)
	assert.Zero(t, dq.codingHost.WorkflowRunID)
}

func TestProjectFlowRuntimeDoesNotCleanUpAfterOwnerChangesDuringProjection(t *testing.T) {
	projection, err := json.Marshal(agentFlowProjection{Kind: "agent-workflow-run", SessionID: "session-1", WorkflowRunID: 100, WorkflowTaskID: 101})
	require.NoError(t, err)
	terminalCalled := false
	notified := false
	service := &AgentService{
		q: &mockAgentQuerier{notifyAgentSessionFn: func(context.Context, db.NotifyAgentSessionParams) error { notified = true; return nil }},
		dispatchQ: &mockAgentDispatchQuerier{
			getAgentSessionForFlowProjectionFn: func(context.Context, db.GetAgentSessionForFlowProjectionParams) (db.AgentSession, error) {
				return db.AgentSession{ID: "session-1", WorkflowRunID: pgtype.Int8{Int64: 100, Valid: true}}, nil
			},
			updateAgentSessionTerminalForFlowFn: func(_ context.Context, arg db.UpdateAgentSessionTerminalStatusForFlowParams) (db.AgentSession, error) {
				terminalCalled = true
				assert.Equal(t, "session-1", arg.SessionID)
				assert.Equal(t, pgtype.Int8{Int64: 100, Valid: true}, arg.WorkflowRunID)
				assert.Equal(t, int64(101), arg.WorkflowTaskID)
				assert.Equal(t, "completed", arg.Status)
				return db.AgentSession{}, pgx.ErrNoRows // run 200 claimed the row after the read
			},
		},
	}
	require.NoError(t, service.ProjectFlowRuntime(context.Background(), flowdispatch.ProjectionUpdate{
		State: jobs.StateCompleted, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection},
	}))
	assert.True(t, terminalCalled)
	assert.False(t, notified)
}

type stubAgentWorkspaceBackend struct{}

func (stubAgentWorkspaceBackend) CreateAgentWorkspace(context.Context, CreateAgentWorkspaceInput) (AgentWorkspaceResult, error) {
	return AgentWorkspaceResult{}, nil
}
func (stubAgentWorkspaceBackend) SuspendAgentWorkspace(context.Context, string) error { return nil }
func (stubAgentWorkspaceBackend) FailAgentWorkspace(context.Context, string) error    { return nil }
func (stubAgentWorkspaceBackend) SnapshotAgentWorkspace(context.Context, string, string) (string, error) {
	return "", nil
}
