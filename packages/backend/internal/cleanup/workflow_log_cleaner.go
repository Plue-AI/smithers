package cleanup

import (
	"context"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// WorkflowLogCleanupStore deletes expired workflow output in bounded batches.
type WorkflowLogCleanupStore interface {
	DeleteWorkflowLogsOlderThan(context.Context, db.DeleteWorkflowLogsOlderThanParams) (int64, error)
	DeleteWorkflowRunLogsOlderThan(context.Context, db.DeleteWorkflowRunLogsOlderThanParams) (int64, error)
}

// WorkflowLogCleaner retains workflow output for 30 days after completion. Each sweep has a
// fixed cutoff and deadline, so new output cannot extend it indefinitely.
type WorkflowLogCleaner struct {
	periodicRunner
	store WorkflowLogCleanupStore
}

func NewWorkflowLogCleaner(store WorkflowLogCleanupStore) *WorkflowLogCleaner {
	c := &WorkflowLogCleaner{store: store}
	c.init("workflow_log", time.Hour, time.Hour)
	c.initialSweep = true
	return c
}

func (c *WorkflowLogCleaner) Start(ctx context.Context) { c.start(ctx, c.sweep) }

func (c *WorkflowLogCleaner) sweep(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := db.DeleteWorkflowLogsOlderThanParams{Cutoff: time.Now().UTC().Add(-30 * 24 * time.Hour), BatchLimit: 1000}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		select {
		case <-c.stopCh:
			return nil
		default:
		}
		deleted, err := c.store.DeleteWorkflowLogsOlderThan(ctx, args)
		if err != nil {
			return err
		}
		runDeleted, err := c.store.DeleteWorkflowRunLogsOlderThan(ctx, db.DeleteWorkflowRunLogsOlderThanParams(args))
		if err != nil {
			return err
		}
		if deleted == 0 && runDeleted == 0 {
			return nil
		}
	}
}
