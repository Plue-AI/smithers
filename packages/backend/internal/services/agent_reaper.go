package services

import (
	"bytes"
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	agentSessionReaperInterval = time.Minute
	// maxAgentTranscriptArchiveMessages is an explicit event-count guard for the
	// terminal archive path. Archiving expands message parts with one query per
	// message, so a finite bound protects the reaper even when messages are tiny.
	maxAgentTranscriptArchiveMessages = 1000
)

const (
	agentTranscriptTruncationMessageLimit = "message_limit"
	agentTranscriptTruncationByteLimit    = "byte_limit"
)

type agentTranscriptArchiveLimits struct {
	MaxMessages int `json:"max_messages"`
	MaxBytes    int `json:"max_bytes"`
}

type agentTranscriptArchive struct {
	SessionID            string                       `json:"session_id"`
	RepositoryID         int64                        `json:"repository_id"`
	Status               string                       `json:"status"`
	Messages             json.RawMessage              `json:"messages"`
	ArchivedAt           time.Time                    `json:"archived_at"`
	ArchivedMessageCount int                          `json:"archived_message_count"`
	Truncated            bool                         `json:"truncated"`
	TruncationReason     string                       `json:"truncation_reason,omitempty"`
	NextMessageSequence  *int64                       `json:"next_message_sequence,omitempty"`
	ArchiveLimits        agentTranscriptArchiveLimits `json:"archive_limits"`
}

type agentTranscriptArchiveResult struct {
	payload              []byte
	archivedMessageCount int
	truncated            bool
	truncationReason     string
	nextMessageSequence  *int64
}

var agentSessionReaperNewTicker = time.NewTicker

// StartSessionReaper periodically times out stale agent sessions based on wall-clock duration.
func (s *AgentService) StartSessionReaper(ctx context.Context, maxDuration time.Duration) {
	if s == nil || s.dispatchQ == nil || maxDuration <= 0 {
		return
	}

	// Resolve the (test-overridable) ticker constructor on the caller's
	// goroutine so the background reaper never reads the mutable package var
	// concurrently with a test swapping it.
	newTicker := agentSessionReaperNewTicker
	go func() {
		if err := s.reapExpiredSessions(ctx, maxDuration); err != nil {
			slog.Warn("agent session reaper iteration failed", "error", err)
		}

		ticker := newTicker(agentSessionReaperInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.reapExpiredSessions(ctx, maxDuration); err != nil {
					slog.Warn("agent session reaper iteration failed", "error", err)
				}
			}
		}
	}()
}

// WithAgentNeverStartedTimeout configures the separate provisioning watchdog.
func WithAgentNeverStartedTimeout(timeout time.Duration) AgentServiceOption {
	return func(s *AgentService) { s.neverStartedTimeout = timeout }
}

type neverStartedAgentQuerier interface {
	ListNeverStartedAgentSessions(context.Context, time.Time) ([]db.AgentSession, error)
	FailNeverStartedAgentSession(context.Context, db.FailNeverStartedAgentSessionParams) (db.AgentSession, error)
}

var _ neverStartedAgentQuerier = (*db.Queries)(nil)

func (s *AgentService) reapNeverStartedSessions(ctx context.Context) error {
	q, ok := s.dispatchQ.(neverStartedAgentQuerier)
	if !ok {
		return nil
	}
	timeout := s.neverStartedTimeout
	if timeout <= 0 {
		timeout = time.Hour
	}
	cutoff := pgtype.Timestamptz{Time: time.Now().UTC().Add(-timeout), Valid: true}
	rows, err := q.ListNeverStartedAgentSessions(ctx, cutoff.Time)
	if err != nil {
		return err
	}
	var failures []error
	for _, row := range rows {
		terminal, err := q.FailNeverStartedAgentSession(ctx, db.FailNeverStartedAgentSessionParams{ID: row.ID, Cutoff: cutoff.Time, WorkflowRunID: row.WorkflowRunID})
		if stdErrors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		s.notifyAgentSessionStatus(ctx, terminal)
		s.finalizeAgentSession(ctx, terminal, "failed", "never_started")
	}
	return stdErrors.Join(failures...)
}

