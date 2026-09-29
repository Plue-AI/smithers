package services

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// A successful user-message append must leave a durable dispatch request for a
// replacement process, even when the API process exits before launching a run.
func TestAgentUserMessageAppendLeavesClaimableDispatch(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	service := NewAgentServiceWithPool(db.New(pool), pool)
	session, err := service.CreateSession(ctx, CreateAgentSessionInput{
		RepositoryID: repositoryID,
		UserID:       userID,
		Title:        "durable dispatch",
	})
	require.NoError(t, err)
	input := DispatchAgentRunInput{
		SessionID: session.ID, RepositoryID: repositoryID, UserID: userID,
		RepoOwner: "dispatch-owner", RepoName: "dispatch-repo",
		AgentProvider: "codex", AgentTransport: "api", SourceBookmark: "main",
		AllowedPaths: []string{"src/**"}, ChangesetID: 23,
	}
	message, err := service.AppendMessageAndDispatch(ctx, input, []db.CreateAgentPartParams{{
		PartType: "text", Content: json.RawMessage(`{"value":"run this"}`),
	}})
	require.NoError(t, err)
	require.Positive(t, message.ID)

	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	claim, err := store.ClaimForOperations(ctx, "replacement-worker", time.Minute, []string{"agent-run-dispatch"})
	require.NoError(t, err, "accepted user message must be recoverable by another process")
	require.Equal(t, "agent-run-dispatch", claim.Operation)
	require.Equal(t, "agent-message:"+strconv.FormatInt(message.ID, 10), claim.RequestID)
	require.Equal(t, jobs.EffectUnsafe, claim.EffectPolicy)
	var payload DispatchAgentRunInput
	require.NoError(t, json.Unmarshal(claim.Payload, &payload))
	input.TriggerMessageID = message.ID
	require.Equal(t, input, payload, "the replacement worker needs every dispatch input")
	parts, err := db.New(pool).ListAgentMessageParts(ctx, message.ID)
	require.NoError(t, err)
	require.Len(t, parts, 1)
	require.JSONEq(t, `{"value":"run this"}`, string(parts[0].Content))
	_, err = store.ClaimForOperations(ctx, "duplicate-worker", time.Minute, []string{"agent-run-dispatch"})
	require.ErrorIs(t, err, jobs.ErrNoWork, "one committed message permits only one live claim")
	_, err = service.AppendMessageAndDispatch(ctx, input, []db.CreateAgentPartParams{{
		PartType: "text", Content: json.RawMessage(`{"value":"duplicate"}`),
	}})
	require.Error(t, err, "pending dispatch must reject a second user message")
	var messageCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM agent_messages WHERE session_id=$1`, session.ID).Scan(&messageCount))
	require.Equal(t, 1, messageCount)
}

func TestAgentMessageDispatchAdmissionRollsBackWithParts(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	service := NewAgentServiceWithPool(db.New(pool), pool)
	session, err := service.CreateSession(ctx, CreateAgentSessionInput{RepositoryID: repositoryID, UserID: userID, Title: "rollback"})
	require.NoError(t, err)
	_, err = service.AppendMessageAndDispatch(ctx, DispatchAgentRunInput{
		SessionID: session.ID, RepositoryID: repositoryID, UserID: userID,
	}, []db.CreateAgentPartParams{
		{PartType: "text", Content: json.RawMessage(`{"value":"first"}`)},
		{PartType: "text", Content: json.RawMessage(`[]`)}, // violates agent_parts_content_check
	})
	require.Error(t, err)
	var messages, parts, requests int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM agent_messages WHERE session_id=$1`, session.ID).Scan(&messages))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM agent_parts WHERE session_id=$1`, session.ID).Scan(&parts))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='agent-run-dispatch'`).Scan(&requests))
	require.Zero(t, messages)
	require.Zero(t, parts)
	require.Zero(t, requests)

	// Force the final admission insert to fail after a valid message and parts
	// have been written inside the same transaction.
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_agent_dispatch_test() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN
		IF NEW.operation = 'agent-run-dispatch' THEN
			RAISE EXCEPTION 'reject admission for rollback test';
		END IF;
		RETURN NEW;
	END $$`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `CREATE TRIGGER reject_agent_dispatch_test BEFORE INSERT ON product_job_requests
		FOR EACH ROW EXECUTE FUNCTION reject_agent_dispatch_test()`)
	require.NoError(t, err)
	_, err = service.AppendMessageAndDispatch(ctx, DispatchAgentRunInput{
		SessionID: session.ID, RepositoryID: repositoryID, UserID: userID,
	}, []db.CreateAgentPartParams{{PartType: "text", Content: json.RawMessage(`{"value":"valid"}`)}})
	require.ErrorContains(t, err, "reject admission for rollback test")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM agent_messages WHERE session_id=$1`, session.ID).Scan(&messages))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM agent_parts WHERE session_id=$1`, session.ID).Scan(&parts))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='agent-run-dispatch'`).Scan(&requests))
	require.Zero(t, messages)
	require.Zero(t, parts)
	require.Zero(t, requests)
}

