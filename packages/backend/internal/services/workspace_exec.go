package services

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CreateSession creates a new workspace session and ensures its configured
// workspace runtime is running.
func (s *WorkspaceService) CreateSession(ctx context.Context, input CreateWorkspaceSessionInput) (WorkspaceSessionResponse, error) {
	if s.q == nil {
		return WorkspaceSessionResponse{}, pkgerrors.Internal("workspace store unavailable")
	}
	if s.runtime == nil && s.sandbox == nil {
		return WorkspaceSessionResponse{}, pkgerrors.Internal("workspace runtime unavailable")
	}

	cols := input.Cols
	if cols <= 0 {
		cols = 80
	}
	rows := input.Rows
	if rows <= 0 {
		rows = 24
	}

	kind, err := normalizeWorkspaceSessionKind(input.Kind)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	language, err := normalizeWorkspaceSessionLanguage(kind, input.Language)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}
	input.Kind = kind
	input.Language = language

	var workspace db.Workspace

	if strings.TrimSpace(input.WorkspaceID) != "" {
		workspace, err = s.loadOwnedWorkspace(ctx, strings.TrimSpace(input.WorkspaceID), input.RepositoryID, input.UserID)
		if err != nil {
			return WorkspaceSessionResponse{}, err
		}
	} else {
		bookmark, _, resolveErr := s.resolveWorkspaceBookmark(ctx, input.RepositoryID, input.SourceBookmark)
		if resolveErr != nil {
			return WorkspaceSessionResponse{}, resolveErr
		}
		workspace, err = s.findOrCreatePrimaryWorkspace(ctx, input.RepositoryID, input.UserID, "", bookmark, workspaceCreateMetadata{})
		if err != nil {
			return WorkspaceSessionResponse{}, err
		}
	}
	// A pending workspace may be provisioned by this session. Always clone the
	// bookmark recorded on the workspace row, including a custom repository
	// default resolved above, rather than falling back to Git's remote HEAD.
	input.SourceBookmark = targetWorkspaceBookmark(workspace.TargetBookmark)

	if kind == WorkspaceSessionKindLSP {
		// One language server per workspace and language: a second create
		// answers the live session (pending, starting, or running) instead of
		// booting a sibling; the client polls or attaches exactly as it would
		// have for the first one.
		existing, err := s.q.GetActiveWorkspaceLSPSession(ctx, db.GetActiveWorkspaceLSPSessionParams{
			WorkspaceID: workspace.ID,
			Language:    language,
		})
		if err == nil {
			_ = s.q.TouchWorkspaceSessionActivity(ctx, existing.ID)
			return toWorkspaceSessionResponse(existing), nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceSessionResponse{}, pkgerrors.Internal("load workspace lsp session: " + err.Error())
		}
	}

	session, err := s.insertWorkspaceSession(ctx, workspace.ID, input, cols, rows)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}

	// Provision the Microsandbox VM on a context detached from the HTTP request.
	// In prod a proxy/client hop cancels the request context at ~125s, which
	// would abort CreateSandbox mid-boot and orphan a running VM plue never
	// registers. Detaching (with a hard provisioning timeout) lets provisioning
	// finish even when the client has already disconnected.
	provisionCtx, cancelProvision := context.WithTimeout(context.WithoutCancel(ctx), workspaceProvisionTimeout)

	type provisionOutcome struct {
		session WorkspaceSessionResponse
		err     error
	}
	done := make(chan provisionOutcome, 1)
	provisionStartedAt := time.Now()
	provisionDone := s.trackProvision()
	go func() {
		defer provisionDone()
		defer cancelProvision()
		recorded := false
		recordProvision := func(status string) {
			if recorded {
				return
			}
			recorded = true
			s.observeWorkspaceSessionProvision(status, time.Since(provisionStartedAt))
		}
		// A panic here would otherwise crash the whole API process (chi's
		// Recoverer does not cover goroutines) AND leave the caller blocked on
		// `done`. Recover, log, and push a failure outcome so the caller unblocks.
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in workspace session provisioning", "session_id", session.ID, "workspace_id", workspace.ID, "panic", r)
				s.failWorkspaceSession(provisionCtx, session.ID)
				recordProvision("failed")
				done <- provisionOutcome{err: pkgerrors.Internal("workspace session provisioning failed")}
			}
		}()
		resp, provisionErr := s.finishWorkspaceSessionProvisioning(provisionCtx, session, workspace, input, cols, rows)
		if provisionErr != nil {
			slog.Error("workspace session provisioning failed", "session_id", session.ID, "workspace_id", workspace.ID, "error", provisionErr)
			recordProvision("failed")
		} else {
			recordProvision("success")
		}
		done <- provisionOutcome{session: resp, err: provisionErr}
	}()

	// Fast paths (VM already running, immediate failures) resolve within the
	// grace window so callers still get the running/failed result. A fresh VM
	// boot exceeds it: return the pending session ticket promptly instead of
	// holding the request past the proxy deadline (the prod ~2m05s hang → 504).
	// The multi client polls GetSession / the SSE stream and reconnects once
	// background provisioning marks the session running or failed.
	select {
	case outcome := <-done:
		return outcome.session, outcome.err
	case <-time.After(s.sessionProvisionGrace):
		s.observeWorkspaceSessionProvision("deferred", time.Since(provisionStartedAt))
		slog.Info("workspace session provisioning continues in background", "session_id", session.ID, "workspace_id", workspace.ID)
		return toWorkspaceSessionResponse(session), nil
	}
}

