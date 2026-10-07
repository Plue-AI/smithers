package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// Reconcile retains the daemon's wake outcome under capture's ordered locks.
// Even a clean wake must be followed by a capture: its target is not its result.
func (p *MachineCaptureProjection) Reconcile(ctx context.Context, result wire.Reconciled, eventID, current string) error {
	if p == nil || p.tx == nil {
		return errors.New("reconciliation projection unavailable")
	}
	if err := p.ValidatePublication(); err != nil {
		return err
	}
	pending := MachineCapturePending{Stale: true}
	if len(p.workspace.CapturePending) > 0 {
		if err := json.Unmarshal(p.workspace.CapturePending, &pending); err != nil {
			return err
		}
	}
	pending.Stale = true
	pending.Onto, pending.ReconciledOnto = current, ""
	if current == result.Onto {
		pending.Onto, pending.ReconciledOnto = result.Onto, result.Onto
	}
	pending.Conflict = result.Conflict
	if result.Conflict && pending.ReconcileWaitID == "" {
		pending.ReconcileWaitID = "machine-reconcile:" + eventID
	}
	var now time.Time
	if err := p.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return err
	}
	q := db.New(p.tx)
	changed := false
	for _, item := range p.items {
		if item.WorkspaceID != p.workspace.ID || !mythicalTodo(item) {
			continue
		}
		switch item.State {
		case "landed", "cancelled", "rejected", "declined":
			continue
		}
		checks := mythicalChecksOf(item)
		checks.Capture = &pending
		checks.Land = nil
		if result.Conflict {
			exists := false
			for _, wait := range checks.Waits {
				if wait.ID == pending.ReconcileWaitID && wait.SettledAt == nil {
					exists = true
				}
			}
			if !exists {
				checks.Waits = append(checks.Waits, TodoWait{ID: pending.ReconcileWaitID, Kind: "conflict", Prompt: "Resolve conflicts", Since: now})
			}
		}
		item.CandidateVerified = false
		item.Checks = checks.encode()
		if _, err := q.SaveMythicalItem(ctx, item); err != nil {
			return err
		}
		changed = true
	}
	raw, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	if _, err = p.tx.Exec(ctx, `UPDATE workspaces SET capture_pending=$2,updated_at=NOW() WHERE id=$1`, p.workspace.ID, raw); err != nil {
		return err
	}
	if changed {
		n, err := q.RequestMythicalStack(ctx, p.workspace.RepositoryID)
		if err != nil {
			return err
		}
		if n != 1 {
			return pgx.ErrNoRows
		}
	}
	return nil
}
