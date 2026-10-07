package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// workspaceMachineQueue is the workspace runtime's admission queue
// (microsandbox.Runtime): the one line in which workspaces wait for a
// machine on a full host, in order, with its reason and each one's place.
type workspaceMachineQueue interface {
	Request(class, holder, actor, reason string) (microsandbox.AdmissionRequest, error)
	CancelAdmission(holder, actor string, now time.Time) bool
	AdmissionSnapshot() []microsandbox.AdmissionRequest
}

const (
	// workspaceMachineReason is the admission queue's reason for a workspace
	// that waits for a machine: "Waiting for a machine · #2" (spec §4.2).
	workspaceMachineReason = "machine"
	// workspaceWaitingForMachine is the provisioning stage of a workspace in
	// that line.
	workspaceWaitingForMachine = "waiting_for_machine"
)

// workspaceMachineWaitEvery paces a waiting workspace's look at the line.
var workspaceMachineWaitEvery = 2 * time.Second

// errWorkspaceMachineWaitEnded reports a wait that ended without a machine
// and without a failure: the workspace was stopped or deleted while it
// waited, or the wait ran out of time and the row stays pending for the
// provisioning reconciler. Nothing marks it failed.
var errWorkspaceMachineWaitEnded = errors.New("the workspace left the line for a machine")

// isMachineCapacityError reports the runtime's typed refusal of a machine on
// a full host (microVM capacity reached). It is transient: nothing was
// created, and a slot frees when another machine stops.
func isMachineCapacityError(err error) bool {
	var capacity *microsandbox.CapacityError
	return errors.As(err, &capacity) && capacity.Code == "machine_capacity"
}

func machineQueueHolder(workspaceID string) string { return "workspace:" + workspaceID }

type personMachineDemandKey struct{}
type sessionMachineDemandKey struct{}

func sessionMachineActor(userID int64, sessionID string) string {
	return fmt.Sprintf("person:%d:session:%s", userID, sessionID)
}

func (s *WorkspaceService) validateMachineSession(ctx context.Context, row db.Workspace, actor int64, sessionID string) error {
	session, err := s.q.GetWorkspaceSession(ctx, sessionID)
	if err != nil {
		return err
	}
	if session.WorkspaceID != row.ID || session.RepositoryID != row.RepositoryID || session.UserID != actor || (session.Status != "pending" && session.Status != "starting" && session.Status != "running") {
		return context.Canceled
	}
	return nil
}

// A person's wake is classified by its entry point, never by whether that
// person happens to own the branch's workspace row.
func personMachineDemand(ctx context.Context) context.Context {
	return context.WithValue(ctx, personMachineDemandKey{}, true)
}

func machineDemand(ctx context.Context, row db.Workspace, requesterID int64) (string, string) {
	person, _ := ctx.Value(personMachineDemandKey{}).(bool)
	// Stack creation keeps the person's identity for authorization, while the
	// branch machine belongs to the shared owner. Preserve its reserved class.
	if source, _ := ctx.Value(todoMachineDemandKey{}).(string); source != "" && !person {
		return "todo", machineQueueHolder(row.ID)
	}
	if person || requesterID != row.UserID {
		if sessionID, _ := ctx.Value(sessionMachineDemandKey{}).(string); sessionID != "" {
			return "person", sessionMachineActor(requesterID, sessionID)
		}
		return "person", fmt.Sprintf("person:%d", requesterID)
	}
	return "todo", machineQueueHolder(row.ID)
}

