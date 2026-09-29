package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func newBoundaryMessageSession(t *testing.T) (*AgentService, DispatchAgentRunInput) {
	t.Helper()
	pool := newProductTestPool(t)
	userID, repositoryID := setupTestUserAndRepo(t, pool)
	service := NewAgentServiceWithPool(db.New(pool), pool)
	session, err := service.CreateSession(t.Context(), CreateAgentSessionInput{
		RepositoryID: repositoryID, UserID: userID, Title: "dispatch boundary",
	})
	require.NoError(t, err)
	var owner, name string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT u.lower_username, r.lower_name FROM users u JOIN repositories r ON r.user_id=u.id WHERE r.id=$1`, repositoryID).Scan(&owner, &name))
	return service, DispatchAgentRunInput{
		SessionID: session.ID, RepositoryID: repositoryID, UserID: userID,
		RepoOwner: owner, RepoName: name,
	}
}

func boundaryMessageParts() []db.CreateAgentPartParams {
	return []db.CreateAgentPartParams{{PartType: "text", Content: json.RawMessage(`{"value":"run"}`)}}
}

func appendBoundaryMessage(t *testing.T, service *AgentService, input DispatchAgentRunInput) int64 {
	t.Helper()
	message, err := service.AppendMessageAndDispatch(t.Context(), input, boundaryMessageParts())
	require.NoError(t, err)
	return message.ID
}

func runBoundaryMessageWorker(t *testing.T, service *AgentService) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- service.RunMessageDispatchWorker(ctx, jobs.WorkerConfig{
			WorkerID: "boundary-worker", Capacity: 1, Lease: time.Second,
			PollInterval: 5 * time.Millisecond, RetryDelay: 5 * time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("message worker did not stop")
		}
	})
}

func requireBoundaryReceipt(t *testing.T, service *AgentService, input DispatchAgentRunInput, messageID int64, code string) {
	t.Helper()
	store, err := jobs.NewStore(service.messagePool)
	require.NoError(t, err)
	var operation jobs.Operation
	require.Eventually(t, func() bool {
		operation, err = store.GetByRequest(t.Context(), repositoryJobFlowScope(input.RepositoryID, input.UserID), agentMessageDispatchOperation, fmt.Sprintf("agent-message:%d", messageID))
		return err == nil && operation.State == jobs.StateFailed
	}, 5*time.Second, 10*time.Millisecond)
	require.JSONEq(t, fmt.Sprintf(`{"code":%q,"messageId":%d}`, code, messageID), string(operation.TerminalReceipt))
}

func TestAgentMessageDispatchBoundaryConcurrentRepeatedAdmission(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	const senders = 8
	start := make(chan struct{})
	results := make(chan error, senders)
	var wg sync.WaitGroup
	for range senders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := service.AppendMessageAndDispatch(context.Background(), input, boundaryMessageParts())
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		require.Equal(t, pkgerrors.CodeConflict, apiErr.Code)
		conflicts++
	}
	require.Equal(t, 1, successes)
	require.Equal(t, senders-1, conflicts)
	var messages, parts, requests int
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM agent_messages WHERE session_id=$1`, input.SessionID).Scan(&messages))
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM agent_parts WHERE session_id=$1`, input.SessionID).Scan(&parts))
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation=$1`, agentMessageDispatchOperation).Scan(&requests))
	require.Equal(t, 1, messages)
	require.Equal(t, 1, parts)
	require.Equal(t, 1, requests)
}

