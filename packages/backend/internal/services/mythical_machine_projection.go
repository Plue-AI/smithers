package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

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
			key, _ := json.Marshal(positions.TodoMachinePositions())
			if string(key) == previous {
				continue
			}
			if err := s.publishMachineQueueProjection(ctx); err != nil {
				if ctx.Err() == nil {
					s.logger.Warn("mythical.machine_projection_failed", "error", err)
				}
				continue
			}
			previous = string(key)
		}
	}
}

func (s *MythicalService) publishMachineQueueProjection(ctx context.Context) error {
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