func (s *WorkspaceService) observeWorkspaceSessionProvision(status string, duration time.Duration) {
	if s == nil || s.sandboxMetrics == nil {
		return
	}
	recorder, ok := s.sandboxMetrics.(WorkspaceSessionMetricsRecorder)
	if !ok {
		return
	}
	recorder.ObserveWorkspaceSessionProvision(status, duration.Seconds())
}

// finishWorkspaceSessionProvisioning drives workspace provisioning for a
// freshly created session and settles the session row (running/failed). It
// runs on a context detached from the originating HTTP request, so it must not
// touch request-scoped state.
func (s *WorkspaceService) finishWorkspaceSessionProvisioning(ctx context.Context, session db.WorkspaceSession, workspace db.Workspace, input CreateWorkspaceSessionInput, cols, rows int32) (response WorkspaceSessionResponse, retErr error) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("panic in workspace session provisioning", "session_id", session.ID, "panic", r)
			retErr = pkgerrors.Internal("workspace session provisioning failed")
		}
		if retErr != nil {
			s.failWorkspaceSession(ctx, session.ID)
		}
	}()

	workspace, err := s.ensureWorkspaceRunning(ctx, workspace, input)
	if errors.Is(err, errWorkspaceProvisionInProgress) {
		// The owner (or the provisioning reconciler) completes the session.
		return toWorkspaceSessionResponse(session), nil
	}
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}

	if workspace.ID != session.WorkspaceID {
		replacement, createErr := s.insertWorkspaceSession(ctx, workspace.ID, input, cols, rows)
		if createErr != nil {
			return WorkspaceSessionResponse{}, createErr
		}
		s.failWorkspaceSession(ctx, session.ID)
		session = replacement
	}

	// CAS pending/starting -> running. This goroutine is detached from the HTTP
	// request, so the user may have destroyed the session while the VM was still
	// provisioning; an unconditional update here resurrected that stopped
	// session as running. On a lost CAS the terminal status stands, and the
	// workspace (which we just brought up) is re-suspended when no other session
	// needs it.
	running, err := s.q.MarkWorkspaceSessionRunning(ctx, session.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			slog.Info("workspace session reached terminal state during provisioning; not resurrecting",
				"session_id", session.ID, "workspace_id", workspace.ID)
			if suspendErr := s.suspendWorkspaceIfSessionless(ctx, workspace); suspendErr != nil {
				slog.Warn("failed to suspend workspace after stale session provisioning", "workspace_id", workspace.ID, "error", suspendErr)
			}
			current, loadErr := s.q.GetWorkspaceSession(ctx, session.ID)
			if loadErr != nil {
				return WorkspaceSessionResponse{}, pkgerrors.Internal("load workspace session: " + loadErr.Error())
			}
			return toWorkspaceSessionResponse(current), nil
		}
		return WorkspaceSessionResponse{}, pkgerrors.Internal("mark workspace session running: " + err.Error())
	}
	session = running
	_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
	_ = s.q.TouchWorkspaceSessionActivity(ctx, session.ID)
	s.touchWorkspaceEntryRecency(ctx, workspace.ID, "create_session")
	s.notifyWorkspaceSession(ctx, session.ID, "running")

	return toWorkspaceSessionResponse(session), nil
}

