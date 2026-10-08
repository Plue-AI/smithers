package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

var errMachineProjectionBusy = errors.New("machine projection source busy")

// StartMachineQueueProjection publishes runtime-only queue changes through the
// existing committed TODO/Home fact writer. The runtime remains the sole queue;
// persisted card facts only deduplicate projection updates after a restart.
func (s *MythicalService) StartMachineQueueProjection(ctx context.Context) {
	positions, ok := s.lanes.(interface{ TodoMachinePositions() map[string]int })
	if !ok || !s.installParallelRequired {
		return
	}
	previous := ""
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.publishScratchMachineProjection(ctx); err != nil {
				s.logger.Warn("mythical.scratch_machine_projection_failed", "error", err)
			}
			key, _ := json.Marshal(positions.TodoMachinePositions())
			if string(key) == previous {
				continue
			}
			if err := s.publishMachineQueueProjection(ctx); err != nil {
				if ctx.Err() == nil && !errors.Is(err, errMachineProjectionBusy) {
					s.logger.Warn("mythical.machine_projection_failed", "error", err)
				}
				continue
			}
			previous = string(key)
		}
	}
}

func (s *MythicalService) publishMachineQueueProjection(ctx context.Context) (retErr error) {
	defer func() {
		var locked *pgconn.PgError
		if errors.As(retErr, &locked) && locked.Code == "55P03" {
			retErr = errMachineProjectionBusy
		}
	}()
	if !s.installParallelRequired {
		return nil
	}
	if s.installParallel == nil {
		return errors.New("install parallel provider unavailable")
	}
	binding, err := s.queries().GetInstallSetting(ctx, "github.repository")
	if err != nil {
		return err
	}
	var installed struct {
		RepositoryID int64 `json:"repository_id"`
	}
	if err := json.Unmarshal(binding.Value, &installed); err != nil {
		return err
	}
	if installed.RepositoryID <= 0 {
		return nil
	}
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// Source commands may already hold an item stream before writing its Home
	// fact. Yield instead of waiting with the repository stream locked.
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '100ms'"); err != nil {
		return err
	}
	// Serialize with the existing repository projection writer before reading
	// cards. Never lock source items: a control may hold one while waiting here.
	if _, err := tx.Exec(ctx, `INSERT INTO product_job_streams(tenant_id,principal_id,head) VALUES($1,'repository:todos',0) ON CONFLICT DO NOTHING`, strconv.FormatInt(installed.RepositoryID, 10)); err != nil {
		return err
	}
	var head int64
	if err := tx.QueryRow(ctx, `SELECT head FROM product_job_streams WHERE tenant_id=$1 AND principal_id='repository:todos' FOR UPDATE`, strconv.FormatInt(installed.RepositoryID, 10)).Scan(&head); err != nil {
		return err
	}
	view := *s
	view.store = tx
	items, err := db.New(tx).ListMythicalItemsInStates(ctx, installed.RepositoryID, []string{"queued", "retrying", "running", "delivering", "verifying", "integrating", "proposing", "proposed", "waiting", "blocked"})
	if err != nil {
		return err
	}
	if err := view.syncTodoMachines(ctx, installed.RepositoryID, items); err != nil {
		return err
	}
	positions, ok := view.lanes.(interface{ TodoMachinePositions() map[string]int })
	if !ok {
		return errors.New("machine queue projection unavailable")
	}
	ctx = context.WithValue(ctx, todoMachinePositionsKey{}, positions.TodoMachinePositions())
	sort.SliceStable(items, func(i, j int) bool { return items[i].StackPosition.Int64 < items[j].StackPosition.Int64 })
	ctx = context.WithValue(ctx, todoFactItemsKey{}, items)
	for _, item := range items {
		card, err := view.todoCard(ctx, item, items)
		if err != nil {
			return err
		}
		queue, err := json.Marshal(card["queue"])
		if err != nil {
			return err
		}
		scope := todoOperationScope(item)
		var same bool
		if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT COALESCE(data->'card'->'queue','null'::jsonb) = $3::jsonb FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND data ? 'card' ORDER BY sequence DESC LIMIT 1), $3::jsonb = 'null'::jsonb)`, scope.TenantID, scope.PrincipalID, queue).Scan(&same); err != nil {
			return err
		}
		if same {
			continue
		}
		if ctx.Value(todoHomeFactKey{}) == nil {
			projection, err := view.todoHomeFact(ctx, installed.RepositoryID)
			if err != nil {
				return err
			}
			ctx = context.WithValue(ctx, todoHomeFactKey{}, projection)
		}
		if _, err := view.recordTodoFact(ctx, tx, item, uuid.NewString(), "todo.machine.queue", card["state"].(string), json.RawMessage(`{}`)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Scratch machines have no TODO stream. Publish their machine observations into
// the existing source journal, independently of subscribers and TODO changes.
// These are projection facts, never admission authority or a persisted queue.
func (s *MythicalService) publishScratchMachineProjection(ctx context.Context) error {
	positions, ok := s.lanes.(interface{ TodoMachinePositions() map[string]int })
	if !ok {
		return nil
	}
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, "SET LOCAL lock_timeout = '100ms'"); err != nil {
		return err
	}
	// Serialize readers before taking the runtime snapshot, including after a
	// projector restart. A second worker cannot append an older observation.
	var locked bool
	if err = tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock(hashtextextended('scratch-machine-projection',0))").Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT w.id::text FROM workspaces w
 WHERE w.deleted_at IS NULL AND w.target_bookmark LIKE 'scratch/%'
 AND NOT EXISTS(SELECT 1 FROM mythical_lanes l WHERE l.workspace_id=w.id::text)
 ORDER BY w.id`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	places := positions.TodoMachinePositions()
	for _, id := range ids {
		row, err := db.New(tx).GetWorkspace(ctx, id)
		if err != nil {
			return err
		}
		machine := map[string]any{"state": branchMachineState(row)}
		if position := places[machineQueueHolder(id)]; position > 0 {
			machine = map[string]any{"state": "waiting", "position": position}
		}
		data, err := json.Marshal(map[string]any{"branch": map[string]any{"id": id, "machine": machine}})
		if err != nil {
			return err
		}
		scope := jobs.Scope{TenantID: strconv.FormatInt(row.RepositoryID, 10), PrincipalID: "branch:" + id + ":machine"}
		var same bool
		err = tx.QueryRow(ctx, `SELECT data=$3::jsonb FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 ORDER BY sequence DESC LIMIT 1`, scope.TenantID, scope.PrincipalID, data).Scan(&same)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if same {
			continue
		}
		if _, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "branch.machine", "observed", data); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
