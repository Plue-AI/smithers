package compose

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Runtime observations refresh the existing roster, never a second run roster.
// Targets and run ids are admitted host evidence, not browser frame fields.
func (p *branchPresence) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	checkpoint := update.Checkpoint
	target := checkpoint.Target
	if p == nil || p.dispatcher == nil || p.queries == nil || checkpoint.RunID == "" {
		return nil
	}
	kind := ""
	switch target.BindingKind {
	case "agent-session", "mythical-item":
		kind = "coding"
	default:
		return nil
	}
	if strings.Contains(strings.ToLower(checkpoint.FlowID), "review") {
		kind = "reviewer"
	}
	repository, e1 := strconv.ParseInt(strings.TrimPrefix(target.TenantID, "repository:"), 10, 64)
	member, e2 := strconv.ParseInt(strings.TrimPrefix(target.PrincipalID, "user:"), 10, 64)
	if e1 != nil || e2 != nil || repository <= 0 || member <= 0 {
		return nil
	}
	sessionActive := true
	if target.BindingKind == "agent-session" {
		session, err := p.queries.GetAgentSession(ctx, target.BindingID)
		if err != nil || session.RepositoryID != repository || session.UserID != member {
			return nil
		}
		branch := services.UUIDString(session.WorkspaceID)
		if branch == "" || target.WorkspaceID != "" && target.WorkspaceID != branch {
			return nil
		}
		target.WorkspaceID = branch
		sessionActive = session.Status == "active" && !session.DeletedAt.Valid
	}
	if target.WorkspaceID == "" {
		return nil
	}
	active := sessionActive && !update.State.Terminal() && checkpoint.Run != nil && checkpoint.Run.Status == "running"
	if err := p.runHeartbeat(ctx, repository, member, target.WorkspaceID, checkpoint.RunID, kind, active); err != nil {
		// Presence is advisory; a missing bridge must not retry a completed effect.
		// The roster's source-readiness gate remains unknown on missing providers.
		slog.Warn("runtime presence unavailable", "run", checkpoint.RunID, "error", err)
	}
	return nil
}

func (p *branchPresence) runHeartbeat(ctx context.Context, repository, member int64, branch, run, kind string, active bool) error {
	if p == nil || p.dispatcher == nil || p.branches == nil || p.queries == nil {
		return errors.New("presence source unavailable")
	}
	// An ended or revoked principal can still remove its own host-bound lease.
	// Only announcements require current branch access.
	row, err := p.queries.GetWorkspace(ctx, branch)
	if err != nil {
		return err
	}
	if row.RepositoryID != repository {
		return errors.New("presence branch scope mismatch")
	}
	if active {
		row, err = p.branches.PresenceBranch(ctx, branch, repository, member)
		if err != nil {
			return err
		}
	}
	_, slug, err := installRepository(ctx, p.queries)
	if err != nil {
		return err
	}
	fields := map[string]any{"participantId": "run:" + run, "sessionId": run}
	procedure := "Branch.Leave"
	if active {
		procedure = "Branch.Announce"
		fields["displayName"] = kind
		fields["kind"] = "agent"
		fields["agentKind"] = kind
		fields["runId"] = run
		fields["for_member"] = "member:" + strconv.FormatInt(member, 10)
		fields["cursor"] = nil
		fields["where"] = map[string]any{"kind": "branch"}
	}
	_, err = p.call(ctx, row, slug, procedure, fields)
	return err
}

// The turn runner owns this lifetime. Merely opening a conversation or run
// card never announces an agent. A failed heartbeat expires after 30 seconds.
func (p *branchPresence) duringTurn(ctx context.Context, repository, member int64, branch, run string, body func() error) error {
	if p == nil || p.dispatcher == nil || branch == "" {
		return body()
	}
	beat := func(active bool) {
		heartbeatCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		if err := p.runHeartbeat(heartbeatCtx, repository, member, branch, run, "smithers", active); err != nil {
			slog.Warn("turn presence unavailable", "run", run, "error", err)
		}
	}
	beat(true)
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				beat(true)
			}
		}
	}()
	defer func() { close(done); <-stopped; beat(false) }()
	return body()
}

var _ flowdispatch.Projector = (*branchPresence)(nil)
