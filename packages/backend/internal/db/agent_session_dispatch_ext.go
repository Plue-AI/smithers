package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ClaimAgentSessionForDispatch atomically re-points an agent session at a new
// workflow run — but only when the session has no live (queued/running) run.
//
// This is the serialized replacement for the old check-then-act pair
// (GetAgentSessionWorkflowRunID + unconditional UpdateAgentSessionWorkflowRun):
// two concurrent dispatches for one session could both pass the unlocked check,
// both provision a VM, and race on the final re-point, 401-locking the losing
// run's session-event callbacks. The FOR UPDATE row lock serializes claimers;
// the loser re-reads the winner's freshly committed run (a new statement under
// READ COMMITTED sees it) and backs off.
//
// A successful claim also resets the session to a dispatchable state
// (status='active', started_at/finished_at cleared) so that a re-dispatched
// terminal session can transition terminal again when its new run finishes —
// otherwise the 'done' finalize path is skipped for every run after the first
// (UpdateAgentSessionTerminalStatus only matches status='active' rows), leaking
// the VM gauge and the run's scoped tokens.
//
// Returns false when the session is missing/tombstoned or another run is live.
func (q *Queries) ClaimAgentSessionForDispatch(ctx context.Context, sessionID string, workflowRunID int64) (bool, error) {
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return false, fmt.Errorf("claim agent session for dispatch: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var currentRunID *int64
	err = tx.QueryRow(ctx, `
SELECT workflow_run_id FROM agent_sessions
WHERE id = $1 AND deleted_at IS NULL
FOR UPDATE
`, sessionID).Scan(&currentRunID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}

	if currentRunID != nil {
		var status string
		err = tx.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id = $1`, *currentRunID).Scan(&status)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		if err == nil && (status == "queued" || status == "running") {
			return false, nil
		}
	}

	if _, err := tx.Exec(ctx, `
UPDATE agent_sessions
SET workflow_run_id = $2,
    status = 'active',
    started_at = NULL,
    finished_at = NULL,
    updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL
`, sessionID, workflowRunID); err != nil {
		return false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ReserveAgentSessionVMSlot atomically checks the fleet-wide active-agent-VM
// count against the cap and, if below it, stamps the session's started_at so
// the session is counted immediately — BEFORE the slow Microsandbox CreateSandbox call.
//
// The count + stamp are serialized across the whole fleet with a transaction-
// scoped advisory lock: concurrent reservers queue on the lock, and each
// subsequent COUNT (a new statement under READ COMMITTED) sees every previously
// committed reservation, so a burst of simultaneous dispatches cannot overshoot
// the cap the way the old standalone count (which ignored provisioning VMs)
// could.
//
// The count predicate must stay in lockstep with CountActiveAgentSessionVMs and
// the reaper's ListStaleActiveSessions. A reserved slot is released when the
// session leaves status='active' (terminal transition, infra-failure cleanup,
// or the session reaper).
//
// Returns false when the fleet is at capacity; an error when the session is not
// in a reservable state (missing, tombstoned, or not active).
func (q *Queries) ReserveAgentSessionVMSlot(ctx context.Context, sessionID string, maxActive int) (bool, error) {
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return false, fmt.Errorf("reserve agent session vm slot: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('agent_session_vm_fleet_cap'))`); err != nil {
		return false, err
	}

	var count int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)
FROM agent_sessions
WHERE status = 'active'
  AND started_at IS NOT NULL
  AND deleted_at IS NULL
`).Scan(&count); err != nil {
		return false, err
	}
	if count >= maxActive {
		return false, nil
	}

	tag, err := tx.Exec(ctx, `
UPDATE agent_sessions
SET started_at = NOW(), updated_at = NOW()
WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
`, sessionID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, fmt.Errorf("agent session %s is not active", sessionID)
	}

	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// FailNeverStartedAgentSession preserves the session result while the generated
// statement atomically fails an abandoned run and its unfinished work.
func (q *Queries) FailNeverStartedAgentSession(ctx context.Context, arg FailNeverStartedAgentSessionParams) (AgentSession, error) {
	row, err := q.FailNeverStartedAgentSessionRaw(ctx, arg)
	return AgentSession(row), err
}

type FailNeverStartedAgentSessionParams = FailNeverStartedAgentSessionRawParams