// failWorkspaceSession best-effort marks a session failed and notifies stream
// listeners. The transition is CAS-guarded to non-terminal states so a session
// the user already stopped is not relabeled (or re-notified) as failed by a
// stale provisioning goroutine.
func (s *WorkspaceService) failWorkspaceSession(ctx context.Context, sessionID string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, err := s.q.FailActiveWorkspaceSession(ctx, sessionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return
		}
		slog.Warn("failed to mark workspace session failed", "session_id", sessionID, "error", err)
		return
	}
	s.notifyWorkspaceSession(ctx, sessionID, "failed")
}

// GetSession returns a single workspace session by ID. Viewing session status
// is a read-level operation, so a read share (e.g. a pair viewer) is
// sufficient; mutating and credential paths stay write-level.
func (s *WorkspaceService) GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (WorkspaceSessionResponse, error) {
	if s.q == nil {
		return WorkspaceSessionResponse{}, pkgerrors.Internal("workspace store unavailable")
	}

	session, err := s.loadWorkspaceSessionWithAccess(ctx, sessionID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return WorkspaceSessionResponse{}, err
	}

	return toWorkspaceSessionResponse(session), nil
}

// ListSessions returns paginated workspace sessions for a repository.
func (s *WorkspaceService) ListSessions(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]WorkspaceSessionResponse, int64, error) {
	if s.q == nil {
		return nil, 0, pkgerrors.Internal("workspace store unavailable")
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 30
	}
	offset := (page - 1) * perPage

	rows, err := s.q.ListWorkspaceSessionsByRepo(ctx, db.ListWorkspaceSessionsByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
		PageOffset:   ClampInt32(offset),
		PageSize:     int32(perPage),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("list workspace sessions: " + err.Error())
	}

	total, err := s.q.CountWorkspaceSessionsByRepo(ctx, db.CountWorkspaceSessionsByRepoParams{
		RepositoryID: repositoryID,
		UserID:       userID,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("count workspace sessions: " + err.Error())
	}

	result := make([]WorkspaceSessionResponse, 0, len(rows))
	for _, row := range rows {
		result = append(result, toWorkspaceSessionResponse(row))
	}
	return result, total, nil
}

// DestroySession marks a session as stopped and suspends the VM when it is the last active session.
func (s *WorkspaceService) DestroySession(ctx context.Context, sessionID string, repositoryID, userID int64) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}

	session, err := s.loadOwnedWorkspaceSession(ctx, sessionID, repositoryID, userID)
	if err != nil {
		return err
	}

	if session.Status != "stopped" && session.Status != "failed" {
		if _, err := s.q.UpdateWorkspaceSessionStatus(ctx, db.UpdateWorkspaceSessionStatusParams{
			ID:     sessionID,
			Status: "stopped",
		}); err != nil {
			return pkgerrors.Internal("update workspace session status: " + err.Error())
		}
	}

	s.notifyWorkspaceSession(ctx, sessionID, "stopped")
	s.revokeWorkspaceTerminalCredential(ctx, session, userID)

	// The session stop is durable above. VM suspension can take longer than
	// the HTTP proxy deadline and must not turn that successful stop into 504.
	// The idle sweeper can retry if this pod exits before the workspace-status
	// CAS. A failure after that CAS still needs provider-state reconciliation;
	// a suspended DB row is outside the running-only idle sweep.
	cleanup := func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		workspace, getErr := s.loadOwnedWorkspace(cleanupCtx, session.WorkspaceID, session.RepositoryID, userID)
		if getErr == nil {
			if suspendErr := s.suspendWorkspaceIfSessionless(cleanupCtx, workspace); suspendErr != nil {
				slog.Error("failed to suspend workspace after last session stopped", "workspace_id", workspace.ID, "error", suspendErr)
			}
		}
	}
	launch := s.launchSessionCleanup
	if launch == nil {
		launch = SafeGo
	}
	launch("workspace-session-cleanup", cleanup)

	return nil
}