func TestAgentMessageDispatchRecoveryFencesDuplicateLaunch(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	service := NewAgentServiceWithPool(db.New(pool), pool)
	session, err := service.CreateSession(ctx, CreateAgentSessionInput{RepositoryID: repositoryID, UserID: userID, Title: "recovery"})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	appendRequest := func(value string) jobs.Claim {
		t.Helper()
		message, appendErr := service.AppendMessageAndDispatch(ctx, DispatchAgentRunInput{
			SessionID: session.ID, RepositoryID: repositoryID, UserID: userID,
		}, []db.CreateAgentPartParams{{PartType: "text", Content: json.RawMessage(`{"value":"` + value + `"}`)}})
		require.NoError(t, appendErr)
		claim, claimErr := store.ClaimForOperations(ctx, "first-"+value, time.Minute, []string{"agent-run-dispatch"})
		require.NoError(t, claimErr)
		require.Equal(t, "agent-message:"+strconv.FormatInt(message.ID, 10), claim.RequestID)
		return claim
	}

	// A process can die after claiming but before any external effect. The next
	// worker must take over and the old token must not settle its operation.
	first := appendRequest("before-external")
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, first.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpiredForOperations(ctx, []string{"agent-run-dispatch"}, 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	replacement, err := store.ClaimForOperations(ctx, "replacement", time.Minute, []string{"agent-run-dispatch"})
	require.NoError(t, err)
	require.Equal(t, first.OperationID, replacement.OperationID)
	require.Greater(t, replacement.Generation, first.Generation)
	require.NotEqual(t, replacement.Token, first.Token)
	require.ErrorIs(t, store.Complete(ctx, first, json.RawMessage(`{"stale":true}`)), jobs.ErrClaimLost)
	require.NoError(t, store.Complete(ctx, replacement, json.RawMessage(`{"recovered":true}`)))

	// Once dispatch may have started, unsafe admission must become uncertain
	// after expiry. No replacement may silently launch a duplicate agent run.
	ambiguous := appendRequest("after-external")
	_, err = store.BeginExternal(ctx, ambiguous, json.RawMessage(`{"phase":"before-dispatch"}`))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, ambiguous.OperationID)
	require.NoError(t, err)
	recovered, err = store.RecoverExpiredForOperations(ctx, []string{"agent-run-dispatch"}, 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	_, err = store.ClaimForOperations(ctx, "must-not-duplicate", time.Minute, []string{"agent-run-dispatch"})
	require.ErrorIs(t, err, jobs.ErrNoWork)
	var state jobs.State
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM product_job_requests WHERE id=$1`, ambiguous.OperationID).Scan(&state))
	require.Equal(t, jobs.StateUncertain, state)
	require.ErrorIs(t, store.Complete(ctx, ambiguous, json.RawMessage(`{"late":true}`)), jobs.ErrClaimLost)
}

func TestAgentMessageDispatchReplacementWorkerRecordsFailure(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	service := NewAgentServiceWithPool(db.New(pool), pool)
	session, err := service.CreateSession(ctx, CreateAgentSessionInput{RepositoryID: repositoryID, UserID: userID, Title: "replacement"})
	require.NoError(t, err)
	message, err := service.AppendMessageAndDispatch(ctx, DispatchAgentRunInput{
		SessionID: session.ID, RepositoryID: repositoryID, UserID: userID,
	}, []db.CreateAgentPartParams{{PartType: "text", Content: json.RawMessage(`{"value":"run"}`)}})
	require.NoError(t, err)
	// The API process is gone. Before its replacement processes the admitted
	// message, the chat closes. The worker must write a durable failure receipt.
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET status='completed' WHERE id=$1`, session.ID)
	require.NoError(t, err)
	replacement := NewAgentServiceWithPool(db.New(pool), pool)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- replacement.RunMessageDispatchWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "message-replacement", Capacity: 1, Lease: time.Second,
			PollInterval: 5 * time.Millisecond, RetryDelay: 5 * time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case workerErr := <-done:
			require.NoError(t, workerErr)
		case <-time.After(5 * time.Second):
			t.Error("replacement worker did not stop")
		}
	})
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	requestID := "agent-message:" + strconv.FormatInt(message.ID, 10)
	var settled jobs.Operation
	require.Eventually(t, func() bool {
		var getErr error
		settled, getErr = store.GetByRequest(ctx, repositoryJobFlowScope(repositoryID, userID), "agent-run-dispatch", requestID)
		return getErr == nil && settled.State == jobs.StateFailed
	}, 5*time.Second, 10*time.Millisecond)
	require.JSONEq(t, `{"code":"chat_unavailable","messageId":`+strconv.FormatInt(message.ID, 10)+`}`, string(settled.TerminalReceipt))
}