func TestAgentMessageDispatchBoundaryJobInsertFailureRollsBackMessageAndParts(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	_, err := service.messagePool.Exec(t.Context(), `CREATE FUNCTION reject_boundary_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation = 'agent-run-dispatch' THEN RAISE EXCEPTION 'boundary job insert failure'; END IF; RETURN NEW; END $$`)
	require.NoError(t, err)
	_, err = service.messagePool.Exec(t.Context(), `CREATE TRIGGER reject_boundary_dispatch BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_boundary_dispatch()`)
	require.NoError(t, err)
	_, err = service.AppendMessageAndDispatch(t.Context(), input, boundaryMessageParts())
	require.ErrorContains(t, err, "boundary job insert failure")
	var messages, parts, requests int
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM agent_messages WHERE session_id=$1`, input.SessionID).Scan(&messages))
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM agent_parts WHERE session_id=$1`, input.SessionID).Scan(&parts))
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation=$1`, agentMessageDispatchOperation).Scan(&requests))
	require.Zero(t, messages)
	require.Zero(t, parts)
	require.Zero(t, requests)
}

func TestAgentMessageDispatchBoundaryCanonicalDispatchFailureIsTerminal(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	messageID := appendBoundaryMessage(t, service, input)
	// The real owner and repository pass worker authorization. This service has
	// no dispatch querier, so canonical DispatchAgentRun fails preflight before
	// the lease records that external dispatch started.
	runBoundaryMessageWorker(t, NewAgentServiceWithPool(db.New(service.messagePool), service.messagePool))
	requireBoundaryReceipt(t, service, input, messageID, "dispatch_failed")
	var externalStarted bool
	require.NoError(t, service.messagePool.QueryRow(t.Context(), `SELECT external_started_at IS NOT NULL FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.request_id=$1`, "agent-message:"+strconv.FormatInt(messageID, 10)).Scan(&externalStarted))
	require.False(t, externalStarted)
}

func TestAgentMessageDispatchBoundaryWorkerRechecksAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, update, code string
	}{
		{"suspended actor", `UPDATE users SET prohibit_login=true WHERE id=$1`, "dispatch_permission_denied"},
		{"stale repository name", `UPDATE product_job_requests SET payload=jsonb_set(payload, '{RepoName}', to_jsonb('previous-name'::text)) WHERE tenant_id=$1 AND operation='agent-run-dispatch'`, "repository_changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, input := newBoundaryMessageSession(t)
			messageID := appendBoundaryMessage(t, service, input)
			var argument any = input.UserID
			if tc.name == "stale repository name" {
				// Repository metadata renames are fenced by the product schema.
				// A stale accepted name exercises the same worker recheck.
				argument = fmt.Sprintf("repository:%d", input.RepositoryID)
			}
			_, err := service.messagePool.Exec(t.Context(), tc.update, argument)
			require.NoError(t, err)
			runBoundaryMessageWorker(t, NewAgentServiceWithPool(db.New(service.messagePool), service.messagePool))
			requireBoundaryReceipt(t, service, input, messageID, tc.code)
		})
	}
}

func TestAgentMessageDispatchBoundaryWorkerLeavesUnrelatedJob(t *testing.T) {
	service, input := newBoundaryMessageSession(t)
	store, err := jobs.NewStore(service.messagePool)
	require.NoError(t, err)
	other, err := store.Admit(t.Context(), jobs.Admission{
		Scope:     repositoryJobFlowScope(input.RepositoryID, input.UserID),
		Operation: "unrelated-boundary-operation", RequestID: "other-request",
		Payload: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent,
	})
	require.NoError(t, err)
	messageID := appendBoundaryMessage(t, service, input)
	runBoundaryMessageWorker(t, NewAgentServiceWithPool(db.New(service.messagePool), service.messagePool))
	requireBoundaryReceipt(t, service, input, messageID, "dispatch_failed")
	operation, err := store.GetByRequest(t.Context(), repositoryJobFlowScope(input.RepositoryID, input.UserID), "unrelated-boundary-operation", other.RequestID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateAccepted, operation.State)
	claim, err := store.ClaimForOperations(t.Context(), "other-worker", time.Minute, []string{"unrelated-boundary-operation"})
	require.NoError(t, err)
	require.Equal(t, other.OperationID, claim.OperationID)
}

func TestAgentMessageDispatchBoundaryUnavailableConfiguration(t *testing.T) {
	input := DispatchAgentRunInput{SessionID: "missing"}
	for _, tc := range []struct {
		name    string
		service *AgentService
	}{
		{"nil service", nil},
		{"empty service", &AgentService{}},
		{"missing jobs", &AgentService{q: db.New(nil), appendTxManager: &pgxAgentAppendTxManager{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.service.AppendMessageAndDispatch(t.Context(), input, boundaryMessageParts())
			var apiErr *pkgerrors.APIError
			require.True(t, errors.As(err, &apiErr))
			require.Equal(t, pkgerrors.CodeServiceUnavailable, apiErr.Code)
		})
	}
	require.EqualError(t, (*AgentService)(nil).RunMessageDispatchWorker(t.Context(), jobs.WorkerConfig{}), "message dispatch store unavailable")
	require.EqualError(t, (&AgentService{}).RunMessageDispatchWorker(t.Context(), jobs.WorkerConfig{}), "message dispatch store unavailable")
}