func (s *AgentService) reapExpiredSessions(ctx context.Context, maxDuration time.Duration) error {
	if s == nil || s.dispatchQ == nil || maxDuration <= 0 {
		return nil
	}

	neverStartedErr := s.reapNeverStartedSessions(ctx)
	cutoff := time.Now().UTC().Add(-maxDuration)
	sessions, err := s.dispatchQ.ListStaleActiveSessions(ctx, pgtype.Timestamptz{Time: cutoff, Valid: true})
	if err != nil {
		return stdErrors.Join(neverStartedErr, err)
	}

	for _, session := range sessions {
		if err := s.reapExpiredSession(ctx, session); err != nil {
			workflowRunID := int64(0)
			if session.WorkflowRunID.Valid {
				workflowRunID = session.WorkflowRunID.Int64
			}
			middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, session.ID, workflowRunID).
				Error("failed to reap expired agent session", "error", err)
		}
	}

	return neverStartedErr
}

func (s *AgentService) reapExpiredSession(ctx context.Context, session db.AgentSession) error {
	if s == nil || s.dispatchQ == nil {
		return nil
	}

	timedOutSession, err := s.dispatchQ.UpdateAgentSessionTimedOut(ctx, db.UpdateAgentSessionTimedOutParams{
		ID:         session.ID,
		FinishedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	s.cancelAgentFlowRunBestEffort(ctx, timedOutSession, "timeout")
	s.observeAgentSessionTimeout()
	s.notifyAgentSessionStatus(ctx, timedOutSession)
	s.finalizeAgentSession(ctx, timedOutSession, "timed_out", "agent session timed out")
	return nil
}

func (s *AgentService) transitionAgentSessionTerminalStatus(ctx context.Context, sessionID, status string, expectedWorkflowRunID pgtype.Int8) (db.AgentSession, bool, error) {
	if s.dispatchQ == nil {
		return db.AgentSession{}, false, nil
	}

	session, err := s.dispatchQ.UpdateAgentSessionTerminalStatus(ctx, db.UpdateAgentSessionTerminalStatusParams{
		ID:                    sessionID,
		Status:                status,
		FinishedAt:            pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		ExpectedWorkflowRunID: expectedWorkflowRunID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.AgentSession{}, false, nil
		}
		return db.AgentSession{}, false, err
	}
	meterSandboxUsage(ctx, s.dispatchQ, session.UserID, "agent", sessionID, false)
	s.notifyAgentSessionStatus(ctx, session)
	return session, true, nil
}

func (s *AgentService) notifyAgentSessionStatus(ctx context.Context, session db.AgentSession) {
	if s == nil || s.q == nil {
		return
	}

	payload, _ := json.Marshal(AgentSessionEvent{
		SessionID: session.ID,
		Action:    "status",
		Status:    session.Status,
	})

	safeSessionID := strings.ReplaceAll(session.ID, "-", "")
	_ = s.q.NotifyAgentSession(ctx, db.NotifyAgentSessionParams{
		SessionID: safeSessionID,
		Payload:   string(payload),
	})
}

func (s *AgentService) finalizeAgentSession(ctx context.Context, session db.AgentSession, finalStatus, lastError string) {
	meterSandboxUsage(ctx, s.dispatchQ, session.UserID, "agent", session.ID, false)
	if session.WorkflowRunID.Valid {
		s.cancelAgentRuntimeWatchdogForRun(session.ID, session.WorkflowRunID.Int64)
	} else {
		s.cancelAgentRuntimeWatchdog(session.ID)
	}
	s.observeAgentSessionCompletion(finalStatus)
	s.updateAgentWorkflowTerminalState(ctx, session, finalStatus, lastError)
	s.archiveAgentTranscript(ctx, session, finalStatus)
	s.revokeAgentSessionToken(ctx, session.WorkflowRunID)
	s.revokeAgentSessionJJHubToken(ctx, session.UserID, session.WorkflowRunID)
	if finalStatus == "cancelled" {
		s.revokeCancelledAgentSession(ctx, session, lastError)
	}
}

// revokeCancelledAgentSession propagates a cancellation to everything still
// riding on the session's authorization: the sandbox's egress proxy is torn
// down at once (the credential values live only there), and the announcement
// ends the session's SSE streams. The VM itself is deleted by the normal
// cleanup path; between now and then it has no egress at all.
func (s *AgentService) revokeCancelledAgentSession(ctx context.Context, session db.AgentSession, reason string) {
	var sandboxIDs []string
	if s.dispatchQ != nil && session.WorkflowRunID.Valid {
		if task, err := s.dispatchQ.GetWorkflowTaskByRunID(ctx, session.WorkflowRunID.Int64); err == nil && task.VmID.Valid && strings.TrimSpace(task.VmID.String) != "" {
			sandboxIDs = []string{task.VmID.String}
			if revoker, ok := s.sandbox.(sandbox.EgressRevoker); ok && s.sandbox != nil {
				if _, err := revoker.RevokeEgress(context.WithoutCancel(ctx), task.VmID.String, sandbox.EgressRevokeRequest{Reason: "agent session cancelled"}); err != nil {
					middleware.LoggerWithAgentSession(ctx, session.ID).Warn("failed to revoke sandbox egress after cancellation", "vm_id", task.VmID.String, "error", err)
				}
			}
		}
	}
	if strings.TrimSpace(reason) == "" {
		reason = "agent session cancelled"
	}
	revocation.PublishBestEffort(context.WithoutCancel(ctx), s.revocations, revocation.Event{
		Kind:         revocation.KindAgentSessionCancelled,
		UserID:       session.UserID,
		RepositoryID: session.RepositoryID,
		SessionID:    session.ID,
		SandboxIDs:   sandboxIDs,
		Reason:       reason,
	})
}

func (s *AgentService) updateAgentWorkflowTerminalState(ctx context.Context, session db.AgentSession, finalStatus, lastError string) {
	if s == nil || s.dispatchQ == nil || !session.WorkflowRunID.Valid {
		return
	}

	workflowRunID := session.WorkflowRunID.Int64
	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, session.ID, workflowRunID)

	task, err := s.dispatchQ.GetWorkflowTaskByRunID(ctx, workflowRunID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// Admission and the session link commit before task creation. A
			// crashed dispatch can therefore leave a taskless reservation, which
			// cannot reach a terminal state through task-derived updates.
			if failErr := s.dispatchQ.FailWorkflowRun(ctx, workflowRunID); failErr != nil {
				logger.Error("failed to mark taskless agent run failed", "error", failErr)
			} else {
				NotifyWorkflowRunEvent(ctx, s.dispatchQ, workflowRunID, "agent.task_terminal")
			}
		} else {
			logger.Error("failed to load workflow task for agent terminal transition", "error", err)
		}
		return
	}

	taskStatus, stepStatus := agentTerminalWorkflowStatuses(finalStatus)
	if _, err := s.dispatchQ.MarkWorkflowTaskTerminalByID(ctx, db.MarkWorkflowTaskTerminalByIDParams{
		ID:     task.ID,
		Status: taskStatus,
		LastError: pgtype.Text{
			String: strings.TrimSpace(lastError),
			Valid:  strings.TrimSpace(lastError) != "",
		},
	}); err != nil {
		logger.Error("failed to mark microsandbox workflow task terminal", "task_id", task.ID, "error", err)
	} else {
		_, _ = s.dispatchQ.UpdateWorkflowStepStatusTerminal(ctx, db.UpdateWorkflowStepStatusTerminalParams{
			StepID: task.WorkflowStepID,
			Status: stepStatus,
		})

		run, runErr := s.dispatchQ.GetWorkflowRunByRunID(ctx, workflowRunID)
		if runErr != nil && !stdErrors.Is(runErr, pgx.ErrNoRows) {
			logger.Warn("failed to load workflow run before terminal metric update", "error", runErr)
		}
		status, statusErr := s.dispatchQ.UpdateWorkflowRunStatusBasedOnTasks(ctx, workflowRunID)
		if statusErr == nil && runErr == nil {
			ObserveWorkflowRunCompletion(s.workflowMetrics, run, status)
		}
		NotifyWorkflowRunEvent(ctx, s.dispatchQ, workflowRunID, "agent.task_terminal")
	}

	if workspaceID := UUIDString(session.WorkspaceID); workspaceID != "" && s.workspaces != nil {
		s.finishAgentWorkspace(ctx, session, workspaceID, workflowRunID, finalStatus)
		return
	}
	s.deleteAgentSandboxVM(ctx, session.ID, workflowRunID, task.VmID, task.Status == "running")
}