// waitForMachine keeps a workspace the full host refused in the runtime's
// admission queue instead of failing it (T-MCH-06): its row stays pending at
// the stage waiting_for_machine, and it tries again only at the head of the
// line, so machines go out in order; try is the provisioning it repeats. It
// answers nil once the workspace runs, errWorkspaceMachineWaitEnded when it
// leaves the line unprovisioned, and any other error the provisioning
// answered. A workspace with a machine already, or a runtime with no queue,
// answers cause unchanged.
func (s *WorkspaceService) waitForMachine(ctx context.Context, workspace db.Workspace, cause error, try func(context.Context, db.Workspace) error) error {
	queue, ok := s.runtime.(workspaceMachineQueue)
	if !ok || strings.TrimSpace(workspace.VmID) != "" {
		return cause
	}
	holder := machineQueueHolder(workspace.ID)
	if _, err := queue.Request("todo", holder, holder, workspaceMachineReason); err != nil {
		return cause
	}
	// The line is left whatever ends the wait; a machine started without a
	// grant holds no reservation.
	defer func() { queue.CancelAdmission(holder, holder, time.Now()) }()
	s.setWorkspaceProvisioningStageBestEffort(ctx, workspace.ID, workspaceWaitingForMachine)
	ticker := time.NewTicker(workspaceMachineWaitEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return errWorkspaceMachineWaitEnded
		case <-ticker.C:
		}
		current, err := s.q.GetWorkspace(ctx, workspace.ID)
		if err != nil || current.DeletedAt.Valid || current.Status != "pending" && current.Status != "starting" {
			return errWorkspaceMachineWaitEnded
		}
		if place, _ := machineQueuePlace(queue, holder); place > 1 {
			continue
		}
		if err = try(ctx, current); err == nil {
			s.setWorkspaceProvisioningStageBestEffort(ctx, workspace.ID, "")
			return nil
		}
		if !isNoCapacityError(err) {
			return err
		}
	}
}

// machineQueuePlace is holder's 1-based place in the line for a machine.
func machineQueuePlace(queue workspaceMachineQueue, holder string) (int, bool) {
	for _, row := range queue.AdmissionSnapshot() {
		if row.Holder == holder && row.State == "waiting" {
			return row.Position, true
		}
	}
	return 0, false
}

// MachinePlace is a waiting workspace's place in the line for a machine
// ("Waiting for a machine · #2"); false when it is not waiting.
func (s *WorkspaceService) MachinePlace(workspace db.Workspace) (int, bool) {
	if s == nil {
		return 0, false
	}
	queue, ok := s.runtime.(workspaceMachineQueue)
	if !ok {
		return 0, false
	}
	place, waiting := machineQueuePlace(queue, machineQueueHolder(workspace.ID))
	return place, waiting && place > 0
}

// MachinePlace is a lane's place in the line for a machine.
func (l *workspaceMythicalLanes) MachinePlace(workspace db.Workspace) (int, bool) {
	if l == nil || l.workspaces == nil {
		return 0, false
	}
	return l.workspaces.MachinePlace(workspace)
}

// machinePlace is a TODO's lane's place in the line for a machine on a full
// host, read from the lanes that provision it.
func (s *MythicalService) machinePlace(workspace db.Workspace) (int, bool) {
	lanes, ok := s.lanes.(interface {
		MachinePlace(db.Workspace) (int, bool)
	})
	if !ok {
		return 0, false
	}
	return lanes.MachinePlace(workspace)
}

// EnableMachineAdmission composes the existing branch authority with the runtime
// queue. Unknown bindings and missing runtime/host providers refuse before boot.
func (s *WorkspaceService) EnableMachineAdmission(freeDisk func(context.Context) (int64, error)) {
	s.machineAdmission = &microsandbox.AdmissionProviders{
		FreeDisk: freeDisk,
		Ready: func(ctx context.Context, request microsandbox.AdmissionRequest) error {
			if err := s.requireBranchMachineProviders(); err != nil {
				return err
			}
			if strings.HasPrefix(request.Holder, "todo:") {
				// Stack demand has no executable branch binding until handoff.
				return microsandbox.ErrAdmissionNotReady
			}
			id := strings.TrimPrefix(request.Holder, "workspace:")
			row, err := s.q.GetWorkspace(ctx, id)
			if err != nil {
				return err
			}
			if row.DeletedAt.Valid {
				return errWorkspaceMachineWaitEnded
			}
			p := s.branchMachineProviders
			if err := p.MicroVM(ctx); err != nil {
				return err
			}
			if err := p.SessionIdentity(ctx); err != nil {
				return err
			}
			tx, err := s.transactions.Begin(ctx)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
			if request.Class == "person" {
				parts := strings.SplitN(strings.TrimPrefix(request.Actor, "person:"), ":session:", 2)
				actor, err := strconv.ParseInt(parts[0], 10, 64)
				if err != nil {
					return err
				}
				if err := p.Membership(ctx, tx, row.RepositoryID, actor); err != nil {
					return err
				}
				if len(parts) == 2 {
					if err := s.validateMachineSession(ctx, row, actor, parts[1]); err != nil {
						return err
					}
				}
			}
			if err := p.LaneBinding(ctx, tx, row.RepositoryID, row.TargetBookmark, row.ID); err != nil {
				return fmt.Errorf("%w: %v", microsandbox.ErrAdmissionNotReady, err)
			}
			return nil
		},
	}
}

