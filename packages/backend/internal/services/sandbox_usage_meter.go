package services

import (
	"context"
	"log/slog"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Optional extension, like workspaceVMRegistrar: production *db.Queries always
// implements it; older stores/test doubles can keep their lifecycle interface.
type sandboxUsageQuerier interface {
	OpenSandboxUsageInterval(context.Context, db.OpenSandboxUsageIntervalParams) error
	CloseSandboxUsageInterval(context.Context, db.CloseSandboxUsageIntervalParams) error
	CloseOrphanedSandboxUsageIntervals(context.Context) error
}

var _ sandboxUsageQuerier = (*db.Queries)(nil)

// Meter writes survive caller cancellation but are bounded and never fail the
// lifecycle. The periodic orphan sweep repairs missed terminal stamps.
func meterSandboxUsage(ctx context.Context, store any, userID int64, kind, id string, awake bool) {
	q, ok := store.(sandboxUsageQuerier)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	var err error
	if awake {
		err = q.OpenSandboxUsageInterval(ctx, db.OpenSandboxUsageIntervalParams{UserID: userID, SandboxKind: kind, SandboxID: id})
	} else {
		err = q.CloseSandboxUsageInterval(ctx, db.CloseSandboxUsageIntervalParams{SandboxKind: kind, SandboxID: id})
	}
	if err != nil {
		slog.Warn("sandbox usage stamp failed", "sandbox_kind", kind, "sandbox_id", id, "awake", awake, "error", err)
	}
}

func (s *WorkspaceService) meterWorkspaceUsage(ctx context.Context, workspace db.Workspace, status string) {
	switch status {
	case "running":
		// A workspace-backed agent uses this same VM. End its reservation
		// interval as the workspace takes over metering the running guest.
		if workspace.AgentSessionID.Valid {
			meterSandboxUsage(ctx, s.q, workspace.UserID, "agent", uuidString(workspace.AgentSessionID), false)
		}
		meterSandboxUsage(ctx, s.q, workspace.UserID, "workspace", workspace.ID, true)
	case "suspended", "stopped", "failed":
		meterSandboxUsage(ctx, s.q, workspace.UserID, "workspace", workspace.ID, false)
	}
}

func (s *WorkspaceService) meterWorkspaceStatusUsage(ctx context.Context, id, status string) {
	workspace, err := s.q.GetWorkspace(ctx, id)
	if err != nil {
		slog.Warn("sandbox usage owner lookup failed", "workspace_id", id, "error", err)
		return
	}
	s.meterWorkspaceUsage(ctx, workspace, status)
}

func (s *WorkspaceService) sweepSandboxUsage(ctx context.Context) {
	if q, ok := s.q.(sandboxUsageQuerier); ok {
		if err := q.CloseOrphanedSandboxUsageIntervals(ctx); err != nil {
			slog.Warn("sandbox usage orphan sweep failed", "error", err)
		}
	}
}

func (d *agentDispatch) meterReservedAgentUsage(err error) {
	if err == nil {
		meterSandboxUsage(d.ctx, d.svc.dispatchQ, d.input.UserID, "agent", d.input.SessionID, true)
	}
}