// agentRevisionSnapshotStamper is the optional querier surface that stamps
// a run's workspace snapshot on the revisions it produced (RFD-004).
type agentRevisionSnapshotStamper interface {
	StampAgentSessionRevisionsWorkspaceSnapshot(ctx context.Context, arg db.StampAgentSessionRevisionsWorkspaceSnapshotParams) (int64, error)
}

// finishAgentWorkspace closes a run's computer (RFD-004): a completed run's
// workspace is snapshotted and the snapshot stamped on the run's revisions;
// every terminal status then suspends the workspace and keeps the row.
func (s *AgentService) finishAgentWorkspace(ctx context.Context, session db.AgentSession, workspaceID string, workflowRunID int64, finalStatus string) {
	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, session.ID, workflowRunID)
	if finalStatus == "completed" {
		snapshotCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		snapshotID, err := s.workspaces.SnapshotAgentWorkspace(snapshotCtx, workspaceID, fmt.Sprintf("agent-run-%d", workflowRunID))
		cancel()
		if err != nil {
			logger.Warn("agent workspace snapshot failed; revisions keep no snapshot provenance", "workspace_id", workspaceID, "error", err)
		} else if stamper, ok := s.q.(agentRevisionSnapshotStamper); ok {
			if _, err := stamper.StampAgentSessionRevisionsWorkspaceSnapshot(ctx, db.StampAgentSessionRevisionsWorkspaceSnapshotParams{
				WorkspaceSnapshotID: snapshotID,
				AgentSessionID:      session.ID,
			}); err != nil {
				logger.Warn("failed to stamp workspace snapshot on agent revisions", "snapshot_id", snapshotID, "error", err)
			}
		}
	}
	if err := s.workspaces.SuspendAgentWorkspace(ctx, workspaceID); err != nil {
		logger.Error("failed to suspend agent workspace", "workspace_id", workspaceID, "error", err)
		return
	}
	logger.Info("agent workspace suspended", "workspace_id", workspaceID, "final_status", finalStatus)
}