func (s *WorkspaceService) notifyWorkspaceSession(ctx context.Context, sessionID, status string) {
	if s.q == nil || strings.TrimSpace(sessionID) == "" {
		return
	}
	safeID := strings.ReplaceAll(sessionID, "-", "")
	payload, _ := json.Marshal(map[string]string{"status": status})
	_ = s.q.NotifyWorkspaceStatus(ctx, db.NotifyWorkspaceStatusParams{
		SessionID: safeID,
		Payload:   string(payload),
	})
}

func (s *WorkspaceService) notifyWorkspace(ctx context.Context, workspaceID, status string, failures ...workspaceFailureDetails) {
	s.publishWorkspaceStatus(ctx, workspaceID, status, failures...)
	// Every status change funnels here, so a parent that leaves running
	// takes its child workspaces with it (#2802).
	s.cascadeWorkspaceChildren(ctx, workspaceID, status)
}

// publishWorkspaceStatus tells status subscribers about one change.
func (s *WorkspaceService) publishWorkspaceStatus(ctx context.Context, workspaceID, status string, failures ...workspaceFailureDetails) {
	if s.q == nil || strings.TrimSpace(workspaceID) == "" {
		return
	}
	safeID := strings.ReplaceAll(workspaceID, "-", "")
	event := map[string]string{"status": status}
	if status == "failed" {
		failure := workspaceFailureDetailsFor(nil)
		if len(failures) > 0 {
			failure = failures[0]
		}
		event["failure_code"] = string(failure.Code)
		event["failure_message"] = failure.Message
	}
	payload, _ := json.Marshal(event)
	_ = s.q.NotifyWorkspaceStatus(ctx, db.NotifyWorkspaceStatusParams{
		SessionID: safeID,
		Payload:   string(payload),
	})
}

// insertWorkspaceSession writes the session row for input's kind. Both
// queries lock and recheck the live parent workspace: a concurrent tombstone
// turns the insert into no rows (404) instead of an orphan active session. An
// LSP insert that loses the one-per-workspace-and-language race answers the
// winner, exactly like a second create would.
func (s *WorkspaceService) insertWorkspaceSession(ctx context.Context, workspaceID string, input CreateWorkspaceSessionInput, cols, rows int32) (db.WorkspaceSession, error) {
	var (
		session db.WorkspaceSession
		err     error
	)
	if input.Kind == WorkspaceSessionKindLSP {
		session, err = s.q.CreateWorkspaceLSPSession(ctx, db.CreateWorkspaceLSPSessionParams{
			WorkspaceID:     workspaceID,
			RepositoryID:    input.RepositoryID,
			UserID:          input.UserID,
			Cols:            cols,
			Rows:            rows,
			Language:        input.Language,
			IdleTimeoutSecs: workspaceLSPIdleTimeoutSecs,
		})
		if err != nil && isUniqueViolation(err) {
			existing, loadErr := s.q.GetActiveWorkspaceLSPSession(ctx, db.GetActiveWorkspaceLSPSessionParams{
				WorkspaceID: workspaceID,
				Language:    input.Language,
			})
			if loadErr == nil {
				return existing, nil
			}
		}
	} else {
		session, err = s.q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{
			WorkspaceID:  workspaceID,
			RepositoryID: input.RepositoryID,
			UserID:       input.UserID,
			Cols:         cols,
			Rows:         rows,
		})
	}
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.WorkspaceSession{}, pkgerrors.NotFound("workspace not found")
		}
		return db.WorkspaceSession{}, pkgerrors.Internal("create workspace session: " + err.Error())
	}
	return session, nil
}
