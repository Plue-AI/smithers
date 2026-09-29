package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type agentReaperCovSandboxMetrics struct {
	activeDeltas []float64
}

func (m *agentReaperCovSandboxMetrics) ObserveSandboxVMCreate(string, string, float64) {}
func (m *agentReaperCovSandboxMetrics) AddSandboxActiveVMs(_ string, delta float64) {
	m.activeDeltas = append(m.activeDeltas, delta)
}
func (m *agentReaperCovSandboxMetrics) ObserveSandboxVMSuspend(float64) {}

func TestAgentReaper_Cov_StartAndStaleSessionErrors(t *testing.T) {
	ctx := context.Background()
	(&AgentService{}).StartSessionReaper(ctx, time.Hour)
	(&AgentService{dispatchQ: &mockAgentDispatchQuerier{}}).StartSessionReaper(ctx, 0)
	require.NoError(t, (&AgentService{}).reapExpiredSessions(ctx, time.Hour))
	require.NoError(t, (&AgentService{dispatchQ: &mockAgentDispatchQuerier{}}).reapExpiredSessions(ctx, 0))

	iteration := make(chan struct{}, 1)
	startCtx, cancel := context.WithCancel(ctx)
	svc := &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		listStaleActiveSessionsFn: func(context.Context, pgtype.Timestamptz) ([]db.AgentSession, error) {
			iteration <- struct{}{}
			return nil, errors.New("list failed")
		},
	}}
	svc.StartSessionReaper(startCtx, time.Hour)
	select {
	case <-iteration:
	case <-time.After(time.Second):
		t.Fatal("expected initial reaper iteration")
	}
	cancel()

	err := svc.reapExpiredSessions(ctx, time.Hour)
	require.Error(t, err)
	assert.Equal(t, "list failed", err.Error())

	session := sampleDBAgentSession("44444444-4444-4444-4444-444444444444", 101, 7, "stale")
	svc.dispatchQ = &mockAgentDispatchQuerier{
		listStaleActiveSessionsFn: func(context.Context, pgtype.Timestamptz) ([]db.AgentSession, error) {
			return []db.AgentSession{session}, nil
		},
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("update failed")
		},
	}
	require.NoError(t, svc.reapExpiredSessions(ctx, time.Hour), "per-session failures are logged and iteration continues")

	require.NoError(t, (&AgentService{}).reapExpiredSession(ctx, session))
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			return db.AgentSession{}, pgx.ErrNoRows
		},
	}
	require.NoError(t, svc.reapExpiredSession(ctx, session))
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("boom")
		},
	}
	require.Error(t, svc.reapExpiredSession(ctx, session))
}

func TestAgentReaper_Cov_TransitionNotifyArchiveAndWorkflowBranches(t *testing.T) {
	ctx := context.Background()
	sessionID := "55555555-5555-5555-5555-555555555555"
	session := sampleDBAgentSession(sessionID, 101, 7, "done")
	session.WorkflowRunID = pgtype.Int8{Int64: 900, Valid: true}

	emptySvc := &AgentService{}
	_, updated, err := emptySvc.transitionAgentSessionTerminalStatus(ctx, sessionID, "failed", pgtype.Int8{})
	require.NoError(t, err)
	assert.False(t, updated)

	svc := &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			return db.AgentSession{}, pgx.ErrNoRows
		},
	}}
	_, updated, err = svc.transitionAgentSessionTerminalStatus(ctx, sessionID, "failed", pgtype.Int8{})
	require.NoError(t, err)
	assert.False(t, updated)
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("transition failed")
		},
	}
	_, _, err = svc.transitionAgentSessionTerminalStatus(ctx, sessionID, "failed", pgtype.Int8{})
	require.Error(t, err)

	var notifyPayload string
	svc = &AgentService{q: &mockAgentQuerier{
		notifyAgentSessionFn: func(_ context.Context, arg db.NotifyAgentSessionParams) error {
			assert.Equal(t, "55555555555555555555555555555555", arg.SessionID)
			notifyPayload = arg.Payload
			return nil
		},
	}}
	svc.notifyAgentSessionStatus(ctx, session)
	var event AgentSessionEvent
	require.NoError(t, json.Unmarshal([]byte(notifyPayload), &event))
	assert.Equal(t, sessionID, event.SessionID)
	assert.Equal(t, "status", event.Action)

	var archived []byte
	svc = &AgentService{
		q: &mockAgentQuerier{
			listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
				return []db.AgentMessage{sampleDBAgentMessage(1, sessionID, "user", 0)}, nil
			},
			listAgentMessagePartsFn: func(context.Context, int64) ([]db.AgentPart, error) {
				return []db.AgentPart{sampleDBAgentPart(1, 1, 0, "text", json.RawMessage(`{"text":"hi"}`))}, nil
			},
		},
		logStore: &mockAgentLogStore{
			putSessionLogFn: func(_ context.Context, repoID int64, gotSessionID string, payload []byte) error {
				assert.Equal(t, int64(101), repoID)
				assert.Equal(t, sessionID, gotSessionID)
				archived = payload
				return nil
			},
		},
	}
	svc.archiveAgentTranscript(ctx, session, "completed")
	assert.Contains(t, string(archived), `"status":"completed"`)

	svc.updateAgentWorkflowTerminalState(ctx, db.AgentSession{ID: sessionID}, "completed", "")

	svc.dispatchQ = &mockAgentDispatchQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, pgx.ErrNoRows
		},
	}
	svc.updateAgentWorkflowTerminalState(ctx, session, "completed", "")

	var terminal db.MarkWorkflowTaskTerminalByIDParams
	var stepTerminal db.UpdateWorkflowStepStatusTerminalParams
	var deletedVM string
	metrics := &agentReaperCovSandboxMetrics{}
	svc.dispatchQ = &mockAgentDispatchQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{ID: 33, WorkflowRunID: 900, WorkflowStepID: 44, Status: "running", VmID: pgtype.Text{String: "vm-terminal", Valid: true}}, nil
		},
		markWorkflowTaskTerminalByIDFn: func(_ context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
			terminal = arg
			return 1, nil
		},
		updateWorkflowStepStatusTerminalFn: func(_ context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error) {
			stepTerminal = arg
			return 1, nil
		},
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 900, Status: "running", CreatedAt: time.Now().Add(-time.Minute)}, nil
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(context.Context, int64) (string, error) {
			return "success", nil
		},
	}
	svc.sandbox = &mockSandboxVMClient{
		deleteVMFn: func(context.Context, string) error {
			deletedVM = "vm-terminal"
			return nil
		},
	}
	svc.sandboxMetrics = metrics
	svc.updateAgentWorkflowTerminalState(ctx, session, "completed", "")
	assert.Equal(t, int64(33), terminal.ID)
	assert.Equal(t, "done", terminal.Status)
	assert.Equal(t, int64(44), stepTerminal.StepID)
	assert.Equal(t, "success", stepTerminal.Status)
	assert.Equal(t, "vm-terminal", deletedVM)
	assert.Equal(t, []float64{-1}, metrics.activeDeltas)

	svc.sandbox = &mockSandboxVMClient{
		deleteVMFn: func(context.Context, string) error {
			return &sandbox.StatusError{StatusCode: 404, Message: "gone"}
		},
	}
	svc.deleteAgentSandboxVM(ctx, sessionID, 900, pgtype.Text{String: "vm-missing", Valid: true}, true)
	assert.Equal(t, []float64{-1, -1}, metrics.activeDeltas)
}