func (s *AgentService) deleteAgentSandboxVM(ctx context.Context, sessionID string, workflowRunID int64, sandboxVMID pgtype.Text, counted bool) {
	if s == nil || s.sandbox == nil || !sandboxVMID.Valid {
		return
	}
	s.cancelAgentRuntimeWatchdogForRun(sessionID, workflowRunID)

	logger := middleware.LoggerWithAgentSessionAndWorkflowRun(ctx, sessionID, workflowRunID)
	err := s.sandbox.DeleteSandbox(ctx, sandboxVMID.String)
	if err != nil && !isSandboxNotFound(err) {
		logger.Error("failed to delete sandbox", "vm_id", sandboxVMID.String, "type", "agent", "error", err)
		return
	}

	// Failed dispatches never reached the running transition that records +1.
	// A repeated terminal cleanup also no longer owns that running transition.
	if counted && s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("agent", -1)
	}

	if err != nil {
		logger.Info("sandbox already absent during cleanup", "vm_id", sandboxVMID.String, "type", "agent")
		return
	}

	logger.Info("sandbox deleted", "vm_id", sandboxVMID.String, "type", "agent")
}

func (s *AgentService) archiveAgentTranscript(ctx context.Context, session db.AgentSession, finalStatus string) {
	if s == nil || s.logStore == nil || s.q == nil {
		return
	}

	logger := middleware.LoggerWithAgentSession(ctx, session.ID)
	archive, err := s.buildAgentTranscriptArchive(ctx, session, finalStatus)
	if err != nil {
		logger.Error("failed to build agent transcript archive", "repository_id", session.RepositoryID, "error", err)
		return
	}
	if archive.truncated {
		nextMessageSequence := int64(-1)
		if archive.nextMessageSequence != nil {
			nextMessageSequence = *archive.nextMessageSequence
		}
		logger.Warn("agent session transcript archive truncated",
			"repository_id", session.RepositoryID,
			"archived_message_count", archive.archivedMessageCount,
			"truncation_reason", archive.truncationReason,
			"next_message_sequence", nextMessageSequence,
		)
	}

	if err := s.logStore.PutSessionLog(ctx, session.RepositoryID, session.ID, archive.payload); err != nil {
		logger.Error("failed to archive agent session transcript",
			"repository_id", session.RepositoryID,
			"transcript_bytes", len(archive.payload),
			"error", err,
		)
	}
}

