package db

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

func TestUpdateAgentSessionTerminalStatus_RunFence(t *testing.T) {
	for _, tc := range []struct {
		name       string
		linked     bool
		expected   func(int64) pgtype.Int8
		terminal   bool
		tombstoned bool
		wantUpdate bool
	}{
		{name: "matching run", linked: true, expected: func(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id, Valid: true} }, wantUpdate: true},
		{name: "different run", linked: true, expected: func(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id + 1, Valid: true} }},
		{name: "unlinked session", expected: func(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id, Valid: true} }},
		{name: "terminal session", linked: true, expected: func(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id, Valid: true} }, terminal: true},
		{name: "tombstoned session", linked: true, expected: func(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id, Valid: true} }, tombstoned: true},
		{name: "session scoped with linked run", linked: true, expected: func(int64) pgtype.Int8 { return pgtype.Int8{} }, wantUpdate: true},
		{name: "session scoped without run", expected: func(int64) pgtype.Int8 { return pgtype.Int8{} }, wantUpdate: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			q, pool := newQueries(t)
			userID, repoID := mustCreateUserAndRepo(t, pool, uniqueTestUsername(t), uniqueTestRepoName(t))
			sessionID := uuid.NewString()
			_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "run fence", Status: "active"})
			require.NoError(t, err)

			var runID int64
			if tc.linked {
				def, err := q.UpsertWorkflowDefinition(ctx, UpsertWorkflowDefinitionParams{RepositoryID: repoID, Name: "run-fence", Path: ".smithers/workflows/run-fence.yml", Config: json.RawMessage(`{"steps":[]}`)})
				require.NoError(t, err)
				run, err := q.CreateWorkflowRun(ctx, CreateWorkflowRunParams{RepositoryID: repoID, WorkflowDefinitionID: def.ID, Status: "queued", TriggerEvent: "agent", TriggerRef: "main", TriggerCommitSha: "sha", DispatchInputs: json.RawMessage(`{}`)})
				require.NoError(t, err)
				runID = run.ID
				_, err = q.UpdateAgentSessionWorkflowRun(ctx, UpdateAgentSessionWorkflowRunParams{ID: sessionID, WorkflowRunID: pgtype.Int8{Int64: runID, Valid: true}})
				require.NoError(t, err)
			}
			if tc.terminal {
				_, err = q.UpdateAgentSessionTerminalStatus(ctx, UpdateAgentSessionTerminalStatusParams{ID: sessionID, Status: "completed", FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}})
				require.NoError(t, err)
			}
			if tc.tombstoned {
				require.NoError(t, q.DeleteAgentSession(ctx, DeleteAgentSessionParams{ID: sessionID, UserID: userID}))
			}

			got, err := q.UpdateAgentSessionTerminalStatus(ctx, UpdateAgentSessionTerminalStatusParams{
				ID: sessionID, Status: "failed", FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
				ExpectedWorkflowRunID: tc.expected(runID),
			})
			if tc.wantUpdate {
				require.NoError(t, err)
				require.Equal(t, "failed", got.Status)
			} else {
				require.ErrorIs(t, err, pgx.ErrNoRows)
				stored, getErr := q.GetAgentSession(ctx, sessionID)
				if tc.tombstoned {
					require.ErrorIs(t, getErr, pgx.ErrNoRows)
				} else {
					require.NoError(t, getErr)
					if tc.terminal {
						require.Equal(t, "completed", stored.Status)
					} else {
						require.Equal(t, "active", stored.Status)
					}
				}
			}
		})
	}
}
