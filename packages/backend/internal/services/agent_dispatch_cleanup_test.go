package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestMarkAgentDispatchInfrastructureFailed_FencesSessionAndRevokesOwnRun(t *testing.T) {
	const (
		sessionID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
		runID     = int64(42)
	)
	for _, tc := range []struct {
		name       string
		sessionID  string
		transition error
		wantFinish bool
	}{
		{name: "stale run has no session row", sessionID: sessionID, transition: pgx.ErrNoRows},
		{name: "terminal transition errors", sessionID: sessionID, transition: errors.New("database unavailable")},
		{name: "session omitted", sessionID: ""},
		{name: "own run finalizes", sessionID: sessionID, wantFinish: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var transitions, tokenRevocations, archives int
			metrics := &mockAgentSessionMetricsObserver{}
			dq := &mockAgentDispatchQuerier{
				updateAgentSessionTerminalStatusFn: func(_ context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
					transitions++
					require.Equal(t, tc.sessionID, arg.ID)
					require.Equal(t, "failed", arg.Status)
					require.Equal(t, pgtype.Int8{Int64: runID, Valid: true}, arg.ExpectedWorkflowRunID)
					if tc.transition != nil {
						return db.AgentSession{}, tc.transition
					}
					session := sampleDBAgentSession(arg.ID, 101, 7, "agent")
					session.WorkflowRunID = pgtype.Int8{Int64: runID, Valid: true}
					session.Status = arg.Status
					return session, nil
				},
				updateWorkflowRunAgentTokenFn: func(_ context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error) {
					tokenRevocations++
					require.Equal(t, runID, arg.ID)
					require.False(t, arg.AgentTokenHash.Valid)
					require.True(t, arg.AgentTokenExpiresAt.Valid)
					return db.WorkflowRun{ID: runID}, nil
				},
			}
			svc := &AgentService{
				dispatchQ: dq,
				q: &mockAgentQuerier{listAgentMessagesFn: func(context.Context, db.ListAgentMessagesParams) ([]db.AgentMessage, error) {
					return nil, nil
				}},
				logStore: &mockAgentLogStore{putSessionLogFn: func(_ context.Context, _ int64, _ string, _ []byte) error {
					archives++
					return nil
				}},
				sessionMetrics: metrics,
			}
			svc.markAgentDispatchInfrastructureFailed(context.Background(), 0, 20, runID, tc.sessionID, "dispatch failed")
			require.Equal(t, 1, tokenRevocations, "the failed run must lose its callback token independently of session transition")
			if tc.sessionID == "" {
				require.Zero(t, transitions)
			} else {
				require.Equal(t, 1, transitions)
			}
			if tc.wantFinish {
				require.Equal(t, []string{"failed"}, metrics.completions)
				require.Equal(t, 1, archives)
			} else {
				require.Empty(t, metrics.completions)
				require.Zero(t, archives)
			}
		})
	}
}