func (s *WorkspaceService) admitWorkspaceOperation(ctx context.Context, row db.Workspace, requesterID int64) (context.Context, error) {
	if s.machineAdmission == nil {
		return ctx, nil
	}
	runtime, ok := s.runtime.(interface {
		WaitAdmission(context.Context, microsandbox.AdmissionProviders, string, string, string, string) (context.Context, error)
	})
	if !ok {
		return ctx, errors.New("machine admission runtime unavailable")
	}
	class, actor := machineDemand(ctx, row, requesterID)
	holder := machineQueueHolder(row.ID)
	s.setWorkspaceProvisioningStageBestEffort(ctx, row.ID, workspaceWaitingForMachine)
	granted, err := runtime.WaitAdmission(ctx, *s.machineAdmission, class, holder, actor, workspaceMachineReason)
	if err != nil {
		return ctx, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "machine admission unavailable").WithCause(err)
	}
	s.setWorkspaceProvisioningStageBestEffort(ctx, row.ID, "")
	return granted, nil
}

// MachineHeld counts the bound machine until runtime-confirmed release. A lane
// being provisioned holds its launch reservation before asynchronous boot starts.
func (l *workspaceMythicalLanes) MachineHeld(ctx context.Context, id string) (bool, error) {
	if l == nil || l.workspaces == nil {
		return true, errors.New("machine ownership unavailable")
	}
	runtime, ok := l.workspaces.runtime.(interface{ AdmissionOwnership(string) (bool, bool) })
	if !ok {
		return true, errors.New("machine ownership unavailable")
	}
	row, err := l.workspaces.q.GetWorkspace(ctx, id)
	if err != nil {
		return true, err
	}
	held, known := runtime.AdmissionOwnership(machineQueueHolder(id))
	if held {
		return true, nil
	}
	if !known && row.Status != "stopped" && row.Status != "pending" && row.Status != "starting" {
		return true, errors.New("machine release unconfirmed")
	}
	return false, nil
}

func (l *workspaceMythicalLanes) OrderTodoMachines(items []db.MythicalItem) {
	if l == nil || l.workspaces == nil {
		return
	}
	runtime, ok := l.workspaces.runtime.(interface{ ReorderTodoAdmission([]string) })
	if !ok {
		return
	}
	holders := []string{}
	for _, item := range items {
		if item.Source == "todo" && item.WorkspaceID != "" {
			holders = append(holders, machineQueueHolder(item.WorkspaceID))
		}
	}
	runtime.ReorderTodoAdmission(holders)
}
func (s *MythicalService) orderTodoMachines(items []db.MythicalItem) {
	if lanes, ok := s.lanes.(interface{ OrderTodoMachines([]db.MythicalItem) }); ok {
		lanes.OrderTodoMachines(items)
	}
}

