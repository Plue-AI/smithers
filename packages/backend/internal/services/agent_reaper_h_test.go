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
)

type agentReaperHSandboxMetrics struct {
	deltas []float64
}

func (m *agentReaperHSandboxMetrics) ObserveSandboxVMCreate(string, string, float64) {}
func (m *agentReaperHSandboxMetrics) AddSandboxActiveVMs(_ string, delta float64) {
	m.deltas = append(m.deltas, delta)
}
func (m *agentReaperHSandboxMetrics) ObserveSandboxVMSuspend(float64) {}

func TestAgentReaper_H_StartSessionReaperTickerAndReapErrors(t *testing.T) {
	ctx := context.Background()
	(&AgentService{}).StartSessionReaper(ctx, time.Minute)
	(&AgentService{dispatchQ: &mockAgentDispatchQuerier{}}).StartSessionReaper(ctx, 0)
	require.NoError(t, (&AgentService{}).reapExpiredSessions(ctx, time.Minute))
	require.NoError(t, (&AgentService{dispatchQ: &mockAgentDispatchQuerier{}}).reapExpiredSessions(ctx, 0))

	oldTicker := agentSessionReaperNewTicker
	agentSessionReaperNewTicker = func(time.Duration) *time.Ticker {
		return time.NewTicker(2 * time.Millisecond)
	}
	t.Cleanup(func() { agentSessionReaperNewTicker = oldTicker })

	calls := make(chan struct{}, 4)
	startCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	svc := &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		listStaleActiveSessionsFn: func(context.Context, pgtype.Timestamptz) ([]db.AgentSession, error) {
			select {
			case calls <- struct{}{}:
			default:
			}
			return nil, errors.New("temporary list failure")
		},
	}}
	svc.StartSessionReaper(startCtx, time.Minute)
	for i := 0; i < 2; i++ {
		select {
		case <-calls:
		case <-time.After(time.Second):
			t.Fatalf("expected reaper call %d", i+1)
		}
	}
	cancel()

	err := svc.reapExpiredSessions(ctx, time.Minute)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "temporary list failure")

	session := sampleDBAgentSession("77777777-7777-7777-7777-777777777777", 101, 1, "stale")
	session.WorkflowRunID = pgtype.Int8{Int64: 701, Valid: true}
	svc.dispatchQ = &mockAgentDispatchQuerier{
		listStaleActiveSessionsFn: func(context.Context, pgtype.Timestamptz) ([]db.AgentSession, error) {
			return []db.AgentSession{session}, nil
		},
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("timeout update failed")
		},
	}
	require.NoError(t, svc.reapExpiredSessions(ctx, time.Minute))

	require.NoError(t, (&AgentService{}).reapExpiredSession(ctx, session))
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			return db.AgentSession{}, pgx.ErrNoRows
		},
	}
	require.NoError(t, svc.reapExpiredSession(ctx, session))
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateAgentSessionTimedOutFn: func(context.Context, db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error) {
			return db.AgentSession{}, errors.New("timeout failed")
		},
	}
	require.Error(t, svc.reapExpiredSession(ctx, session))
}