func (s *AgentService) buildAgentTranscriptArchive(ctx context.Context, session db.AgentSession, finalStatus string) (agentTranscriptArchiveResult, error) {
	archivedAt := time.Now().UTC()
	limits := agentTranscriptArchiveLimits{
		MaxMessages: maxAgentTranscriptArchiveMessages,
		MaxBytes:    blob.MaxAgentSessionLogBytes,
	}

	// Compute a conservative exact budget for the messages array using the
	// largest possible metadata representation. The final marshal is checked as
	// a second guard before it reaches the blob store.
	maxSequence := int64(1<<63 - 1)
	budgetProbe, err := json.Marshal(agentTranscriptArchive{
		SessionID:            session.ID,
		RepositoryID:         session.RepositoryID,
		Status:               finalStatus,
		Messages:             json.RawMessage("[]"),
		ArchivedAt:           archivedAt,
		ArchivedMessageCount: maxAgentTranscriptArchiveMessages,
		Truncated:            true,
		TruncationReason:     agentTranscriptTruncationMessageLimit,
		NextMessageSequence:  &maxSequence,
		ArchiveLimits:        limits,
	})
	if err != nil {
		return agentTranscriptArchiveResult{}, err
	}
	// budgetProbe already includes the two array brackets, so only encoded
	// element bytes and their separating commas consume the remaining budget.
	messageBytesBudget := blob.MaxAgentSessionLogBytes - len(budgetProbe)
	if messageBytesBudget < 0 {
		return agentTranscriptArchiveResult{}, stdErrors.New("agent transcript metadata exceeds archive byte limit")
	}

	rawMessages := make([]json.RawMessage, 0, min(maxAgentTranscriptArchiveMessages, maxAgentMessagesPageSize))
	messageBytes := 0
	truncated := false
	truncationReason := ""
	var nextMessageSequence *int64

collectPages:
	for page := 1; ; page++ {
		messages, listErr := s.ListMessages(ctx, session.ID, page, maxAgentMessagesPageSize)
		if listErr != nil {
			return agentTranscriptArchiveResult{}, listErr
		}
		for _, message := range messages {
			if len(rawMessages) >= maxAgentTranscriptArchiveMessages {
				sequence := message.Sequence
				nextMessageSequence = &sequence
				truncated = true
				truncationReason = agentTranscriptTruncationMessageLimit
				break collectPages
			}

			encoded, marshalErr := json.Marshal(message)
			if marshalErr != nil {
				return agentTranscriptArchiveResult{}, marshalErr
			}
			additionalBytes := len(encoded)
			if len(rawMessages) > 0 {
				additionalBytes++ // comma between adjacent array elements
			}
			if messageBytes+additionalBytes > messageBytesBudget {
				sequence := message.Sequence
				nextMessageSequence = &sequence
				truncated = true
				truncationReason = agentTranscriptTruncationByteLimit
				break collectPages
			}

			rawMessages = append(rawMessages, encoded)
			messageBytes += additionalBytes
		}
		if len(messages) < maxAgentMessagesPageSize {
			break
		}
	}

	for {
		messagesJSON := marshalAgentTranscriptMessageArray(rawMessages, messageBytes)
		record := agentTranscriptArchive{
			SessionID:            session.ID,
			RepositoryID:         session.RepositoryID,
			Status:               finalStatus,
			Messages:             messagesJSON,
			ArchivedAt:           archivedAt,
			ArchivedMessageCount: len(rawMessages),
			Truncated:            truncated,
			TruncationReason:     truncationReason,
			NextMessageSequence:  nextMessageSequence,
			ArchiveLimits:        limits,
		}
		payload, marshalErr := json.Marshal(record)
		if marshalErr != nil {
			return agentTranscriptArchiveResult{}, marshalErr
		}
		if len(payload) <= blob.MaxAgentSessionLogBytes {
			return agentTranscriptArchiveResult{
				payload:              payload,
				archivedMessageCount: len(rawMessages),
				truncated:            truncated,
				truncationReason:     truncationReason,
				nextMessageSequence:  nextMessageSequence,
			}, nil
		}
		if len(rawMessages) == 0 {
			return agentTranscriptArchiveResult{}, stdErrors.New("agent transcript metadata exceeds archive byte limit")
		}

		removed := rawMessages[len(rawMessages)-1]
		var removedMessage AgentMessageResponse
		if unmarshalErr := json.Unmarshal(removed, &removedMessage); unmarshalErr != nil {
			return agentTranscriptArchiveResult{}, unmarshalErr
		}
		rawMessages = rawMessages[:len(rawMessages)-1]
		messageBytes = agentTranscriptMessageBytes(rawMessages)
		sequence := removedMessage.Sequence
		nextMessageSequence = &sequence
		truncated = true
		truncationReason = agentTranscriptTruncationByteLimit
	}
}

