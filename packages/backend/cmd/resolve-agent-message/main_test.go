package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func commandArgs(message, outcome, evidence string) []string {
	return []string{
		"--repository=123", "--user=456", "--message=" + message,
		"--outcome=" + outcome, "--evidence=" + evidence,
	}
}

func TestRunRejectsInvalidArgumentsBeforeDatabase(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "")
	valid := commandArgs("789", "completed", "operator checked runtime")
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"unknown flag", append(append([]string{}, valid...), "--unknown"), "flag provided but not defined"},
		{"trailing argument", append(append([]string{}, valid...), "extra"), "positive --repository"},
		{"missing repository", commandArgs("789", "completed", "evidence")[1:], "positive --repository"},
		{"zero repository", []string{"--repository=0", "--user=456", "--message=789", "--outcome=completed", "--evidence=evidence"}, "positive --repository"},
		{"negative user", []string{"--repository=123", "--user=-1", "--message=789", "--outcome=completed", "--evidence=evidence"}, "positive --repository"},
		{"zero message", commandArgs("0", "completed", "evidence"), "positive --repository"},
		{"non numeric message", commandArgs("abc", "completed", "evidence"), "invalid value"},
		{"blank evidence", commandArgs("789", "completed", " \t "), "positive --repository"},
		{"evidence too long", commandArgs("789", "completed", strings.Repeat("a", 4097)), "positive --repository"},
		{"missing outcome", commandArgs("789", "", "evidence"), "--outcome must be"},
		{"retry forbidden", commandArgs("789", "retry", "evidence"), "automatic retry is not supported"},
		{"unknown outcome", commandArgs("789", "unknown", "evidence"), "--outcome must be"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			err := run(context.Background(), tc.args, &output)
			require.ErrorContains(t, err, tc.want)
			require.NotContains(t, output.String(), "resolved as")
		})
	}
	var output bytes.Buffer
	err := run(context.Background(), valid, &output)
	require.ErrorContains(t, err, "SMITHERS_DATABASE_URL is required")
	require.Empty(t, output.String())

	t.Setenv("SMITHERS_DATABASE_URL", "postgresql://%")
	err = run(context.Background(), valid, &output)
	require.ErrorContains(t, err, "invalid database configuration")
	require.Empty(t, output.String())
}