func TestAgentReaper_H_NotifyArchiveTerminalAndSandboxBranches(t *testing.T) {
	ctx := context.Background()
	sessionID := "88888888-8888-8888-8888-888888888888"
	session := sampleDBAgentSession(sessionID, 101, 7, "done")
	session.WorkflowRunID = pgtype.Int8{Int64: 900, Valid: true}

	((*AgentService)(nil)).notifyAgentSessionStatus(ctx, session)
	(&AgentService{}).notifyAgentSessionStatus(ctx, session)
	var notifyPayload string
	(&AgentService{q: &mockAgentQuerier{
		notifyAgentSessionFn: func(_ context.Context, arg db.NotifyAgentSessionParams) error {
			assert.Equal(t, "88888888888888888888888888888888", arg.SessionID)
			notifyPayload = arg.Payload
			return errors.New("notify failed")
		},
	}}).notifyAgentSessionStatus(ctx, session)
	var event AgentSessionEvent
	require.NoError(t, json.Unmarshal([]byte(notifyPayload), &event))
	assert.Equal(t, sessionID, event.SessionID)
	assert.Equal(t, "status", event.Action)

	((*AgentService)(nil)).archiveAgentTranscript(ctx, session, "completed")
	(&AgentService{logStore: &mockAgentLogStore{}}).archiveAgentTranscript(ctx, session, "completed")
	(&AgentService{q: &mockAgentQuerier{}}).archiveAgentTranscript(ctx, session, "completed")

	transitioned, updated, err := (&AgentService{
		q: &mockAgentQuerier{},
		dispatchQ: &mockAgentDispatchQuerier{
			updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
				s := session
				s.Status = "completed"
				return s, nil
			},
		},
	}).transitionAgentSessionTerminalStatus(ctx, sessionID, "completed", pgtype.Int8{})
	require.NoError(t, err)
	assert.True(t, updated)
	assert.Equal(t, "completed", transitioned.Status)

	var putCalls int
	svc := &AgentService{
		q: &mockAgentQuerier{
			listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
				return nil, errors.New("list messages failed")
			},
		},
		logStore: &mockAgentLogStore{
			putSessionLogFn: func(context.Context, int64, string, []byte) error {
				putCalls++
				return nil
			},
		},
	}
	svc.archiveAgentTranscript(ctx, session, "completed")
	assert.Equal(t, 0, putCalls)

	svc.q = &mockAgentQuerier{
		listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return []db.AgentMessage{sampleDBAgentMessage(1, sessionID, "user", 0)}, nil
		},
		listAgentMessagePartsFn: func(context.Context, int64) ([]db.AgentPart, error) {
			return nil, errors.New("parts failed")
		},
	}
	svc.archiveAgentTranscript(ctx, session, "failed")
	assert.Equal(t, 0, putCalls)

	svc.q = &mockAgentQuerier{
		listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return []db.AgentMessage{sampleDBAgentMessage(3, sessionID, "assistant", 2)}, nil
		},
		listAgentMessagePartsFn: func(context.Context, int64) ([]db.AgentPart, error) {
			return []db.AgentPart{sampleDBAgentPart(1, 3, 0, "text", json.RawMessage(`{bad`))}, nil
		},
	}
	svc.archiveAgentTranscript(ctx, session, "failed")
	assert.Equal(t, 0, putCalls)

	var archived []byte
	svc.q = &mockAgentQuerier{
		listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
			return []db.AgentMessage{sampleDBAgentMessage(2, sessionID, "assistant", 1)}, nil
		},
		listAgentMessagePartsFn: func(context.Context, int64) ([]db.AgentPart, error) {
			return []db.AgentPart{sampleDBAgentPart(1, 2, 0, "text", json.RawMessage(`{"text":"ok"}`))}, nil
		},
	}
	svc.logStore = &mockAgentLogStore{
		putSessionLogFn: func(_ context.Context, repoID int64, gotSessionID string, payload []byte) error {
			assert.Equal(t, int64(101), repoID)
			assert.Equal(t, sessionID, gotSessionID)
			archived = payload
			return errors.New("store failed")
		},
	}
	svc.archiveAgentTranscript(ctx, session, "failed")
	assert.Contains(t, string(archived), `"status":"failed"`)

	((*AgentService)(nil)).updateAgentWorkflowTerminalState(ctx, session, "completed", "")
	(&AgentService{dispatchQ: &mockAgentDispatchQuerier{}}).updateAgentWorkflowTerminalState(ctx, db.AgentSession{ID: sessionID}, "completed", "")

	svc = &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{}, errors.New("task lookup failed")
		},
	}}
	svc.updateAgentWorkflowTerminalState(ctx, session, "completed", "")

	var deletedAfterMarkError string
	svc = &AgentService{
		dispatchQ: &mockAgentDispatchQuerier{
			getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
				return db.WorkflowTask{ID: 44, WorkflowStepID: 55, VmID: pgtype.Text{String: "vm-mark-error", Valid: true}}, nil
			},
			markWorkflowTaskTerminalByIDFn: func(context.Context, db.MarkWorkflowTaskTerminalByIDParams) (int64, error) {
				return 0, errors.New("mark failed")
			},
		},
		sandbox: &mockSandboxVMClient{
			deleteVMFn: func(_ context.Context, vmID string) error {
				deletedAfterMarkError = vmID
				return errors.New("delete failed")
			},
		},
	}
	svc.updateAgentWorkflowTerminalState(ctx, session, "failed", "boom")
	assert.Equal(t, "vm-mark-error", deletedAfterMarkError)

	var notifyRunAction string
	svc = &AgentService{dispatchQ: &mockAgentDispatchQuerier{
		getWorkflowTaskByRunIDFn: func(context.Context, int64) (db.WorkflowTask, error) {
			return db.WorkflowTask{ID: 45, WorkflowStepID: 56}, nil
		},
		getWorkflowRunByRunIDFn: func(context.Context, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, errors.New("run lookup failed")
		},
		updateWorkflowRunStatusBasedOnTasksFn: func(context.Context, int64) (string, error) {
			return "", errors.New("status failed")
		},
		notifyWorkflowRunEventFn: func(_ context.Context, arg db.NotifyWorkflowRunEventParams) error {
			var payload struct {
				Source string `json:"source"`
			}
			require.NoError(t, json.Unmarshal([]byte(arg.Payload), &payload))
			notifyRunAction = payload.Source
			return nil
		},
	}}
	svc.updateAgentWorkflowTerminalState(ctx, session, "completed", "")
	assert.Equal(t, "agent.task_terminal", notifyRunAction)

	var revokedRunID int64
	svc.revokeAgentSessionToken(ctx, pgtype.Int8{})
	svc.revokeAgentSessionToken(ctx, pgtype.Int8{Int64: 900, Valid: true})
	svc.dispatchQ = &mockAgentDispatchQuerier{
		updateWorkflowRunAgentTokenFn: func(context.Context, db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
			revokedRunID = 901
			return db.WorkflowRun{}, nil
		},
	}
	svc.revokeAgentSessionToken(ctx, pgtype.Int8{Int64: 901, Valid: true})
	assert.Equal(t, int64(901), revokedRunID)

	metrics := &agentReaperHSandboxMetrics{}
	svc = &AgentService{sandbox: &mockSandboxVMClient{}, sandboxMetrics: metrics}
	svc.deleteAgentSandboxVM(ctx, sessionID, 900, pgtype.Text{}, true)
	svc.deleteAgentSandboxVM(ctx, sessionID, 900, pgtype.Text{String: "vm-delete-ok", Valid: true}, true)
	assert.Equal(t, []float64{-1}, metrics.deltas)

	svc.sandbox = &mockSandboxVMClient{
		deleteVMFn: func(context.Context, string) error {
			return errors.New("delete failed")
		},
	}
	svc.deleteAgentSandboxVM(ctx, sessionID, 900, pgtype.Text{String: "vm-delete-fail", Valid: true}, true)
	assert.Equal(t, []float64{-1}, metrics.deltas)
}
