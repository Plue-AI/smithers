package services

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// SandboxOrphanQuerier is the DB contract for the orphan sweep. *db.Queries
// implements it.
type SandboxOrphanQuerier interface {
	ListOrphanedSandboxInstances(ctx context.Context, arg runtimeports.ListOrphanedSandboxInstancesParams) ([]runtimeports.ListOrphanedSandboxInstancesRow, error)
}

// SandboxOrphanVMClient is the minimal sandbox provider surface the sweep needs.
// The same mTLS-authenticated controller client the product uses everywhere
// else — this sweep is the codified version of the manual controller DELETE an
// operator ran by hand on 2026-08-06 to unwedge the pool.
type SandboxOrphanVMClient interface {
	DeleteSandbox(ctx context.Context, vmID string) error
}

const (
	// sandboxOrphanSweepInterval is the sweep cadence.
	sandboxOrphanSweepInterval = 5 * time.Minute
	// Product owner rows are committed before their attributed VM is allocated,
	// so a missing owner is conclusive as soon as it is visible. Keeping this at
	// zero makes repository-delete cleanup honor the five-minute sweep SLA.
	sandboxOrphanMinAge = 0
	// sandboxOrphanBatch bounds one sweep so a large historical backlog cannot
	// monopolize the controller. Anything left over is picked up next tick.
	sandboxOrphanBatch = 50
)

// SandboxOrphanReaper discards micro-VMs whose owning product row is gone.
//
// It is the backstop for a whole class of leak, not one bug: `DELETE
// /api/repos/{owner}/{repo}` hard-deletes the repository, its workspaces
// cascade away with it, and the workspace reapers iterate those very rows —
// so the VM survives, unreachable by every existing sweep, holding its worker
// reservation forever. Deliberately NOT fixed inside the repository-delete
// transaction: that flow can still roll back after tx.DeleteRepo (it restores
// the repo-host tombstone and aborts), and destroying a user's live VM inside
// a transaction that may be undone
// is not recoverable. Attribution-driven cleanup after the fact is, and it also
// catches orphans from crashes, historical rows, and causes nobody has found
// yet.
type SandboxOrphanReaper struct {
	q        SandboxOrphanQuerier
	sandbox  SandboxOrphanVMClient
	metrics  SandboxMetricsRecorder
	interval time.Duration
	minAge   time.Duration
}

// NewSandboxOrphanReaper wires the sweep. A nil querier or sandbox client makes
// Start a no-op, matching how the other sandbox-dependent workers degrade when
// Microsandbox is not configured.
func NewSandboxOrphanReaper(q SandboxOrphanQuerier, vm SandboxOrphanVMClient, metrics SandboxMetricsRecorder) *SandboxOrphanReaper {
	return &SandboxOrphanReaper{
		q: q, sandbox: vm, metrics: metrics,
		interval: sandboxOrphanSweepInterval, minAge: sandboxOrphanMinAge,
	}
}

// Start runs the sweep on a ticker until ctx is cancelled. Run it in its own
// goroutine.
func (s *SandboxOrphanReaper) Start(ctx context.Context) {
	if s == nil || s.q == nil || s.sandbox == nil {
		return
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sweep(ctx)
		}
	}
}

// Sweep reclaims one batch. Exported so the reaper can be driven directly from
// tests and from an operator one-shot without waiting a full interval.
func (s *SandboxOrphanReaper) Sweep(ctx context.Context) int {
	if s == nil || s.q == nil || s.sandbox == nil {
		return 0
	}
	rows, err := s.q.ListOrphanedSandboxInstances(ctx, runtimeports.ListOrphanedSandboxInstancesParams{
		MinAgeSeconds: int64(s.minAge / time.Second),
		MaxRows:       sandboxOrphanBatch,
	})
	if err != nil {
		slog.Warn("sandbox orphan sweep: list failed", "error", err)
		return 0
	}
	discarded := 0
	for _, row := range rows {
		vmID := strings.TrimSpace(row.ID)
		if vmID == "" {
			continue
		}
		kind := strings.TrimSpace(row.ResourceKind.String)
		// A 404 means the provider already reclaimed it; the controller still
		// releases the reservation on its side, so treat it as success.
		if err := s.sandbox.DeleteSandbox(ctx, vmID); err != nil && !vmAlreadyGone(err) {
			slog.Warn("sandbox orphan sweep: delete vm failed",
				"vm_id", vmID, "resource_kind", kind, "resource_id", row.ResourceID.String, "error", err)
			continue
		}
		slog.Info("sandbox orphan reclaimed",
			"vm_id", vmID, "resource_kind", kind, "resource_id", row.ResourceID.String,
			"observed_state", row.ObservedState, "created_at", row.CreatedAt)
		// Only a VM that had reached 'running' was ever counted in the
		// active-VM gauge, so only that case gives the -1 back.
		if s.metrics != nil && row.ObservedState == "running" {
			s.metrics.AddSandboxActiveVMs("workspace", -1)
		}
		discarded++
	}
	return discarded
}