func TestRunResolvesRecoveredAgentMessagesWithOperatorEvidence(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	t.Setenv("SMITHERS_DATABASE_URL", databaseURL)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	scope := jobs.Scope{TenantID: "repository:123", PrincipalID: "user:456"}

	for _, tc := range []struct {
		message string
		outcome string
		state   jobs.State
		event   string
	}{
		{"789", "completed", jobs.StateCompleted, "operation.completed"},
		{"790", "failed", jobs.StateFailed, "operation.failed"},
		{"791", "cancelled", jobs.StateCancelled, "operation.cancelled"},
	} {
		t.Run(tc.outcome, func(t *testing.T) {
			requestID := "agent-message:" + tc.message
			admitted, err := store.Admit(ctx, jobs.Admission{
				Scope: scope, Operation: "agent-run-dispatch", RequestID: requestID,
				Payload:              json.RawMessage(fmt.Sprintf(`{"messageId":%s}`, tc.message)),
				AuthorizationContext: json.RawMessage(`{"userId":456}`),
				EffectPolicy:         jobs.EffectUnsafe,
			})
			require.NoError(t, err)
			claim, err := store.ClaimForOperations(ctx, "agent-dispatch-worker", time.Minute, []string{"agent-run-dispatch"})
			require.NoError(t, err)
			require.Equal(t, admitted.OperationID, claim.OperationID)
			attempt, err := store.BeginExternal(ctx, claim, json.RawMessage(`{"phase":"launching"}`))
			require.NoError(t, err)
			require.Equal(t, 1, attempt)
			_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, admitted.OperationID)
			require.NoError(t, err)
			recovered, err := store.RecoverExpiredForOperations(ctx, []string{"agent-run-dispatch"}, 1)
			require.NoError(t, err)
			require.Equal(t, 1, recovered)
			operation, err := store.GetByRequest(ctx, scope, "agent-run-dispatch", requestID)
			require.NoError(t, err)
			require.Equal(t, jobs.StateUncertain, operation.State)
			require.Equal(t, 1, operation.Attempt)
			require.Equal(t, 1, operation.ExternalAttempt)

			if tc.message == "789" {
				for _, args := range [][]string{
					{"--repository=123", "--user=457", "--message=789", "--outcome=completed", "--evidence=wrong user"},
					{"--repository=123", "--user=456", "--message=999", "--outcome=completed", "--evidence=wrong message"},
					{"--repository=124", "--user=456", "--message=789", "--outcome=completed", "--evidence=wrong repository"},
				} {
					var output bytes.Buffer
					require.ErrorIs(t, run(ctx, args, &output), jobs.ErrNotFound)
					require.Empty(t, output.String())
				}
				retryOutput := new(bytes.Buffer)
				require.ErrorContains(t, run(ctx, commandArgs("789", "retry", "inspected"), retryOutput), "automatic retry is not supported")
				require.Empty(t, retryOutput.String())
				operation, err = store.Get(ctx, scope, admitted.OperationID)
				require.NoError(t, err)
				require.Equal(t, jobs.StateUncertain, operation.State)
			}

			evidence := "  checked runtime; no execution remains  "
			var output bytes.Buffer
			require.NoError(t, run(ctx, commandArgs(tc.message, tc.outcome, evidence), &output))
			require.Equal(t, fmt.Sprintf("Message %s resolved as %s\n", tc.message, tc.outcome), output.String())
			operation, err = store.Get(ctx, scope, admitted.OperationID)
			require.NoError(t, err)
			require.Equal(t, tc.state, operation.State)
			require.Equal(t, 1, operation.Attempt)
			require.Equal(t, 1, operation.ExternalAttempt)
			var receipt struct {
				MessageID        int64  `json:"messageId"`
				OperatorEvidence string `json:"operatorEvidence"`
				Outcome          string `json:"outcome"`
			}
			require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &receipt))
			require.Equal(t, mustMessageID(t, tc.message), receipt.MessageID)
			require.Equal(t, strings.TrimSpace(evidence), receipt.OperatorEvidence)
			require.Equal(t, tc.outcome, receipt.Outcome)
			var dispatchStatus string
			require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM product_job_dispatches WHERE operation_id=$1`, admitted.OperationID).Scan(&dispatchStatus))
			require.Equal(t, "done", dispatchStatus)
			page, err := store.Replay(ctx, scope, 0, 100)
			require.NoError(t, err)
			var terminalEvents []jobs.Event
			for _, event := range page.Events {
				if event.OperationID == admitted.OperationID && event.Type == tc.event {
					terminalEvents = append(terminalEvents, event)
				}
			}
			require.Len(t, terminalEvents, 1)
			require.JSONEq(t, string(operation.TerminalReceipt), string(terminalEvents[0].Data))
			_, err = store.ClaimForOperations(ctx, "must-not-retry", time.Minute, []string{"agent-run-dispatch"})
			require.ErrorIs(t, err, jobs.ErrNoWork)
			output.Reset()
			require.ErrorIs(t, run(ctx, commandArgs(tc.message, tc.outcome, "again"), &output), jobs.ErrUncertainResolution)
			require.Empty(t, output.String())
		})
	}

	accepted, err := store.Admit(ctx, jobs.Admission{
		Scope: scope, Operation: "agent-run-dispatch", RequestID: "agent-message:792",
		Payload: json.RawMessage(`{}`), EffectPolicy: jobs.EffectUnsafe,
	})
	require.NoError(t, err)
	var output bytes.Buffer
	require.ErrorIs(t, run(ctx, commandArgs("792", "completed", "not launched"), &output), jobs.ErrUncertainResolution)
	require.Empty(t, output.String())
	operation, err := store.Get(ctx, scope, accepted.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, operation.State)
	require.Empty(t, operation.TerminalReceipt)
}

func mustMessageID(t *testing.T, message string) int64 {
	t.Helper()
	var id int64
	_, err := fmt.Sscan(message, &id)
	require.NoError(t, err)
	return id
}