func marshalAgentTranscriptMessageArray(messages []json.RawMessage, messageBytes int) json.RawMessage {
	var buffer bytes.Buffer
	buffer.Grow(messageBytes + len("[]"))
	buffer.WriteByte('[')
	for i, message := range messages {
		if i > 0 {
			buffer.WriteByte(',')
		}
		buffer.Write(message)
	}
	buffer.WriteByte(']')
	return json.RawMessage(buffer.Bytes())
}

func agentTranscriptMessageBytes(messages []json.RawMessage) int {
	total := 0
	for i, message := range messages {
		total += len(message)
		if i > 0 {
			total++
		}
	}
	return total
}

func (s *AgentService) revokeAgentSessionToken(ctx context.Context, workflowRunID pgtype.Int8) {
	if s == nil || s.dispatchQ == nil || !workflowRunID.Valid {
		return
	}

	_, _ = s.dispatchQ.UpdateWorkflowRunAgentToken(ctx, db.UpdateWorkflowRunAgentTokenParams{
		AgentTokenHash: pgtype.Text{Valid: false},
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Time:  time.Now().UTC().Add(-1 * time.Hour),
			Valid: true,
		},
		ID: workflowRunID.Int64,
	})
}

// revokeAgentSessionJJHubToken deletes the per-run scoped jjhub API token (if one
// was minted for the run) and clears its id from the run. DeleteAccessToken is
// scoped by (id, user_id), so userID must be the run's owning user (the session
// owner). It is a no-op when no token was persisted.
func (s *AgentService) revokeAgentSessionJJHubToken(ctx context.Context, userID int64, workflowRunID pgtype.Int8) {
	if s == nil || s.dispatchQ == nil || !workflowRunID.Valid {
		return
	}

	tokenID, err := s.dispatchQ.GetWorkflowRunJJHubTokenID(ctx, workflowRunID.Int64)
	if err != nil || !tokenID.Valid || tokenID.Int64 <= 0 {
		return
	}

	revokeTemporaryRepoCloneToken(ctx, s.dispatchQ, userID, tokenID.Int64)
	_ = s.dispatchQ.ClearWorkflowRunJJHubTokenID(ctx, workflowRunID.Int64)
}

func (s *AgentService) observeAgentSessionCompletion(status string) {
	if s == nil || s.sessionMetrics == nil {
		return
	}
	s.sessionMetrics.ObserveAgentSessionCompletion(status)
}

func (s *AgentService) observeAgentSessionTimeout() {
	if s == nil || s.sessionMetrics == nil {
		return
	}
	s.sessionMetrics.ObserveAgentSessionTimeout()
}

func isSandboxNotFound(err error) bool {
	var statusErr *sandbox.StatusError
	return stdErrors.As(err, &statusErr) && statusErr.StatusCode == 404
}