// ReconstructMachineAdmission reads existing durable authorities before the
// install starts workers or serves machine requests. One SQL snapshot preserves
// FIFO ages across jobs and sessions without creating a persistent queue.
func (s *WorkspaceService) ReconstructMachineAdmission(ctx context.Context) error {
	runtime, ok := s.runtime.(interface {
		ReconstructAdmission(context.Context, []microsandbox.AdmissionRequest) error
	})
	if !ok {
		return errors.New("machine admission recovery unavailable")
	}
	if s.transactions == nil {
		return errors.New("machine admission recovery store unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	rows, err := tx.Query(ctx, `
SELECT holder, class, actor, retain_only, todo_state, todo_checks, todo_paused_at, todo_pr_state, todo_attempt, todo_pr_number FROM (
  SELECT 'workspace:' || w.id::text AS holder, 'person'::text AS class,
         'person:' || s.user_id::text || ':session:' || s.id::text AS actor, s.created_at AS age, s.status='running' AS retain_only,
         ''::text AS todo_state, '{}'::jsonb AS todo_checks, NULL::timestamptz AS todo_paused_at, ''::text AS todo_pr_state, 0::integer AS todo_attempt, NULL::bigint AS todo_pr_number
    FROM workspace_sessions s JOIN workspaces w ON w.id=s.workspace_id AND w.repository_id=s.repository_id
    JOIN users u ON u.id=s.user_id
   WHERE s.status IN ('pending','starting','running') AND w.deleted_at IS NULL
     AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL
     AND (EXISTS(SELECT 1 FROM self_host_owners o WHERE o.user_id=u.id AND o.singleton)
       OR EXISTS(SELECT 1 FROM collaborators c WHERE c.repository_id=w.repository_id AND c.user_id=u.id
          AND c.permission IN ('admin','write') AND c.suspended_at IS NULL))
  UNION ALL
  SELECT 'workspace:' || w.id::text, 'todo', 'workspace:' || w.id::text, i.created_at, false, i.state, i.checks, i.paused_at, i.pr_state, i.attempt, i.pr_number
    FROM mythical_items i JOIN mythical_lanes l ON l.item_id=i.id AND l.workspace_id=i.workspace_id AND l.repository_id=i.repository_id
    JOIN workspaces w ON w.id::text=i.workspace_id AND w.repository_id=i.repository_id
   WHERE i.source='todo' AND i.state IN ('queued','running','delivering','integrating','verifying','proposing','waiting','proposed','retrying','blocked')
     AND w.deleted_at IS NULL AND l.retired_at IS NULL
  UNION ALL
  SELECT 'workspace:' || w.id::text, 'background', j.id::text, j.created_at, false, '', '{}'::jsonb, NULL::timestamptz, '', 0, NULL::bigint
    FROM product_job_requests j JOIN workspaces w ON w.name='review-' || j.id::text
   WHERE j.operation='install.review' AND j.state IN ('accepted','dispatching','running','waiting')
     AND NOT j.cancellation_requested AND w.deleted_at IS NULL
     AND w.repository_id::text=j.payload->'admission'->>'repository_id'
     AND w.user_id::text=j.payload->'admission'->>'requester_id'
) demand ORDER BY age, holder, actor`)
	if err != nil {
		return err
	}
	demand := []microsandbox.AdmissionRequest{}
	for rows.Next() {
		row := microsandbox.AdmissionRequest{Reason: workspaceMachineReason}
		var item db.MythicalItem
		if err := rows.Scan(&row.Holder, &row.Class, &row.Actor, &row.RetainOnly, &item.State, &item.Checks, &item.PausedAt, &item.PRState, &item.Attempt, &item.PRNumber); err != nil {
			rows.Close()
			return err
		}
		if row.Class == "todo" {
			// Malformed durable wait evidence is unknown demand, not permission
			// to wake. Refuse before passing any partial snapshot to the runtime.
			var checks mythicalChecks
			if len(item.Checks) != 0 {
				if err := json.Unmarshal(item.Checks, &checks); err != nil {
					rows.Close()
					return fmt.Errorf("machine admission recovery TODO evidence: %w", err)
				}
			}
			// Reuse the person-facing projection: an open answer/conflict wait
			// is retain-only even when the engine still records running. A
			// settled wait may wake again; historical wait evidence must not
			// suppress a queued Retry.
			switch todoState(item) {
			case "paused", "needs_you", "failed":
				row.RetainOnly = true
			case "in_review":
				// Rebuilding an open PR still displays in_review, but its
				// active attempt needs a machine. Settled review does not.
				row.RetainOnly = !mythicalRebuilding(item)
			}
		}
		if row.Class == "background" {
			row.Reason = "review"
		}
		demand = append(demand, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// End the read transaction before runtime I/O; never hold database locks
	// while waiting for an old VM's stop confirmation.
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return runtime.ReconstructAdmission(ctx, demand)
}

// TODO demand exists before a branch machine does. The runtime is the only
// ordered waiting set; this key persists across stack reorder and handoff.
func todoMachineHolder(item db.MythicalItem) string {
	if item.WorkspaceID != "" {
		return machineQueueHolder(item.WorkspaceID)
	}
	return "todo:" + uuidString(item.ID)
}

type todoMachineDemandKey struct{}

func (l *workspaceMythicalLanes) SyncTodoMachines(repositoryID int64, items []db.MythicalItem, limit int, now time.Time) error {
	runtime, ok := l.workspaces.runtime.(interface {
		SyncTodoAdmission(string, []string, int) error
		AdmissionOwnership(string) (bool, bool)
	})
	if !ok {
		return errors.New("ordered TODO admission unavailable")
	}
	holders := []string{}
	for _, item := range items {
		if item.Source != "todo" {
			continue
		}
		holder := todoMachineHolder(item)
		held, _ := runtime.AdmissionOwnership(holder)
		eligible := item.StackPosition.Valid && !item.PausedAt.Valid && len(item.PendingOp) == 0 && (item.State == "queued" || item.State == "retrying") && (!item.NextAttemptAt.Valid || !item.NextAttemptAt.Time.After(now)) && item.Reason != todoDailyLimitReason
		starting := item.WorkspaceID != "" && !item.PausedAt.Valid && mythicalHoldsLane(item)
		if held || eligible || starting {
			holders = append(holders, holder)
		}
	}
	if repositoryID == 0 {
		return nil
	}
	return runtime.SyncTodoAdmission(fmt.Sprintf("repository:%d", repositoryID), holders, limit)
}
func (l *workspaceMythicalLanes) TodoMachineEligible(item db.MythicalItem) bool {
	runtime, ok := l.workspaces.runtime.(interface{ TodoAdmissionEligible(string) bool })
	return ok && runtime.TodoAdmissionEligible(todoMachineHolder(item))
}
func (s *MythicalService) syncTodoMachines(ctx context.Context, repositoryID int64, items []db.MythicalItem) error {
	if !s.installParallelRequired {
		s.orderTodoMachines(items)
		return nil
	}
	limit := 0
	if s.installParallel != nil {
		setting, err := s.installParallel.Parallel(ctx)
		if err != nil {
			return err
		}
		limit = setting.Effective
	}
	lanes, ok := s.lanes.(interface {
		SyncTodoMachines(int64, []db.MythicalItem, int, time.Time) error
	})
	if !ok {
		return errors.New("ordered TODO admission unavailable")
	}
	// The card page is not an authoritative demand cutoff. Read every active
	// item so a Home refresh cannot cancel machines waiting beyond that page.
	active, err := s.queries().ListMythicalItemsInStates(ctx, repositoryID, []string{"queued", "retrying", "running", "delivering", "verifying", "integrating", "proposing", "proposed", "waiting", "blocked"})
	if err != nil {
		return err
	}
	sort.SliceStable(active, func(i, j int) bool { return active[i].StackPosition.Int64 < active[j].StackPosition.Int64 })
	return lanes.SyncTodoMachines(repositoryID, active, limit, s.now())
}

type todoMachinePositionsKey struct{}

func (l *workspaceMythicalLanes) TodoMachinePositions() map[string]int {
	positions := map[string]int{}
	queue, ok := l.workspaces.runtime.(workspaceMachineQueue)
	if !ok {
		return positions
	}
	for _, row := range queue.AdmissionSnapshot() {
		if row.State != "waiting" || row.Position < 1 {
			continue
		}
		positions[row.Holder] = row.Position
		for _, alias := range row.Aliases {
			positions[alias] = row.Position
		}
	}
	return positions
}

// One Home/card fact reads the waiting order once, so every position in that
// projection reflects the same person promotions, cancellations and TODO order.
func (s *MythicalService) todoMachineProjection(ctx context.Context, repositoryID int64, items []db.MythicalItem) context.Context {
	if _, ok := ctx.Value(todoMachinePositionsKey{}).(map[string]int); ok {
		return ctx
	}
	if err := s.syncTodoMachines(ctx, repositoryID, items); err != nil && s.installParallelRequired {
		s.logger.Warn("mythical.todo_projection_demand_failed", "error", err)
	}
	if !s.installParallelRequired {
		return ctx
	}
	if lanes, ok := s.lanes.(interface{ TodoMachinePositions() map[string]int }); ok {
		return context.WithValue(ctx, todoMachinePositionsKey{}, lanes.TodoMachinePositions())
	}
	return context.WithValue(ctx, todoMachinePositionsKey{}, map[string]int{})
}
func (s *MythicalService) machineProjectionPlace(ctx context.Context, holder string) (int, bool) {
	if positions, ok := ctx.Value(todoMachinePositionsKey{}).(map[string]int); ok {
		place, waiting := positions[holder]
		return place, waiting
	}
	return 0, false
}

func (l *workspaceMythicalLanes) MachineOwnershipChanges() <-chan struct{} {
	if runtime, ok := l.workspaces.runtime.(interface{ AdmissionOwnershipChanges() <-chan struct{} }); ok {
		return runtime.AdmissionOwnershipChanges()
	}
	return nil
}
